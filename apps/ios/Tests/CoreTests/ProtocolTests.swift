// Owns: the protocol pieces against stand-ins for the PC: Tunnel framing, the peer handshake and channel (PeerChannel vs the
// PC's side written from handshake.ts/channel.ts), the connect request (RemotePair vs the PC's side from sas.ts), and the
// local entrance (StreamProxy with real TCP clients and the PC's stream server). In-process; a real PC and device are not involved.
import XCTest
@testable import AutarkCore

final class TunnelTests: XCTestCase {
    private final class Wire: TunnelLink {
        var other: Tunnel?
        var frames = [Bytes]()
        var closedTids = [Int]()
        func send(_ frame: Bytes) { frames.append(frame); other?.receive(frame) }
        func close(_ tid: Int) { closedTids.append(tid) }
    }
    private final class Collector: PipeListener {
        var messages = [(Bytes, Bool)]()
        var closedCount = 0
        func message(_ data: Bytes, text: Bool) { messages.append((data, text)) }
        func closed() { closedCount += 1 }
    }

    private func pair() -> (a: Tunnel, b: Tunnel, wireA: Wire, wireB: Wire, ca: Collector, cb: Collector) {
        let k1 = Crypto.random(32), k2 = Crypto.random(32)
        let wa = Wire(), wb = Wire()
        let a = Tunnel(tid: 0x01020304, peer: "b", link: wa, sendKey: k1, receiveKey: k2)
        let b = Tunnel(tid: 0x01020304, peer: "a", link: wb, sendKey: k2, receiveKey: k1)
        wa.other = b
        wb.other = a
        let ca = Collector(), cb = Collector()
        a.listen(ca)
        b.listen(cb)
        return (a, b, wa, wb, ca, cb)
    }

    func testBigBinaryMessageIsChunkedAndJoined() {
        let p = pair()
        let big = Bytes((0..<200_000).map { UInt8(truncatingIfNeeded: $0) })
        p.a.sendBinary(big)
        XCTAssertEqual(p.wireA.frames.count, 4) // 60 KiB chunks
        for (i, frame) in p.wireA.frames.enumerated() {
            XCTAssertEqual(Array(frame[0..<4]), [1, 2, 3, 4])
            XCTAssertEqual(frame[4], i < 3 ? 2 : 0, "MORE on all but the last chunk")
            XCTAssertLessThanOrEqual(frame.count, 5 + 60 * 1024)
        }
        XCTAssertEqual(p.cb.messages.count, 1)
        XCTAssertEqual(p.cb.messages[0].0, big)
        XCTAssertFalse(p.cb.messages[0].1)
    }

    func testEmptyAndExactChunkMessages() {
        let p = pair()
        p.a.sendBinary([])
        XCTAssertEqual(p.wireA.frames.count, 1)
        p.a.sendBinary(Bytes(repeating: 5, count: 60 * 1024))
        XCTAssertEqual(p.wireA.frames.count, 2)
        XCTAssertEqual(p.cb.messages.map { $0.0.count }, [0, 60 * 1024])
    }

    func testTextFramesAreSealedWithCounters() {
        let p = pair()
        p.a.sendText("one")
        p.a.sendText("two")
        XCTAssertEqual(p.cb.messages.map { Crypto.string($0.0) }, ["one", "two"])
        XCTAssertTrue(p.cb.messages.allSatisfy { $0.1 })
        XCTAssertEqual(p.wireA.frames[0][4], 1)
        XCTAssertEqual(p.wireA.frames[0].count, 5 + 3 + 16)
        // a replayed text frame does not open under the next counter: the tunnel ends
        p.b.receive(p.wireA.frames[0])
        XCTAssertTrue(p.b.isClosed)
        XCTAssertEqual(p.cb.closedCount, 1)
        XCTAssertEqual(p.wireB.closedTids, [0x01020304])
    }

    func testCloseTellsTheLinkOnceAndStopsSending() {
        let p = pair()
        p.a.close()
        p.a.close()
        XCTAssertEqual(p.wireA.closedTids, [0x01020304])
        XCTAssertEqual(p.ca.closedCount, 1)
        p.a.sendBinary([1])
        XCTAssertEqual(p.wireA.frames.count, 0)
    }

    func testTooLongMessageEndsTheTunnel() {
        let p = pair()
        let frame: Bytes = [1, 2, 3, 4, 2] + Bytes(repeating: 0, count: 60 * 1024)
        for _ in 0..<((8 * 1024 * 1024 + 1024) / (60 * 1024) + 2) { p.b.receive(frame) }
        XCTAssertTrue(p.b.isClosed)
    }
}

final class PeerChannelTests: XCTestCase {
    final class Collector: PeerListener {
        let lock = NSLock()
        var messages = [JSONObject]()
        var closedCount = 0
        func message(_ message: JSONObject) { lock.lock(); messages.append(message); lock.unlock() }
        func closed() { lock.lock(); closedCount += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return messages.count }
        var closes: Int { lock.lock(); defer { lock.unlock() }; return closedCount }
    }

    let phoneSeed = Bytes(repeating: 0x11, count: 32)
    let pcSeed = Bytes(repeating: 0x22, count: 32)

    func testHandshakeAndEncryptedMessagesBothWays() throws {
        let (phonePipe, pcPipe) = MemoryPipe.pair()
        let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: Crypto.ed25519Public(seed: phoneSeed))
        let atPc = Locked([JSONObject]())
        pc.onMessage = { m in atPc.with { $0.append(m) } }
        let collector = Collector()
        let channel = try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_phone0000000000001", pcPublicKey: pc.publicKey, listener: collector)
        XCTAssertEqual(try pc.authenticated.get(timeout: 5), true)
        XCTAssertEqual(pc.helloPhone, "dev_phone0000000000001")
        channel.send(["t": "o", "s": 1])
        channel.send(["t": "d", "s": 1, "b": "aGk="])
        eventually(3, "PC messages") { atPc.value.count == 2 }
        XCTAssertEqual(atPc.value.map { Json.str($0, "t") }, ["o", "d"])
        pc.send(["t": "d", "s": 1, "b": "aGVsbG8="])
        pc.send(["t": "e", "s": 1])
        eventually(3, "phone messages") { collector.count == 2 }
        XCTAssertEqual(collector.messages.map { Json.str($0, "t") }, ["d", "e"])
        XCTAssertFalse(channel.direct)
        channel.close()
        XCTAssertTrue(channel.isClosed)
        XCTAssertEqual(collector.closes, 1)
    }

    func testAnotherPcKeyIsRefused() {
        let (phonePipe, pcPipe) = MemoryPipe.pair()
        let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: nil)
        _ = pc
        XCTAssertThrowsError(try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_x", pcPublicKey: Crypto.ed25519Public(seed: Bytes(repeating: 0x77, count: 32)), listener: nil)) { error in
            XCTAssertEqual((error as? AutarkError)?.message, "This is not the paired PC.")
        }
        XCTAssertTrue(phonePipe.isClosed)
    }

    func testAPcThatDoesNotKnowThePhoneClosesTheHandshake() {
        let (phonePipe, pcPipe) = MemoryPipe.pair()
        let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: Crypto.ed25519Public(seed: Bytes(repeating: 0x55, count: 32)))
        _ = pc
        XCTAssertThrowsError(try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_x", pcPublicKey: Crypto.ed25519Public(seed: pcSeed), listener: nil)) { error in
            XCTAssertEqual((error as? AutarkError)?.message, "Your PC did not answer the handshake.")
        }
    }

    func testReplayedFrameEndsTheChannel() throws {
        let (phonePipe, pcPipe) = MemoryPipe.pair()
        let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: nil)
        let collector = Collector()
        let channel = try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_x", pcPublicKey: pc.publicKey, listener: collector)
        XCTAssertEqual(try pc.authenticated.get(timeout: 5), true)
        pc.send(["t": "d", "s": 3, "b": "eA=="])
        eventually(3, "first message") { collector.count == 1 }
        let frame = pc.lastFrame
        XCTAssertEqual(frame.count > 24, true)
        channel.message(frame, text: false) // the same frame again: counter 0 is not above the last one seen
        XCTAssertTrue(channel.isClosed)
        XCTAssertEqual(collector.count, 1)
        XCTAssertEqual(collector.closes, 1)
    }

    func testTamperedFrameEndsTheChannel() throws {
        let (phonePipe, pcPipe) = MemoryPipe.pair()
        let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: nil)
        let channel = try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_x", pcPublicKey: pc.publicKey, listener: nil)
        XCTAssertEqual(try pc.authenticated.get(timeout: 5), true)
        pc.send(["t": "e", "s": 3])
        eventually(3, "frame sent") { !pc.lastFrame.isEmpty }
        var frame = pc.lastFrame
        frame[frame.count - 1] ^= 1
        frame[7] = 5 // a fresh counter, so only the tag can fail
        channel.message(frame, text: false)
        XCTAssertTrue(channel.isClosed)
    }

    func testTextFrameAfterTheHandshakeEndsTheChannel() throws {
        let (phonePipe, pcPipe) = MemoryPipe.pair()
        let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: nil)
        let channel = try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_x", pcPublicKey: pc.publicKey, listener: nil)
        XCTAssertEqual(try pc.authenticated.get(timeout: 5), true)
        pc.pipe.sendText("surprise")
        eventually(3, "channel closed") { channel.isClosed }
    }
}

final class RemotePairTests: XCTestCase {
    private func make(_ remote: FakePcRemote, name: String? = "Test iPhone") -> RemotePair {
        RemotePair(transport: { body, _ in remote.handle(body) }, seed: Bytes(repeating: 0x11, count: 32), deviceId: "dev_phone00000000000001", name: name)
    }

    func testBothScreensShowTheSameCodeAndAcceptGivesTheToken() throws {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let pair = make(remote)
        let asked = try pair.ask(remoteId: Crypto.remoteId(Crypto.fingerprint(remote.publicKey)), pcFingerprint: Crypto.fingerprint(remote.publicKey))
        XCTAssertEqual(asked.code.count, 4)
        XCTAssertEqual(asked.code, remote.code, "the code on the phone is the code on the PC")
        XCTAssertEqual(asked.pcName, "Studio PC")
        XCTAssertEqual(asked.pcDeviceId, "dev_fakepc0000000001")
        remote.decision.complete(true)
        let accepted = try pair.awaitAccept(asked, cancelled: { false })
        XCTAssertEqual(accepted.token, remote.token)
        XCTAssertEqual(accepted.deviceId, "dev_phoneaccepted0001")
    }

    func testWaitsThroughPendingAnswers() throws {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let pair = make(remote)
        let asked = try pair.ask(remoteId: "000000000", pcFingerprint: Crypto.fingerprint(remote.publicKey))
        spawn("accept-later") { Thread.sleep(forTimeInterval: 1.0); remote.decision.complete(true) }
        let accepted = try pair.awaitAccept(asked, cancelled: { false })
        XCTAssertEqual(accepted.token, remote.token)
    }

    func testDeclined() throws {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let pair = make(remote)
        let asked = try pair.ask(remoteId: "000000000", pcFingerprint: Crypto.fingerprint(remote.publicKey))
        remote.decision.complete(false)
        XCTAssertThrowsError(try pair.awaitAccept(asked, cancelled: { false })) { XCTAssertEqual(($0 as? AutarkError)?.message, "The person declined on the PC.") }
    }

    func testCancelTellsThePc() throws {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let pair = make(remote)
        let asked = try pair.ask(remoteId: "000000000", pcFingerprint: Crypto.fingerprint(remote.publicKey))
        XCTAssertThrowsError(try pair.awaitAccept(asked, cancelled: { true })) { XCTAssertEqual(($0 as? AutarkError)?.message, "Cancelled.") }
        XCTAssertTrue(remote.wasCancelled)
    }

    func testAnotherPcAnsweringIsRefused() {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let pair = make(remote)
        XCTAssertThrowsError(try pair.ask(remoteId: "000000000", pcFingerprint: String(repeating: "a", count: 64))) {
            XCTAssertEqual(($0 as? AutarkError)?.message, "A different PC answered than the one with this Remote ID.")
        }
    }

    func testAForgedAcceptanceIsRefused() throws {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        remote.decision.complete(true)
        // a man in the middle that does not know the session key answers remote3 with a wrong MAC
        let pair = RemotePair(transport: { body, _ in
            var reply = remote.handle(body)
            if Json.str(body, "kind") == "remote3" { reply["mac"] = "AAAA" }
            return reply
        }, seed: Bytes(repeating: 0x11, count: 32), deviceId: "dev_phone00000000000001", name: "x")
        let asked = try pair.ask(remoteId: "000000000", pcFingerprint: Crypto.fingerprint(remote.publicKey))
        XCTAssertThrowsError(try pair.awaitAccept(asked, cancelled: { false })) { XCTAssertEqual(($0 as? AutarkError)?.message, "The PC could not prove its identity.") }
    }

    func testAPcThatCannotSignTheTranscriptIsRefused() {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let pair = RemotePair(transport: { body, _ in
            var reply = remote.handle(body)
            if Json.str(body, "kind") == "remote2" { reply["sig"] = Crypto.b64url(Bytes(repeating: 1, count: 64)) }
            return reply
        }, seed: Bytes(repeating: 0x11, count: 32), deviceId: "dev_phone00000000000001", name: "x")
        XCTAssertThrowsError(try pair.ask(remoteId: "000000000", pcFingerprint: Crypto.fingerprint(remote.publicKey))) {
            XCTAssertEqual(($0 as? AutarkError)?.message, "The PC could not prove its identity.")
        }
    }

    func testThePcsRefusalTextReachesThePerson() {
        let pair = RemotePair(transport: { _, _ in ["ok": false, "error": ["code": "x", "message": "Not accepting connection requests."] as JSONObject] },
                              seed: Bytes(repeating: 0x11, count: 32), deviceId: "dev_phone00000000000001", name: "x")
        XCTAssertThrowsError(try pair.ask(remoteId: "000000000", pcFingerprint: "")) { XCTAssertEqual(($0 as? AutarkError)?.message, "Not accepting connection requests.") }
    }

    func testDeviceNameIsCleanedAndCut() {
        let remote = FakePcRemote(seed: Bytes(repeating: 0x22, count: 32))
        let long = "Stanislaus' iPhone\n" + String(repeating: "é", count: 80)
        let pair = make(remote, name: long)
        let name = Json.str(pair.info, "name")!
        XCTAssertLessThanOrEqual(name.utf16.count, 60)
        XCTAssertFalse(name.contains("\n"))
        XCTAssertTrue(name.hasPrefix("Stanislaus' iPhone "))
        XCTAssertEqual(Json.str(make(remote, name: "  ").info, "name"), "iPhone")
        XCTAssertEqual(Json.str(pair.info, "role"), "client")
    }
}

final class StreamProxyTests: XCTestCase {
    typealias Rig = ProxyRig

    func rig(gate: String = "gate-secret") throws -> Rig { try makeProxyRig(gate: gate) }

    /// One HTTP exchange through the proxy over a real TCP connection; the whole answer (until the proxy ends the stream).
    func fetch(port: Int, head: String, body: Bytes = []) -> String? {
        guard let client = TcpConnection.connect(port: port) else { XCTFail("could not connect"); return nil }
        client.write(Crypto.utf8(head) + body)
        var all = Bytes()
        while let part = client.read(max: 64 * 1024, timeoutSeconds: 10) { all.append(contentsOf: part) }
        client.shutdown()
        return String(decoding: all, as: UTF8.self)
    }

    func fetchBytes(port: Int, head: String) -> Bytes {
        guard let client = TcpConnection.connect(port: port) else { return [] }
        client.write(Crypto.utf8(head))
        var all = Bytes()
        while let part = client.read(max: 64 * 1024, timeoutSeconds: 10) { all.append(contentsOf: part) }
        return all
    }

    func testPageLoadsThroughTheTunnelWithTheGateCookie() throws {
        let r = try rig()
        defer { r.proxy.close() }
        let answer = fetch(port: r.proxy.port, head: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: other=1; autark_gate=gate-secret\r\nConnection: close\r\n\r\n")
        XCTAssertNotNil(answer)
        XCTAssertTrue(answer!.hasPrefix("HTTP/1.1 200 OK"), answer ?? "")
        XCTAssertTrue(answer!.hasSuffix("<html><body>Autark phone UI</body></html>"))
        XCTAssertEqual(r.proxy.origin, "http://127.0.0.1:\(r.proxy.port)")
        eventually(3, "stream closed") { r.proxy.openStreams == 0 }
    }

    func testWithoutOrWithAWrongGateCookieNothingPasses() throws {
        let r = try rig()
        defer { r.proxy.close() }
        for cookie in ["", "Cookie: autark_gate=wrong\r\n", "Cookie: autark_gate=\r\n", "Cookie: xautark_gate=gate-secret\r\n", "X-Cookie: autark_gate=gate-secret\r\n"] {
            let answer = fetch(port: r.proxy.port, head: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\(cookie)\r\n")
            XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 403 Forbidden") == true, "cookie '\(cookie)': \(answer ?? "nil")")
        }
        XCTAssertEqual(r.streams.requestHeads.count, 0, "nothing reached the PC")
    }

    func testBigAnswerArrivesWholeAndIsAcknowledged() throws {
        let r = try rig()
        defer { r.proxy.close() }
        let all = fetchBytes(port: r.proxy.port, head: "GET /big HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: autark_gate=gate-secret\r\n\r\n")
        let text = String(decoding: all.prefix(200), as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("HTTP/1.1 200 OK"))
        var split = 0
        for i in 0..<(all.count - 3) where all[i] == 13 && all[i + 1] == 10 && all[i + 2] == 13 && all[i + 3] == 10 { split = i + 4; break }
        XCTAssertGreaterThan(split, 0)
        let body = Bytes(all[split...])
        XCTAssertEqual(body.count, 600_000)
        XCTAssertEqual(body, Bytes((0..<600_000).map { UInt8(truncatingIfNeeded: $0 % 251) }))
    }

    func testBigUploadStaysWithinTheWindowAndArrivesWhole() throws {
        let r = try rig()
        defer { r.proxy.close() }
        let body = Bytes((0..<700_000).map { UInt8(truncatingIfNeeded: $0) })
        let answer = fetch(port: r.proxy.port, head: "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: autark_gate=gate-secret\r\nContent-Length: \(body.count)\r\n\r\n", body: body)
        XCTAssertTrue(answer?.hasSuffix("got 700000 bytes") == true, answer ?? "nil")
        XCTAssertGreaterThanOrEqual(r.streams.bytesUploaded, 700_000)
    }

    func testSeveralRequestsAtOnce() throws {
        let r = try rig()
        defer { r.proxy.close() }
        let results = Locked([String]())
        let group = DispatchGroup()
        for _ in 0..<8 {
            group.enter()
            DispatchQueue.global().async {
                if let a = self.fetch(port: r.proxy.port, head: "GET / HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n") { results.with { $0.append(a) } }
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 20), .success)
        XCTAssertEqual(results.value.count, 8)
        XCTAssertTrue(results.value.allSatisfy { $0.hasSuffix("</html>") })
    }

    func testDeadChannelBeforeAnAnswerGivesA503() throws {
        let r = try rig()
        defer { r.proxy.close() }
        r.streams.holdPaths = ["/hang"]
        let done = Future<String?>()
        DispatchQueue.global().async { done.complete(self.fetch(port: r.proxy.port, head: "GET /hang HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n")) }
        eventually(3, "request at the PC") { r.streams.requestHeads.count == 1 }
        r.pc.close() // the link dies while the PC has not answered
        let answer = try done.get(timeout: 10)
        XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 503 Service Unavailable") == true, answer ?? "nil")
        XCTAssertTrue(answer?.contains("not reachable") == true)
    }

    func testNoChannelGivesA503() throws {
        let r = try rig()
        defer { r.proxy.close() }
        r.channels.channel = nil
        let answer = fetch(port: r.proxy.port, head: "GET / HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n")
        XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 503 Service Unavailable") == true, answer ?? "nil")
    }

    func testSilentStreamAsksForAProbe() throws {
        let r = try rig()
        defer { r.proxy.close() }
        r.streams.holdPaths = ["/quiet"]
        let client = TcpConnection.connect(port: r.proxy.port)!
        client.write(Crypto.utf8("GET /quiet HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n"))
        eventually(8, "probe after 4 s of silence") { r.channels.probes == 1 }
        client.shutdown()
        eventually(3, "stream ended by the client") { r.proxy.openStreams == 0 }
    }

    func testOnlyLoopbackIsListenedOn() throws {
        let r = try rig()
        defer { r.proxy.close() }
        XCTAssertNotNil(TcpConnection.connect(port: r.proxy.port))
        XCTAssertTrue((r.proxy.port > 0) && (r.proxy.port < 65536))
    }

    func testRequestedPortIsUsedAndATakenPortFallsBack() throws {
        let channels = FixedChannels()
        let first = try StreamProxy(port: 0, gate: "g", channels: channels)
        defer { first.close() }
        let second = try StreamProxy(port: first.port, gate: "g", channels: channels) // taken: any free port
        defer { second.close() }
        XCTAssertNotEqual(first.port, second.port)
    }
}
