// Punkt 17 (21.11.2026): the platform-neutral core of the Autark runner (protocol v1, PROTOKOLL-RUNNER.md) – frames and their
// limits, the two-sided proof (vectors computed with tools/runner-probe.py's Python HMAC), every request's checks, the tree's flat
// list, the front-app search, the lock decision, the swipe line and the reference glide, and the connection state machine with its clock. Linux too.
import XCTest
@testable import AutarkCore

private func bytes(_ range: Range<Int>) -> Bytes { range.map { UInt8($0) } }

/// Every frame the actions send, decoded (the preamble is skipped).
private func sent(_ actions: [RunnerSession.Action]) -> [(json: JSONObject, binary: Bytes)] {
    var reader = RunnerFrameReader(jsonMax: RunnerWire.answerJsonMax, binMax: RunnerWire.answerBinMax)
    var out = [(json: JSONObject, binary: Bytes)]()
    for action in actions {
        guard case .send(let data) = action, data != RunnerWire.preamble else { continue }
        reader.push(data)
        while let frame = try! reader.next() { out.append(frame) }
    }
    return out
}

private func closes(_ actions: [RunnerSession.Action]) -> Bool { actions.contains { if case .close = $0 { return true } else { return false } } }

private func code(_ json: JSONObject) -> String? { (json["error"] as? JSONObject)?["code"] as? String }

private func request(_ json: JSONObject) -> Bytes { RunnerWire.frame(json) }

final class RunnerWireTests: XCTestCase {
    func testPreambleAndFrameAreTheBytesOfThePythonReference() {
        XCTAssertEqual(RunnerWire.preamble, [0x41, 0x54, 0x4B, 0x52, 0x55, 0x4E, 0x31, 0x0A])
        // struct.pack(">II", 18, 3) + b'{"id":7,"ok":true}' + b"abc"
        XCTAssertEqual(Crypto.hex(RunnerWire.frame(["ok": true, "id": 7], Array("abc".utf8))), "00000012000000037b226964223a372c226f6b223a747275657d616263")
    }

    func testProofsMatchThePythonReference() {
        let token = bytes(0..<32), pc = bytes(16..<32), runner = bytes(32..<48)
        XCTAssertEqual(RunnerWire.proof(token: token, label: RunnerWire.runnerLabel, pcNonce: pc, runnerNonce: runner),
                       "b0b5ea4ab9f6726c24dce8128ecc9cd1b9ff9801852c71e46f4d278c06d41aa4")
        XCTAssertEqual(RunnerWire.proof(token: token, label: RunnerWire.pcLabel, pcNonce: pc, runnerNonce: runner),
                       "315931dd0f5d7ef040e3df2999e6e283f3540b1a3bf2a75ea856b24ae929b68d")
    }

    func testReaderTakesFramesInPiecesAndGlued() throws {
        let one = RunnerWire.frame(["id": 1, "op": "ping"]), two = RunnerWire.frame(["id": 2, "op": "state", "x": "Grüße 👋"])
        var reader = RunnerFrameReader(jsonMax: RunnerWire.requestJsonMax, binMax: 0)
        for byte in one.dropLast() {
            reader.push([byte])
            XCTAssertNil(try reader.next())
        }
        reader.push([one.last!] + two)
        XCTAssertEqual(try reader.next()?.json["op"] as? String, "ping")
        let second = try reader.next()
        XCTAssertEqual(second?.json["x"] as? String, "Grüße 👋")
        XCTAssertNil(try reader.next())
        XCTAssertEqual(reader.buffered, 0)
    }

    func testReaderRefusesFramesOutsideTheLimits() {
        func fails(_ data: Bytes, binMax: Int = 0) -> Bool {
            var reader = RunnerFrameReader(jsonMax: RunnerWire.requestJsonMax, binMax: binMax)
            reader.push(data)
            return (try? reader.next()) == nil
        }
        XCTAssertTrue(fails(RunnerWire.u32(0) + RunnerWire.u32(0)), "jsonLen 0")
        XCTAssertTrue(fails(RunnerWire.u32(RunnerWire.requestJsonMax + 1) + RunnerWire.u32(0)), "request over 256 KiB")
        XCTAssertTrue(fails(RunnerWire.frame(["id": 1], [1])), "a request carries no binary")
        XCTAssertTrue(fails(RunnerWire.u32(2) + RunnerWire.u32(0) + Array("[]".utf8)), "not an object")
        XCTAssertTrue(fails(RunnerWire.u32(2) + RunnerWire.u32(0) + [0xff, 0xfe]), "not UTF-8")
    }

    func testEnvironment() {
        let token = String(repeating: "ab", count: 32)
        XCTAssertEqual(RunnerWire.token(token)?.count, 32)
        XCTAssertEqual(RunnerWire.token(token.uppercased())?.count, 32)
        XCTAssertNil(RunnerWire.token(String(token.dropLast())))
        XCTAssertNil(RunnerWire.token(String(repeating: "zz", count: 32)))
        XCTAssertNil(RunnerWire.token(nil))
        XCTAssertEqual(RunnerWire.port("51873"), 51873)
        XCTAssertNil(RunnerWire.port("8100"))
        XCTAssertNil(RunnerWire.port("65536"))
        XCTAssertNil(RunnerWire.port(nil))
        XCTAssertEqual(RunnerWire.idleSeconds(nil), 300)
        XCTAssertEqual(RunnerWire.idleSeconds("5"), 30)
        XCTAssertEqual(RunnerWire.idleSeconds("99999"), 3600)
        XCTAssertEqual(RunnerWire.idleSeconds("45"), 45)
    }

    func testTimeLimits() {
        XCTAssertEqual(RunnerWire.limitMs(.state), 5000)
        XCTAssertEqual(RunnerWire.limitMs(.tree(bundle: nil, maxNodes: 1, maxDepth: 1, all: false)), 20_000)
        XCTAssertEqual(RunnerWire.limitMs(.tap(x: 1, y: 1, count: 1, holdMs: 800)), 5800)
        XCTAssertEqual(RunnerWire.limitMs(.swipe([RunnerPoint(x: 0, y: 0, t: 0), RunnerPoint(x: 1, y: 1, t: 300)])), 5300)
        XCTAssertEqual(RunnerWire.limitMs(.text("a")), 30_000)
    }
}

final class RunnerRequestTests: XCTestCase {
    private let all: Set<String> = ["path", "jpeg", "open.url", "button.volume", "button.action", "button.camera"]

    private func parse(_ json: JSONObject, caps: Set<String>? = nil) -> Result<RunnerRequest, RunnerFailure> {
        RunnerRequest.parse(json, caps: caps ?? all)
    }

    private func failure(_ json: JSONObject, caps: Set<String>? = nil) -> RunnerCode? {
        if case .failure(let f) = parse(json, caps: caps) { return f.code }
        return nil
    }

    private func op(_ json: JSONObject, caps: Set<String>? = nil) -> RunnerOp? {
        if case .success(.op(let op)) = parse(json, caps: caps) { return op }
        return nil
    }

    func testIds() {
        XCTAssertEqual(RunnerRequest.id(["id": 1.0]), 1)
        XCTAssertEqual(RunnerRequest.id(["id": 2_147_483_647.0]), 2_147_483_647)
        XCTAssertNil(RunnerRequest.id(["id": 0.0]))
        XCTAssertNil(RunnerRequest.id(["id": 1.5]))
        XCTAssertNil(RunnerRequest.id(["id": "1"]))
        XCTAssertNil(RunnerRequest.id([:]))
    }

    func testHelloAndAuth() {
        let nonce = String(repeating: "0f", count: 16)
        XCTAssertEqual(try parse(["op": "hello", "v": 1.0, "nonce": nonce]).get(), .hello(v: 1, nonce: Bytes(repeating: 0x0f, count: 16)))
        XCTAssertEqual(try parse(["op": "hello", "v": 3.0, "nonce": nonce]).get(), .hello(v: 1, nonce: Bytes(repeating: 0x0f, count: 16)), "a newer PC gets version 1")
        if case .failure(let f) = parse(["op": "hello", "v": 0.0, "nonce": nonce]) {
            XCTAssertEqual(f.code, .unsupportedVersion)
            XCTAssertEqual(f.detail?["supported"] as? [Int], [1])
        } else { XCTFail("v 0") }
        XCTAssertEqual(failure(["op": "hello", "v": 1.0, "nonce": "abcd"]), .badRequest)
        XCTAssertEqual(failure(["op": "hello", "nonce": nonce]), .badRequest)
        let proof = String(repeating: "aa", count: 32)
        XCTAssertEqual(try parse(["op": "auth", "proof": proof, "apps": ["com.apple.Preferences", "net.whatsapp.WhatsApp"]]).get(),
                       .auth(proof: Bytes(repeating: 0xaa, count: 32), apps: ["com.apple.Preferences", "net.whatsapp.WhatsApp"]))
        XCTAssertEqual(failure(["op": "auth", "proof": proof, "apps": ["no spaces allowed"]]), .badRequest)
        XCTAssertEqual(failure(["op": "auth", "proof": proof, "apps": Array(repeating: "a.b", count: 801)]), .badRequest)
        XCTAssertEqual(failure(["op": "auth", "proof": "aa"]), .badRequest)
    }

    func testScreenshot() {
        XCTAssertEqual(op(["op": "screenshot"]), .screenshot(format: "png", quality: 0.7, maxEdge: nil))
        XCTAssertEqual(op(["op": "screenshot", "format": "jpeg", "quality": 0.5, "maxEdge": 800.0]), .screenshot(format: "jpeg", quality: 0.5, maxEdge: 800))
        XCTAssertEqual(op(["op": "screenshot", "format": "png", "maxEdge": 800.0]), .screenshot(format: "png", quality: 0.7, maxEdge: nil), "PNG comes in full size")
        XCTAssertEqual(failure(["op": "screenshot", "format": "jpeg"], caps: []), .unsupported)
        XCTAssertEqual(failure(["op": "screenshot", "format": "gif"]), .badRequest)
        XCTAssertEqual(failure(["op": "screenshot", "format": "jpeg", "quality": 0.05]), .badRequest)
        XCTAssertEqual(failure(["op": "screenshot", "format": "jpeg", "maxEdge": 100.0]), .badRequest)
    }

    func testTree() {
        XCTAssertEqual(op(["op": "tree"]), .tree(bundle: nil, maxNodes: 1500, maxDepth: 40, all: false))
        XCTAssertEqual(op(["op": "tree", "bundle": "com.apple.Preferences", "maxNodes": 3000.0, "maxDepth": 60.0, "all": true]),
                       .tree(bundle: "com.apple.Preferences", maxNodes: 3000, maxDepth: 60, all: true))
        XCTAssertEqual(failure(["op": "tree", "maxNodes": 3001.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tree", "maxDepth": 0.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tree", "all": 1.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tree", "bundle": "com/apple"]), .badRequest)
    }

    func testTap() {
        XCTAssertEqual(op(["op": "tap", "x": 195.0, "y": 344.5]), .tap(x: 195, y: 344.5, count: 1, holdMs: 0))
        XCTAssertEqual(op(["op": "tap", "x": 1.0, "y": 2.0, "count": 2.0]), .tap(x: 1, y: 2, count: 2, holdMs: 0))
        XCTAssertEqual(op(["op": "tap", "x": 1.0, "y": 2.0, "holdMs": 800.0]), .tap(x: 1, y: 2, count: 1, holdMs: 800))
        XCTAssertEqual(failure(["op": "tap", "x": 1.0, "y": 2.0, "count": 2.0, "holdMs": 800.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tap", "x": 1.0, "y": 2.0, "count": 3.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tap", "x": 1.0, "y": 2.0, "holdMs": 5001.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tap", "x": "1", "y": 2.0]), .badRequest)
        XCTAssertEqual(failure(["op": "tap", "y": 2.0]), .badRequest)
    }

    func testSwipe() {
        let ok: [Any] = [["x": 10.0, "y": 600.0, "t": 0.0], ["x": 10.0, "y": 300.0, "t": 300.0]]
        XCTAssertEqual(op(["op": "swipe", "points": ok]), .swipe([RunnerPoint(x: 10, y: 600, t: 0), RunnerPoint(x: 10, y: 300, t: 300)]))
        XCTAssertEqual(failure(["op": "swipe", "points": [["x": 1.0, "y": 1.0, "t": 0.0]]]), .badRequest, "one point")
        XCTAssertEqual(failure(["op": "swipe", "points": [["x": 1.0, "y": 1.0, "t": 5.0], ["x": 2.0, "y": 2.0, "t": 9.0]]]), .badRequest, "first t not 0")
        XCTAssertEqual(failure(["op": "swipe", "points": [["x": 1.0, "y": 1.0, "t": 0.0], ["x": 2.0, "y": 2.0, "t": 0.0]]]), .badRequest, "t not rising")
        XCTAssertEqual(failure(["op": "swipe", "points": [["x": 1.0, "y": 1.0, "t": 0.0], ["x": 2.0, "y": 2.0, "t": 10_001.0]]]), .badRequest, "too long")
        let many: [Any] = (0..<33).map { ["x": 1.0, "y": 1.0, "t": Double($0)] }
        XCTAssertEqual(failure(["op": "swipe", "points": many]), .badRequest, "33 points")
        XCTAssertEqual(failure(["op": "swipe", "points": [["x": 1.0, "t": 0.0], ["x": 2.0, "y": 2.0, "t": 9.0]]]), .badRequest, "point without y")
    }

    func testText() {
        XCTAssertEqual(op(["op": "text", "text": "Grüße 👋\n"]), .text("Grüße 👋\n"))
        XCTAssertEqual(op(["op": "text", "text": String(repeating: "a", count: 400)]), .text(String(repeating: "a", count: 400)))
        XCTAssertEqual(failure(["op": "text", "text": String(repeating: "a", count: 401)]), .badRequest)
        XCTAssertEqual(failure(["op": "text", "text": String(repeating: "👋", count: 401)]), .badRequest, "counted in Unicode scalars")
        XCTAssertEqual(failure(["op": "text", "text": ""]), .badRequest)
    }

    func testButtons() {
        XCTAssertEqual(op(["op": "button", "name": "home"], caps: []), .button("home"))
        XCTAssertEqual(op(["op": "button", "name": "volume_up"]), .button("volume_up"))
        XCTAssertEqual(failure(["op": "button", "name": "volume_down"], caps: ["button.action"]), .unsupported)
        XCTAssertEqual(op(["op": "button", "name": "action"], caps: ["button.action"]), .button("action"))
        XCTAssertEqual(failure(["op": "button", "name": "camera"], caps: ["button.action"]), .unsupported)
        XCTAssertEqual(failure(["op": "button", "name": "lock"]), .badRequest, "no lock in version 1")
    }

    func testOpen() {
        XCTAssertEqual(op(["op": "open", "url": "https://example.com/a?b=c"]), .openURL("https://example.com/a?b=c"))
        XCTAssertEqual(op(["op": "open", "url": "HTTP://example.com"]), .openURL("HTTP://example.com"))
        XCTAssertEqual(op(["op": "open", "bundle": "com.apple.Preferences"]), .openBundle("com.apple.Preferences"))
        XCTAssertEqual(failure(["op": "open", "url": "tel:112"]), .badRequest)
        XCTAssertEqual(failure(["op": "open", "url": "sms:+43"]), .badRequest)
        XCTAssertEqual(failure(["op": "open", "url": "autark://pair"]), .badRequest)
        XCTAssertEqual(failure(["op": "open", "url": "https://" + String(repeating: "a", count: 2048)]), .badRequest)
        XCTAssertEqual(failure(["op": "open", "url": "https://example.com"], caps: []), .unsupported)
        XCTAssertEqual(failure(["op": "open", "url": "https://example.com", "bundle": "com.apple.Preferences"]), .badRequest)
        XCTAssertEqual(failure(["op": "open"]), .badRequest)
        XCTAssertEqual(failure(["op": "open", "bundle": "com.apple.Preferences; rm"]), .badRequest)
    }

    func testUnknownAndUnknownFields() {
        XCTAssertEqual(failure(["op": "frobnicate"]), .unknownOp)
        XCTAssertEqual(failure(["id": 1.0]), .badRequest)
        XCTAssertEqual(op(["op": "state", "later": "ignored"]), .state)
    }

    func testAnswerFramesAndTooLarge() throws {
        var reader = RunnerFrameReader(jsonMax: RunnerWire.answerJsonMax, binMax: RunnerWire.answerBinMax)
        reader.push(RunnerAnswer.done(["format": "png"], binary: [1, 2, 3]).frame(id: 4))
        let frame = try reader.next()!
        XCTAssertEqual(frame.json["id"] as? Double, 4)
        XCTAssertEqual(frame.json["ok"] as? Bool, true)
        XCTAssertEqual(frame.binary, [1, 2, 3])
        reader.push(RunnerAnswer.done(["big": String(repeating: "x", count: RunnerWire.answerJsonMax)]).frame(id: 5))
        XCTAssertEqual(code(try reader.next()!.json), "too_large")
        reader.push(RunnerAnswer.fail(.locked, "The iPhone is locked.").frame(id: 6))
        let locked = try reader.next()!.json
        XCTAssertEqual(locked["ok"] as? Bool, false)
        XCTAssertEqual(code(locked), "locked")
        XCTAssertEqual(RunnerCode.allCases.count, 19)
        XCTAssertTrue(RunnerCode.authFailed.closes && RunnerCode.unauthorized.closes && RunnerCode.unsupportedVersion.closes && !RunnerCode.busy.closes)
    }

    func testScreen() {
        let portrait = RunnerScreen.from(nativeWidth: 1206, nativeHeight: 2622, scale: 3, orientation: "portrait")
        XCTAssertEqual(portrait, RunnerScreen(width: 402, height: 874, scale: 3, orientation: "portrait"))
        XCTAssertEqual(RunnerScreen.from(nativeWidth: 1206, nativeHeight: 2622, scale: 3, orientation: "landscape_left").width, 874)
        XCTAssertTrue(portrait.contains(x: 0, y: 0))
        XCTAssertFalse(portrait.contains(x: 402, y: 10))
        XCTAssertFalse(portrait.contains(x: -0.1, y: 10))
        XCTAssertEqual(Json.write(portrait.json), "{\"height\":874,\"orientation\":\"portrait\",\"scale\":3,\"width\":402}")
        XCTAssertEqual(RunnerScreen.round1(344.46), 344.5)
    }
}

final class RunnerTreeTests: XCTestCase {
    private let screen = RunnerScreen(width: 402, height: 874, scale: 3, orientation: "portrait")

    private func settings() -> RunnerElement {
        RunnerElement(type: "Application", label: "Settings", frame: RunnerRect(x: 0, y: 0, width: 402, height: 874), children: [
            RunnerElement(type: "NavigationBar", identifier: "Settings", frame: RunnerRect(x: 0, y: 54, width: 402, height: 96), children: [
                RunnerElement(type: "StaticText", label: "Settings", frame: RunnerRect(x: 16, y: 100, width: 120, height: 40)),
            ]),
            RunnerElement(type: "Cell", label: "General", identifier: "com.apple.settings.general", frame: RunnerRect(x: 16, y: 315.04, width: 370, height: 52)),
            RunnerElement(type: "Switch", label: "Wi-Fi", value: "1", frame: RunnerRect(x: 330, y: 400, width: 51, height: 31), enabled: false),
            RunnerElement(type: "Cell", label: "Far below", frame: RunnerRect(x: 16, y: 2000, width: 370, height: 52), children: [
                RunnerElement(type: "StaticText", label: "child of far"),
            ]),
            RunnerElement(type: "SecureTextField", label: "Password", value: "hunter2", placeholder: "Required", frame: RunnerRect(x: 16, y: 500, width: 370, height: 44), focused: true),
        ])
    }

    func testFlatListInDocumentOrderWithParentsAndDepth() {
        let result = RunnerTree.flatten(roots: [(settings(), "com.apple.Preferences")], screen: screen, maxNodes: 1500, maxDepth: 40, all: false)
        XCTAssertFalse(result.truncated)
        XCTAssertEqual(result.nodes.map { $0["i"] as? Int }, [0, 1, 2, 3, 4, 5])
        XCTAssertEqual(result.nodes.map { $0["p"] as? Int }, [-1, 0, 1, 0, 0, 0])
        XCTAssertEqual(result.nodes.map { $0["d"] as? Int }, [0, 1, 2, 1, 1, 1])
        XCTAssertEqual(result.nodes.map { $0["type"] as? String }, ["Application", "NavigationBar", "StaticText", "Cell", "Switch", "SecureTextField"])
        XCTAssertEqual(result.nodes[0]["app"] as? String, "com.apple.Preferences")
        XCTAssertNil(result.nodes[1]["app"])
        XCTAssertEqual(result.nodes[3]["frame"] as? [Double], [16, 315, 370, 52])
        XCTAssertEqual(result.nodes[3]["id"] as? String, "com.apple.settings.general")
        XCTAssertEqual(result.nodes[4]["value"] as? String, "1")
        XCTAssertEqual(result.nodes[4]["enabled"] as? Bool, false)
        XCTAssertNil(result.nodes[3]["enabled"], "enabled only when false")
        XCTAssertNil(result.nodes[1]["title"])
    }

    func testPasswordFieldNeverCarriesItsValue() {
        let result = RunnerTree.flatten(roots: [(settings(), "com.apple.Preferences")], screen: screen, maxNodes: 1500, maxDepth: 40, all: false)
        let field = result.nodes[5]
        XCTAssertEqual(field["secure"] as? Bool, true)
        XCTAssertNil(field["value"])
        XCTAssertEqual(field["placeholder"] as? String, "Required")
        XCTAssertEqual(field["focused"] as? Bool, true)
        XCTAssertFalse(Json.write(RunnerTree.answer(front: "com.apple.Preferences", screen: screen, result: result)).contains("hunter2"))
    }

    func testOffScreenNodesOnlyWithAll() {
        let all = RunnerTree.flatten(roots: [(settings(), "com.apple.Preferences")], screen: screen, maxNodes: 1500, maxDepth: 40, all: true)
        XCTAssertEqual(all.nodes.count, 8)
        XCTAssertEqual(all.nodes[5]["label"] as? String, "Far below")
        XCTAssertEqual(all.nodes[6]["p"] as? Int, 5)
        XCTAssertFalse(all.truncated)
    }

    func testLimitsTruncate() {
        let few = RunnerTree.flatten(roots: [(settings(), "com.apple.Preferences")], screen: screen, maxNodes: 3, maxDepth: 40, all: false)
        XCTAssertEqual(few.nodes.count, 3)
        XCTAssertTrue(few.truncated)
        let shallow = RunnerTree.flatten(roots: [(settings(), "com.apple.Preferences")], screen: screen, maxNodes: 1500, maxDepth: 1, all: false)
        XCTAssertEqual(shallow.nodes.map { $0["d"] as? Int }, [0, 1, 1, 1, 1])
        XCTAssertTrue(shallow.truncated)
    }

    func testSecondRootForASystemDialog() {
        let alert = RunnerElement(type: "Alert", label: "Allow “Autark” to use your location?", frame: RunnerRect(x: 60, y: 300, width: 282, height: 200), children: [
            RunnerElement(type: "Button", label: "Allow Once", frame: RunnerRect(x: 60, y: 420, width: 282, height: 40)),
        ])
        let result = RunnerTree.flatten(roots: [(settings(), "com.apple.Preferences"), (alert, RunnerTree.springboard), (alert, "third.is.dropped")],
                                        screen: screen, maxNodes: 1500, maxDepth: 40, all: false)
        XCTAssertEqual(result.nodes.count, 8)
        XCTAssertEqual(result.nodes[6]["p"] as? Int, -1)
        XCTAssertEqual(result.nodes[6]["d"] as? Int, 0)
        XCTAssertEqual(result.nodes[6]["app"] as? String, RunnerTree.springboard)
        XCTAssertEqual(result.nodes[7]["p"] as? Int, 6)
        XCTAssertEqual(result.nodes.filter { $0["p"] as? Int == -1 }.count, 2)
    }

    func testLongTextsAreCutWithAnEllipsis() {
        let long = String(repeating: "ä", count: 400)
        let node = RunnerTree.node(RunnerElement(type: "StaticText", label: long, identifier: String(repeating: "i", count: 250), title: "Other title"),
                                   index: 0, parent: -1, depth: 0, app: nil)
        let label = node["label"] as! String
        XCTAssertEqual(label.count, 300)
        XCTAssertTrue(label.hasSuffix("…"))
        XCTAssertEqual((node["id"] as! String).count, 200)
        XCTAssertEqual(node["title"] as? String, "Other title")
        XCTAssertNil(node["frame"])
    }

    func testTypeNamesFollowTheProtocolTable() {
        XCTAssertEqual(RunnerTree.typeNames.count, 83)
        XCTAssertEqual(RunnerTree.typeName(raw: 2), "Application")
        XCTAssertEqual(RunnerTree.typeName(raw: 9), "Button")
        XCTAssertEqual(RunnerTree.typeName(raw: 40), "Switch")
        XCTAssertEqual(RunnerTree.typeName(raw: 48), "StaticText")
        XCTAssertEqual(RunnerTree.typeName(raw: 50), "SecureTextField")
        XCTAssertEqual(RunnerTree.typeName(raw: 75), "Cell")
        XCTAssertEqual(RunnerTree.typeName(raw: 82), "StatusItem")
        XCTAssertEqual(RunnerTree.typeName(raw: 83), "Other")
        XCTAssertEqual(RunnerTree.typeName(raw: -1), "Other")
    }

    func testAnswerAndValues() {
        let answer = RunnerTree.answer(front: nil, screen: screen, result: RunnerTree.Result(nodes: [], truncated: false))
        XCTAssertTrue(Json.write(answer).contains("\"front\":null"))
        XCTAssertEqual(RunnerTree.valueText(true), "1")
        XCTAssertEqual(RunnerTree.valueText(0.5), "0.5")
        XCTAssertEqual(RunnerTree.valueText(3.0), "3")
        XCTAssertEqual(RunnerTree.valueText(nil), "")
        XCTAssertEqual(RunnerTree.valueText("50%"), "50%")
    }
}

final class RunnerFrontTests: XCTestCase {
    func testKnownAppsFirstThenTheListWithinTheBudget() {
        var front = RunnerFront()
        front.installed = ["a.one", "a.two", "a.three"]
        var asked = [String]()
        XCTAssertEqual(front.find(isForeground: { asked.append($0); return $0 == "a.two" }, budget: { true }), "a.two")
        XCTAssertEqual(asked, ["a.one", "a.two"])
        asked = []
        XCTAssertEqual(front.find(isForeground: { asked.append($0); return $0 == "a.two" }, budget: { true }), "a.two")
        XCTAssertEqual(asked, ["a.two"], "the app seen last is asked first")
        front.didOpen("com.apple.Preferences")
        asked = []
        var left = 1
        XCTAssertNil(front.find(isForeground: { asked.append($0); return false }, budget: { left -= 1; return left >= 0 }))
        XCTAssertEqual(asked, ["com.apple.Preferences", "a.one"], "the opened app always, the list only within the budget; a.two went behind it")
        XCTAssertEqual(front.left, ["a.two"])
    }

    func testNothingKnownIsNil() {
        var front = RunnerFront()
        XCTAssertNil(front.find(isForeground: { _ in false }, budget: { true }))
        front.installed = ["a.one"]
        XCTAssertNil(front.find(isForeground: { _ in false }, budget: { true }), "the whole list asked, none in front: not known")
    }

    /// CI run 44951831619: after the home button Settings still said runningForeground. The home screen comes from our own action.
    func testHomeButtonWinsOverAStaleState() {
        var front = RunnerFront()
        front.installed = ["com.apple.Preferences", "com.apple.mobilesafari"]
        front.didOpen("com.apple.Preferences")
        front.didPressHome()
        var asked = [String]()
        XCTAssertEqual(front.find(isForeground: { asked.append($0); return $0 == "com.apple.Preferences" }, budget: { true }), RunnerTree.springboard)
        XCTAssertEqual(asked, [], "nothing is asked after the home button")
        XCTAssertTrue(front.left.contains("com.apple.Preferences"))
        front.didOpen("com.apple.Preferences")
        XCTAssertEqual(front.find(isForeground: { $0 == "com.apple.Preferences" }, budget: { true }), "com.apple.Preferences", "opened again: asked again")
        XCTAssertFalse(front.left.contains("com.apple.Preferences"))
    }

    /// CI run 44951831619: after a link Safari was visible but never said runningForeground, Settings (behind it) still did.
    func testALinkLeavesTheFrontUnknownInsteadOfWrong() {
        var front = RunnerFront()
        front.installed = ["com.apple.Preferences", "com.apple.mobilesafari"]
        front.didOpen("com.apple.Preferences")
        front.didOpenLink()
        XCTAssertNil(front.last)
        XCTAssertNil(front.find(isForeground: { $0 == "com.apple.Preferences" }, budget: { true }), "the app behind the link is not taken for the front")
        XCTAssertEqual(front.find(isForeground: { $0 == "com.apple.mobilesafari" }, budget: { true }), "com.apple.mobilesafari", "a candidate that does say it is in front is taken")
        XCTAssertEqual(front.candidates(), ["com.apple.mobilesafari"])
    }
}

/// Konrad #53 (21.11.2026): locked -> no input, never a code typed; the decision from the signals the runner reads.
final class RunnerLockTests: XCTestCase {
    private let screen = RunnerScreen(width: 402, height: 874, scale: 3, orientation: "portrait")

    func testDecision() {
        XCTAssertNil(RunnerLock.decide(RunnerLockSignals()), "nothing readable: unknown, the PC checks itself")
        XCTAssertNil(RunnerLock.decide(RunnerLockSignals(passcode: false)), "no code entry alone says nothing")
        XCTAssertEqual(RunnerLock.decide(RunnerLockSignals(passcode: true)), true, "a visible code entry is always locked")
        XCTAssertEqual(RunnerLock.decide(RunnerLockSignals(notify: 0)), false)
        XCTAssertEqual(RunnerLock.decide(RunnerLockSignals(notify: 1)), true)
        XCTAssertEqual(RunnerLock.decide(RunnerLockSignals(notify: 0, device: true)), true, "any source saying locked wins")
        XCTAssertEqual(RunnerLock.decide(RunnerLockSignals(notify: 0, device: false, passcode: true)), true)
        XCTAssertEqual(RunnerLock.decide(RunnerLockSignals(device: false)), false)
        XCTAssertFalse(RunnerLockSignals(passcode: true).hasSource)
        XCTAssertTrue(RunnerLockSignals(notify: 0).hasSource)
    }

    func testWhichOperationsTheLockRefuses() {
        XCTAssertFalse(RunnerLock.refuses(.state))
        XCTAssertFalse(RunnerLock.refuses(.screenshot(format: "png", quality: 0.7, maxEdge: nil)))
        XCTAssertFalse(RunnerLock.refuses(.tree(bundle: nil, maxNodes: 10, maxDepth: 10, all: false)))
        XCTAssertTrue(RunnerLock.refuses(.tap(x: 1, y: 1, count: 1, holdMs: 0)))
        XCTAssertTrue(RunnerLock.refuses(.swipe([RunnerPoint(x: 1, y: 1, t: 0), RunnerPoint(x: 2, y: 2, t: 10)])))
        XCTAssertTrue(RunnerLock.refuses(.text("1234")))
        XCTAssertTrue(RunnerLock.refuses(.openURL("https://example.com")))
        XCTAssertTrue(RunnerLock.refuses(.openBundle("com.apple.Preferences")))
        XCTAssertTrue(RunnerLock.refuses(.button("action")))
        XCTAssertTrue(RunnerLock.refuses(.button("camera")))
        for allowed in ["home", "volume_up", "volume_down"] { XCTAssertFalse(RunnerLock.refuses(.button(allowed)), allowed) }
        XCTAssertTrue(RunnerLock.checksCodeEntry(.text("1")))
        XCTAssertTrue(RunnerLock.checksCodeEntry(.tap(x: 1, y: 1, count: 1, holdMs: 0)))
        XCTAssertFalse(RunnerLock.checksCodeEntry(.button("home")))
        XCTAssertFalse(RunnerLock.checksCodeEntry(.state))
    }

    private func key(_ label: String, x: Double, y: Double, type: String) -> RunnerElement {
        RunnerElement(type: type, label: label, frame: RunnerRect(x: x, y: y, width: 78, height: 78))
    }

    private func pad(_ labels: [String], y: Double = 400, type: String = "Button") -> RunnerElement {
        RunnerElement(type: "Other", frame: RunnerRect(x: 0, y: 0, width: 402, height: 874),
                      children: labels.enumerated().map { key($0.element, x: Double($0.offset % 3) * 100 + 40, y: y + Double($0.offset / 3) * 90, type: type) })
    }

    func testCodeEntryFromTheNumberPadInAnyLanguage() {
        let western = ["1", "2 ABC", "3 DEF", "4 GHI", "5 JKL", "6 MNO", "7 PQRS", "8 TUV", "9 WXYZ", "0"]
        XCTAssertTrue(RunnerLock.codeEntryVisible(RunnerElement(type: "Application", children: [pad(western)]), screen: screen))
        XCTAssertTrue(RunnerLock.codeEntryVisible(pad(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], type: "Key"), screen: screen))
        let arabicIndic = ["\u{661}", "\u{662}", "\u{663}", "\u{664}", "\u{665}", "\u{666}", "\u{667}", "\u{668}", "\u{669}", "\u{660}"]
        XCTAssertTrue(RunnerLock.codeEntryVisible(pad(arabicIndic), screen: screen), "digits of another script count")
        XCTAssertFalse(RunnerLock.codeEntryVisible(pad(Array(western.dropLast())), screen: screen), "nine digits are not a pad")
        XCTAssertFalse(RunnerLock.codeEntryVisible(pad(western, y: 2000), screen: screen), "a pad off the screen does not count")
        XCTAssertFalse(RunnerLock.codeEntryVisible(pad(western, type: "StaticText"), screen: screen), "texts are not keys")
        let clock = ["10:41", "12", "1 new", "2024", "3", "4", "5", "6", "7", "8"]
        XCTAssertFalse(RunnerLock.codeEntryVisible(pad(clock), screen: screen), "a clock and numbers with two digits are not keys")
    }

    func testCodeEntryFromAPasswordField() {
        let field = RunnerElement(type: "SecureTextField", frame: RunnerRect(x: 40, y: 200, width: 320, height: 44))
        XCTAssertTrue(RunnerLock.codeEntryVisible(RunnerElement(type: "Application", children: [RunnerElement(type: "Window", children: [field])]), screen: screen))
        var hidden = field
        hidden.frame = RunnerRect(x: 40, y: -300, width: 320, height: 44)
        XCTAssertFalse(RunnerLock.codeEntryVisible(RunnerElement(type: "Application", children: [hidden]), screen: screen), "above the screen (the cover sheet) does not count")
        var noFrame = field
        noFrame.frame = nil
        XCTAssertFalse(RunnerLock.codeEntryVisible(noFrame, screen: screen))
    }
}

final class RunnerSwipeTests: XCTestCase {
    func testLineFromFirstToLastDistinctPoint() {
        let points = [RunnerPoint(x: 200, y: 600, t: 0), RunnerPoint(x: 200, y: 450, t: 120), RunnerPoint(x: 200, y: 260, t: 300), RunnerPoint(x: 200, y: 260, t: 700)]
        let line = RunnerSwipe.line(points)
        XCTAssertEqual(line, RunnerSwipe.Line(fromX: 200, fromY: 600, toX: 200, toY: 260, pressMs: 0, moveMs: 300, holdMs: 400))
        XCTAssertEqual(line.velocity, 340 / 0.3, accuracy: 0.001)
        let rest = RunnerSwipe.line([RunnerPoint(x: 5, y: 5, t: 0), RunnerPoint(x: 5, y: 5, t: 200), RunnerPoint(x: 5, y: 100, t: 500)])
        XCTAssertEqual(rest.pressMs, 200)
        XCTAssertEqual(rest.moveMs, 300)
        XCTAssertEqual(rest.holdMs, 0)
        let still = RunnerSwipe.line([RunnerPoint(x: 5, y: 5, t: 0), RunnerPoint(x: 5, y: 5, t: 900)])
        XCTAssertEqual(still.pressMs, 900)
        XCTAssertEqual(still.velocity, 0)
    }

    func testPointsOutsideTheScreen() {
        let screen = RunnerScreen(width: 402, height: 874, scale: 3, orientation: "portrait")
        XCTAssertNil(RunnerSwipe.outside([RunnerPoint(x: 0, y: 0, t: 0), RunnerPoint(x: 401.9, y: 873.9, t: 1)], screen: screen))
        XCTAssertEqual(RunnerSwipe.outside([RunnerPoint(x: 0, y: 0, t: 0), RunnerPoint(x: 402, y: 10, t: 1)], screen: screen)?.x, 402)
        XCTAssertEqual(RunnerSwipe.offsets([RunnerPoint(x: 0, y: 0, t: 0), RunnerPoint(x: 0, y: 0, t: 250)]), [0, 0.25])
    }

    func testGlideStartsAndEndsExactlyRisesAndArcs() {
        let path = RunnerSwipe.glide(fromX: 201, fromY: 611, toX: 201, toY: 262, durationMs: 300)
        XCTAssertEqual(path.count, 24)
        XCTAssertEqual(path.first, RunnerPoint(x: 201, y: 611, t: 0))
        XCTAssertEqual(path.last, RunnerPoint(x: 201, y: 262, t: 300))
        for i in 1..<path.count { XCTAssertGreaterThan(path[i].t, path[i - 1].t) }
        XCTAssertTrue(path.contains { abs($0.x - 201) >= 0.5 }, "a faint arc, not a ruler line")
        XCTAssertTrue(path.allSatisfy { abs($0.x - 201) <= 349 * 0.03 }, "the arc stays within 3 % of the distance")
        // minimum jerk: slow at both ends, fastest in the middle
        let first = abs(path[1].y - path[0].y), middle = abs(path[12].y - path[11].y), last = abs(path[23].y - path[22].y)
        XCTAssertGreaterThan(middle, first * 3)
        XCTAssertGreaterThan(middle, last * 3)
        XCTAssertEqual(RunnerSwipe.glide(fromX: 0, fromY: 0, toX: 10, toY: 10, durationMs: 5, maxPoints: 99).count, 32)
        let tiny = RunnerSwipe.glide(fromX: 0, fromY: 0, toX: 10, toY: 10, durationMs: 5, maxPoints: 99)
        for i in 1..<tiny.count { XCTAssertGreaterThan(tiny[i].t, tiny[i - 1].t) }
        // what the glide gives is a valid swipe request
        let json: JSONObject = ["op": "swipe", "points": path.map { $0.json }]
        let parsed = try? Json.object(Json.write(json))
        XCTAssertNotNil(parsed)
        if case .success(.op(.swipe(let back))) = RunnerRequest.parse(parsed!, caps: []) { XCTAssertEqual(back, path) } else { XCTFail("glide is not a valid swipe") }
    }
}

final class RunnerSessionTests: XCTestCase {
    private let token = bytes(0..<32)
    private var clock: Int64 = 1_000

    private func session(caps: Set<String> = ["open.url"]) -> RunnerSession {
        RunnerSession(token: token, caps: caps, now: clock, welcome: { ["runner": ["protocol": 1], "caps": ["open.url"]] }, uptimeMs: { 81234 },
                      nonce: { bytes(32..<48) })
    }

    /// Preamble, hello and auth like the PC does; returns the actions of auth.
    private func login(_ s: RunnerSession, proof: String? = nil) -> [RunnerSession.Action] {
        let pre = s.receive(RunnerWire.preamble, now: clock)
        XCTAssertEqual(pre.count, 1)
        let hello = sent(s.receive(request(["id": 1, "op": "hello", "v": 1, "nonce": Crypto.hex(bytes(16..<32))]), now: clock))[0].json
        XCTAssertEqual(hello["ok"] as? Bool, true)
        XCTAssertEqual(hello["nonce"] as? String, Crypto.hex(bytes(32..<48)))
        XCTAssertEqual(hello["proof"] as? String, "b0b5ea4ab9f6726c24dce8128ecc9cd1b9ff9801852c71e46f4d278c06d41aa4")
        return s.receive(request(["id": 2, "op": "auth", "proof": proof ?? "315931dd0f5d7ef040e3df2999e6e283f3540b1a3bf2a75ea856b24ae929b68d",
                                  "apps": ["com.apple.Preferences"]]), now: clock)
    }

    func testHandshakeThenOneOperationAtATime() {
        let s = session()
        let auth = login(s)
        guard case .authed(let apps) = auth[0] else { return XCTFail("no authed") }
        XCTAssertEqual(apps, ["com.apple.Preferences"])
        XCTAssertEqual(sent(auth)[0].json["ok"] as? Bool, true)
        XCTAssertTrue(s.isAuthed)

        let tap = s.receive(request(["id": 3, "op": "tap", "x": 10, "y": 20]), now: clock)
        guard case .perform(let id, let op) = tap[0] else { return XCTFail("no perform") }
        XCTAssertEqual(id, 3)
        XCTAssertEqual(op, .tap(x: 10, y: 20, count: 1, holdMs: 0))
        let busy = sent(s.receive(request(["id": 4, "op": "state"]), now: clock))
        XCTAssertEqual(code(busy[0].json), "busy")
        XCTAssertEqual(busy[0].json["id"] as? Double, 4)
        let done = sent(s.complete(id: 3, answer: .done()))
        XCTAssertEqual(done[0].json["id"] as? Double, 3)
        XCTAssertEqual(done[0].json["ok"] as? Bool, true)
        XCTAssertTrue(s.complete(id: 3, answer: .done()).isEmpty, "an answer comes once")

        let ping = sent(s.receive(request(["id": 5, "op": "ping"]), now: clock))
        XCTAssertEqual(ping[0].json["uptimeMs"] as? Double, 81234)
        let bad = sent(s.receive(request(["id": 6, "op": "tap", "x": 1]), now: clock))
        XCTAssertEqual(code(bad[0].json), "bad_request")
        let unknown = sent(s.receive(request(["id": 7, "op": "frobnicate"]), now: clock))
        XCTAssertEqual(code(unknown[0].json), "unknown_op")
        XCTAssertTrue(s.isAuthed, "errors of section 7 keep the connection")

        let end = s.receive(request(["id": 8, "op": "end"]), now: clock)
        XCTAssertEqual(sent(end)[0].json["ok"] as? Bool, true)
        XCTAssertTrue(end.contains { if case .end = $0 { return true } else { return false } })
        XCTAssertTrue(closes(end))
        XCTAssertEqual(s.phase, .closed)
    }

    func testFramesGluedTogetherWithThePreamble() {
        let s = session()
        let all = RunnerWire.preamble + request(["id": 1, "op": "hello", "v": 1, "nonce": Crypto.hex(bytes(16..<32))])
            + request(["id": 2, "op": "auth", "proof": "315931dd0f5d7ef040e3df2999e6e283f3540b1a3bf2a75ea856b24ae929b68d"]) + request(["id": 3, "op": "state"])
        let actions = s.receive(all, now: clock)
        XCTAssertEqual(sent(actions).count, 2)
        XCTAssertTrue(actions.contains { if case .perform(3, .state) = $0 { return true } else { return false } })
    }

    func testStrayClientIsClosedWithoutAnswer() {
        let s = session()
        let actions = s.receive(Array("GET / HTTP/1.1\r\n\r\n".utf8), now: clock)
        XCTAssertEqual(actions.count, 1)
        XCTAssertTrue(closes(actions))
        let partial = session()
        XCTAssertTrue(partial.receive(Array("ATK".utf8), now: clock).isEmpty, "a partial preamble waits")
        XCTAssertTrue(closes(partial.receive(Array("X".utf8), now: clock)))
    }

    func testNothingBeforeAuth() {
        let s = session()
        _ = s.receive(RunnerWire.preamble, now: clock)
        let early = s.receive(request(["id": 1, "op": "state"]), now: clock)
        XCTAssertEqual(code(sent(early)[0].json), "unauthorized")
        XCTAssertTrue(closes(early))
        let other = session()
        _ = other.receive(RunnerWire.preamble, now: clock)
        let noHello = other.receive(request(["id": 1, "op": "auth", "proof": String(repeating: "00", count: 32)]), now: clock)
        XCTAssertEqual(code(sent(noHello)[0].json), "unauthorized")
        let third = session()
        _ = third.receive(RunnerWire.preamble, now: clock)
        let unknown = third.receive(request(["id": 1, "op": "frobnicate"]), now: clock)
        XCTAssertEqual(code(sent(unknown)[0].json), "unauthorized")
    }

    func testWrongProofAndOldVersion() {
        let s = session()
        let actions = login(s, proof: String(repeating: "00", count: 32))
        guard case .authFailed = actions[0] else { return XCTFail("not counted") }
        XCTAssertEqual(code(sent(actions)[0].json), "auth_failed")
        XCTAssertTrue(closes(actions))
        XCTAssertFalse(s.isAuthed)
        let old = session()
        _ = old.receive(RunnerWire.preamble, now: clock)
        let v0 = old.receive(request(["id": 1, "op": "hello", "v": 0, "nonce": Crypto.hex(bytes(16..<32))]), now: clock)
        XCTAssertEqual(code(sent(v0)[0].json), "unsupported_version")
        XCTAssertTrue(closes(v0))
    }

    func testNotReadyAndTimeout() {
        let s = session()
        _ = login(s)
        s.notReady = true
        XCTAssertEqual(code(sent(s.receive(request(["id": 3, "op": "screenshot"]), now: clock))[0].json), "not_ready")
        XCTAssertEqual(sent(s.receive(request(["id": 4, "op": "ping"]), now: clock))[0].json["ok"] as? Bool, true, "ping works while not ready")
        s.notReady = false
        _ = s.receive(request(["id": 5, "op": "tree"]), now: clock)
        XCTAssertEqual(code(sent(s.timedOut(id: 5))[0].json), "timeout")
        XCTAssertTrue(s.complete(id: 5, answer: .done()).isEmpty, "the late result is dropped")
        XCTAssertNil(s.inFlight)
    }

    func testAuthWindowAndSilence() {
        let s = session()
        _ = s.receive(RunnerWire.preamble, now: clock)
        XCTAssertTrue(s.tick(now: clock + 4000).isEmpty)
        XCTAssertTrue(closes(s.tick(now: clock + 5001)))
        let t = session()
        _ = login(t)
        XCTAssertTrue(t.tick(now: clock + 59_000).isEmpty)
        XCTAssertTrue(closes(t.tick(now: clock + 60_001)))
    }

    func testHub() {
        let hub = RunnerHub(idleSeconds: 30, now: 0)
        XCTAssertTrue(hub.accept(1))
        XCTAssertTrue(hub.accept(2))
        XCTAssertFalse(hub.accept(3), "at most two unauthenticated")
        XCTAssertNil(hub.authenticated(1))
        XCTAssertTrue(hub.accept(3))
        XCTAssertEqual(hub.authenticated(3), 1, "the newer authenticated connection closes the older")
        hub.closed(1, now: 10_000)
        XCTAssertEqual(hub.current, 3)
        XCTAssertFalse(hub.idleEnd(now: 100_000), "an authenticated connection keeps it alive")
        hub.closed(3, now: 100_000)
        XCTAssertFalse(hub.idleEnd(now: 129_999))
        XCTAssertTrue(hub.idleEnd(now: 130_000))
        for _ in 0..<4 { XCTAssertFalse(hub.failedProof()) }
        XCTAssertTrue(hub.failedProof(), "the fifth wrong proof ends the runner")
    }
}
