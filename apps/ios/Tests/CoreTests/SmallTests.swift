// Owns: the smaller pieces – person-code chains (CodeChain, vector W4 from the Android test), the JSON subset, which PC the
// page uses (PcLinks), version order (PcVersion), what the connect screen accepts (ConnectionAddress), the company list with
// its fixed ports (Companies) and the bar colours (CssColor). Never: a network test.
import XCTest
@testable import AutarkCore

final class CodeChainTests: XCTestCase {
    private let root = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w"
    private let a = "gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q"
    private let b = "7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E"
    private let rootFp = "34750f98bd59fcfc946da45aaabe933be154a4b5094e1c4abf42866505f3c97e"
    private let aFp = "6a3803d5f059902a1c6dafbc9ba4729212f7caac08634cc3ae76b27529f03827"
    private let bFp = "b62e867fa2f33afe62d5d6b1642e1621d543307846b2a57b897e710919b76709"
    private let fFp = "c5b940ed3f65c391965de8295fc5d25f474fa57b48d36eb10ad363b8539c1b79"

    private func chain(_ root: String, _ links: [String]) -> String { "{\"root\":\"\(root)\",\"links\":[\(links.joined(separator: ","))]}" }
    private func fill(_ value: UInt8) -> Bytes { Bytes(repeating: value, count: 32) }

    func testVectorFromTheDesktopAndAndroid() {
        let linkA = "{\"pub\":\"\(a)\",\"sig\":\"O576_zzndF29qmqcm5jrRZgKhpXtem-hmw7IQPyEEaL4-DG0nR0wIotGJY_rAKg7c6dxYryLPqFfi8gDud6-Bw\"}"
        let linkB = "{\"pub\":\"\(b)\",\"sig\":\"i5ka_Tv1qlsFzO1H8awBRr1o0e7BNN-UaRNst_2pmNZOuHmiSDfsbecjHzrRgYExfT9WNGrEyEbsL5aIwYLdBw\"}"
        let chainB = chain(root, [linkA, linkB])
        XCTAssertEqual(Crypto.fingerprint(Crypto.ed25519Public(seed: fill(1))), rootFp)
        XCTAssertEqual(Crypto.b64url(Crypto.ed25519Public(seed: fill(1))), root)
        XCTAssertEqual(Crypto.fingerprint(Crypto.fromB64url(a)!), aFp)
        XCTAssertEqual(Crypto.fingerprint(Crypto.fromB64url(b)!), bFp)
        XCTAssertEqual(Crypto.fingerprint(Crypto.ed25519Public(seed: fill(4))), fFp)
        XCTAssertEqual(Crypto.remoteId(rootFp), "133687038")
        XCTAssertEqual(Crypto.remoteId(aFp), "878149855")
        XCTAssertEqual(Crypto.remoteId(bFp), "830526398")
        // the signatures of the vector verify (the PC side signed them with Node)
        XCTAssertTrue(Crypto.verify(publicKey: Crypto.ed25519Public(seed: fill(1)), message: Crypto.utf8("wf-code-v1|" + aFp),
                                    signature: Crypto.fromB64url("O576_zzndF29qmqcm5jrRZgKhpXtem-hmw7IQPyEEaL4-DG0nR0wIotGJY_rAKg7c6dxYryLPqFfi8gDud6-Bw")))
        XCTAssertTrue(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: chainB), "B answers for the code through root -> A -> B")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: aFp, chainJson: chainB), "B's chain does not end at A")
        XCTAssertTrue(CodeChain.belongs(remoteId: "133687038", fingerprintHex: aFp, chainJson: chain(root, [linkA])), "A with its own one-link chain")
        XCTAssertTrue(CodeChain.belongs(remoteId: "133687038", fingerprintHex: rootFp, chainJson: chain(root, [])), "the root with links []")
        XCTAssertTrue(CodeChain.belongs(remoteId: "133687038", fingerprintHex: rootFp, chainJson: nil), "the root by its own ID")
        XCTAssertTrue(CodeChain.belongs(remoteId: "830526398", fingerprintHex: bFp, chainJson: nil), "B by its own ID (old path)")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: nil), "B without a chain is not the code")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: fFp, chainJson: chainB), "a foreign key with B's chain")
        let forged = "{\"pub\":\"\(b)\",\"sig\":\"fvGsSmZZ0n86BCd12uJDXZkxa6DI2ka986_T9W1vONh5nsWS8zF24AX1SpS2C_cBk1RRCv0eYgZzQGFz78MmDw\"}"
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: chain(root, [forged])), "B signed by F, not by the root")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: aFp, chainJson: chain(root, Array(repeating: linkA, count: 9))), "more than 8 links")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687039", fingerprintHex: bFp, chainJson: chainB), "the code does not match the root")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: "[1,2]"), "a chain that is not an object")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: "{\"root\":\"!!\",\"links\":[]}"), "bad base64")
        XCTAssertFalse(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: "not json"), "not JSON")
        XCTAssertTrue(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp.uppercased(), chainJson: chainB), "fingerprint case does not matter")
        XCTAssertTrue(CodeChain.belongs(remoteId: "133687038", fingerprintHex: bFp, chainJson: chainB.replacingOccurrences(of: "{\"root\"", with: "{\"x\":1,\"root\"")), "extra fields are ignored")
    }
}

final class JsonTests: XCTestCase {
    func testParseAndWriteTheSubset() throws {
        let value = try Json.object("{\"t\":\"x\",\"n\":3,\"a\":[1,\"\\u00e4\\n\"],\"b\":true,\"z\":null}")
        XCTAssertEqual(Json.str(value, "t"), "x")
        XCTAssertEqual(Json.num(value, "n", -1), 3)
        XCTAssertEqual(Json.num(value, "missing", -1), -1)
        XCTAssertEqual(Json.write(value), "{\"a\":[1,\"ä\\n\"],\"b\":true,\"n\":3,\"t\":\"x\",\"z\":null}") // keys sorted
        XCTAssertTrue(value["z"] is NSNull)
    }

    func testStringsWithSurrogatesControlsAndQuotes() throws {
        let text = "Pixel 😀 \"q\" \\ \t\u{01}"
        let written = Json.write(["s": text] as JSONObject)
        XCTAssertEqual(written, "{\"s\":\"Pixel 😀 \\\"q\\\" \\\\ \\t\\u0001\"}")
        XCTAssertEqual(Json.str(try Json.object(written), "s"), text)
        XCTAssertEqual(Json.str(try Json.object("{\"s\":\"\\ud83d\\ude00\"}"), "s"), "😀")
    }

    func testNumbers() throws {
        XCTAssertEqual(Json.write(3.0), "3")
        XCTAssertEqual(Json.write(2.5), "2.5")
        XCTAssertEqual(Json.write(-7), "-7")
        XCTAssertEqual(Json.write(Int64(1) << 40), "1099511627776")
        XCTAssertEqual(try Json.parse("-12.5e1") as? Double, -125)
        XCTAssertEqual(Json.num(try Json.object("{\"n\":2.5}"), "n", 9), 9)
    }

    func testBadInputThrows() {
        for bad in ["", "{", "{\"a\"}", "[1,", "{\"a\":1} x", "\"abc", "{\"a\":tru}", "nul", "{1:2}", String(repeating: "[", count: 40) + String(repeating: "]", count: 40)] {
            XCTAssertThrowsError(try Json.parse(bad), "'\(bad)'")
        }
        XCTAssertThrowsError(try Json.object("[1]"))
    }

    func testSortedKeysFollowUtf16Order() {
        // "😀" (D83D …) sorts before U+FF21 in UTF-16 code unit order, unlike code point order
        XCTAssertEqual(Json.sortedKeys(["\u{FF21}", "😀", "a", "B"]), ["B", "a", "😀", "\u{FF21}"])
    }
}

final class PcLinksTests: XCTestCase {
    final class Chan { var closed = false; let name: String; init(_ n: String) { name = n } }
    private func links() -> PcLinks<Chan> { PcLinks<Chan>(closed: { $0.closed }) }

    func testNewestVersionServesAndThePageStaysPut() {
        let l = links()
        let a = Chan("a"), b = Chan("b")
        l.put("A", a, version: "0.3.9")
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: nil) === a)
        l.put("B", b, version: "0.3.10")
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: nil) === b, "a newer PC takes the page")
        l.put("A", Chan("a2"), version: "0.3.9")
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: nil) === b, "an older one does not")
        XCTAssertEqual(l.usedPc(), "B")
        XCTAssertEqual(l.usedVersion(), "0.3.10")
        XCTAssertEqual(l.live(), 2)
    }

    func testPreferredPcWinsWhileItsChannelIsUp() {
        let l = links()
        let a = Chan("a"), b = Chan("b")
        l.put("A", a, version: "0.3.9")
        l.put("B", b, version: "0.3.10")
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: "A") === a)
        a.closed = true
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: "A") === b, "its channel dropped: the page moves at once")
        XCTAssertTrue(l.usedChannel() === b)
    }

    func testRefusalMovesThePageOnceAndNeverCircles() {
        let l = links()
        let a = Chan("a"), b = Chan("b")
        l.put("A", a, version: "1.0.0")
        l.put("B", b, version: "0.9.0")
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: nil) === a)
        XCTAssertTrue(l.refuse("A"))
        XCTAssertFalse(l.refuse("A"), "news only once")
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: nil) === b)
        XCTAssertTrue(l.refuse("B"))
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: nil) === b, "every linked PC refused: the page stays")
        XCTAssertTrue(l.forgive("A"))
        XCTAssertTrue(l.pick(order: ["A", "B"], preferred: "A") === a, "the person's pick forgives")
        XCTAssertFalse(l.refuse(nil))
    }

    func testOpeningOnlyWhatIsOnlineDueAndWithinTheCap() {
        let l = links()
        let order = (0..<12).map { "pc\($0)" }
        let open = l.toOpen(order: order, online: { _ in true }, now: 0)
        XCTAssertEqual(open.count, PcLinks<Chan>.cap)
        XCTAssertEqual(l.toOpen(order: ["x"], online: { _ in false }, now: 0), [])
        l.failed("x", now: 1_000)
        XCTAssertEqual(l.toOpen(order: ["x"], online: { _ in true }, now: 1_100), [], "waits its backoff (0.5 s)")
        XCTAssertEqual(l.toOpen(order: ["x"], online: { _ in true }, now: 1_600), ["x"])
        XCTAssertEqual(l.nextRetry(now: 1_100), 400)
        l.retryNow()
        XCTAssertEqual(l.toOpen(order: ["x"], online: { _ in true }, now: 1_100), ["x"], "check() makes every failed PC due")
        l.put("x", Chan("x"), version: nil)
        XCTAssertEqual(l.toOpen(order: ["x"], online: { _ in true }, now: 9_000), [], "already linked")
    }

    func testBackoffStepsAndTheSpareMinute() {
        XCTAssertEqual((0..<7).map { PhoneConnection.backoff($0) }, [500, 1_000, 2_000, 5_000, 10_000, 10_000, 10_000])
        let l = links()
        l.put("up", Chan("up"), version: "1")
        for _ in 0..<5 { l.failed("down", now: 0) }
        XCTAssertEqual(l.nextRetry(now: 0), 10_000)
        l.failed("down", now: 0) // the sixth: another channel is up, so a minute
        XCTAssertEqual(l.nextRetry(now: 0), PcLinks<Chan>.spareMs)
    }

    func testPruneEndsChannelsOfUnpinnedPcs() {
        let l = links()
        let a = Chan("a"), b = Chan("b"), c = Chan("c")
        l.put("A", a, version: nil); l.put("B", b, version: nil); l.put("C", c, version: nil)
        c.closed = true
        let gone = l.prune(pinned: ["A"])
        XCTAssertEqual(gone.map { $0.name }, ["b"])
        XCTAssertEqual(l.all().map { $0.name }, ["a"])
    }
}

final class PcVersionTests: XCTestCase {
    func testOrder() {
        XCTAssertGreaterThan(PcVersion.compare("0.3.10", "0.3.9"), 0)
        XCTAssertGreaterThan(PcVersion.compare("0.3.9", "0.3.9-local.2"), 0)
        XCTAssertGreaterThan(PcVersion.compare("0.3.9-local.2", "0.3.9-local.1"), 0)
        XCTAssertLessThan(PcVersion.compare("0.3.9-local.1", "0.3.9"), 0)
        XCTAssertEqual(PcVersion.compare("1.0.0+build5", "1.0.0"), 0)
        XCTAssertGreaterThan(PcVersion.compare("1.0.0", nil), 0, "an unknown version is the oldest")
        XCTAssertLessThan(PcVersion.compare(nil, "0.0.1"), 0)
        XCTAssertEqual(PcVersion.compare(nil, nil), 0)
        XCTAssertGreaterThan(PcVersion.compare("0.4", "0.3.99"), 0)
    }

    func testVersionOfAnswer() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"id\":1,\"result\":{\"version\":\"0.3.20-local.4\"}}"
        XCTAssertEqual(PcVersion.versionOf(ok), "0.3.20-local.4")
        XCTAssertNil(PcVersion.versionOf("HTTP/1.1 401 Unauthorized\r\n\r\n{}"))
        XCTAssertNil(PcVersion.versionOf("HTTP/1.1 200 OK\r\n\r\n{\"result\":{\"version\":\"bad version!\"}}"))
        XCTAssertNil(PcVersion.versionOf("HTTP/1.1 200 OK\r\n\r\nnot json"))
        XCTAssertNil(PcVersion.versionOf("garbage"))
    }

    func testFetchAsksStreamZeroWithTheToken() {
        let sent = Locked([JSONObject]())
        let question = PcVersion(send: { m in sent.with { $0.append(m) } })
        let answer = "HTTP/1.1 200 OK\r\n\r\n{\"result\":{\"version\":\"2.0.1\"}}"
        spawn("answer") {
            Thread.sleep(forTimeInterval: 0.2)
            question.deliver(["t": "d", "s": 0, "b": Crypto.b64Std(Crypto.utf8(answer))] as JSONObject)
            question.deliver(["t": "e", "s": 0] as JSONObject)
        }
        XCTAssertEqual(question.fetch(token: "tok_abc", timeoutMs: 3_000), "2.0.1")
        XCTAssertEqual(sent.value.map { Json.str($0, "t") }, ["o", "d"])
        let request = Crypto.string(Crypto.fromB64Std(Json.str(sent.value[1], "b")!)!)
        XCTAssertTrue(request.hasPrefix("POST /rpc HTTP/1.1\r\n"))
        XCTAssertTrue(request.contains("Authorization: Bearer tok_abc\r\n"))
        XCTAssertTrue(request.hasSuffix("{\"id\":1,\"method\":\"system.info\"}"))
        XCTAssertTrue(PcVersion.mine(["s": 0]))
        XCTAssertFalse(PcVersion.mine(["s": 1]))
    }

    func testNoAnswerEndsTheStreamAndGivesNoVersion() {
        let sent = Locked([JSONObject]())
        let question = PcVersion(send: { m in sent.with { $0.append(m) } })
        XCTAssertNil(question.fetch(token: "t", timeoutMs: 200))
        XCTAssertEqual(sent.value.last.flatMap { Json.str($0, "t") }, "e")
    }
}

final class ConnectionAddressTests: XCTestCase {
    func testRemoteIdFromTextAndLinks() throws {
        XCTAssertEqual(try ConnectionAddress.remoteId("482 913 071"), "482913071")
        XCTAssertEqual(try ConnectionAddress.remoteId(" 482-913-071\n"), "482913071")
        XCTAssertEqual(try ConnectionAddress.remoteId("https://openautark.com/pair/#482913071"), "482913071")
        XCTAssertEqual(try ConnectionAddress.remoteId("https://metajarvis.teydralab.com/autark/pair#482913071"), "482913071")
        XCTAssertEqual(try ConnectionAddress.remoteId("autark://pair/482913071"), "482913071")
        XCTAssertThrowsError(try ConnectionAddress.remoteId("48291307"))
        XCTAssertThrowsError(try ConnectionAddress.remoteId("4829130711"))
        XCTAssertThrowsError(try ConnectionAddress.remoteId("abc"))
        XCTAssertThrowsError(try ConnectionAddress.remoteId(nil))
    }

    func testOnlyOurPairLinksOpenTheApp() {
        XCTAssertEqual(ConnectionAddress.fromLink("https://openautark.com/pair/#482913071"), "482913071")
        XCTAssertEqual(ConnectionAddress.fromLink("https://metajarvis.teydralab.com/autark/pair/#482913071"), "482913071")
        XCTAssertEqual(ConnectionAddress.fromLink("https://metajarvis.teydralab.com/autark/pair#482913071"), "482913071")
        XCTAssertEqual(ConnectionAddress.fromLink("AUTARK://pair/482913071"), "482913071")
        XCTAssertNil(ConnectionAddress.fromLink("https://evil.example/pair/#482913071"))
        XCTAssertNil(ConnectionAddress.fromLink("https://openautark.com/pair/#12"))
        XCTAssertNil(ConnectionAddress.fromLink("https://openautark.com/other"))
        XCTAssertNil(ConnectionAddress.fromLink(nil))
    }

    func testScannedQr() {
        XCTAssertEqual(ConnectionAddress.scanned("482 913 071"), "482913071")
        XCTAssertEqual(ConnectionAddress.scanned("https://openautark.com/pair/#482913071"), "482913071")
        XCTAssertNil(ConnectionAddress.scanned("https://example.com"))
        XCTAssertNil(ConnectionAddress.scanned("WIFI:T:WPA;S:x;;"))
        XCTAssertNil(ConnectionAddress.scanned(""))
        XCTAssertNil(ConnectionAddress.scanned("12345"))
    }

    func testSameOrigin() {
        XCTAssertTrue(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://127.0.0.1:47920/#/chat/1"))
        XCTAssertFalse(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://127.0.0.1:47921/"))
        XCTAssertFalse(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "https://127.0.0.1:47920/"))
        XCTAssertFalse(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "http://user@127.0.0.1:47920/"))
        XCTAssertFalse(ConnectionAddress.sameOrigin("http://127.0.0.1:47920", "autark-app:forget"))
        XCTAssertFalse(ConnectionAddress.sameOrigin(nil, "http://127.0.0.1:47920"))
        XCTAssertTrue(ConnectionAddress.sameOrigin("https://example.com", "https://EXAMPLE.com:443/x"))
        XCTAssertEqual(ConnectionAddress.defaultRelay, "wss://telecoding-relay.onrender.com/autark")
    }
}

final class CompaniesTests: XCTestCase {
    private func paired(_ fp: Character, name: String = "PC") -> Paired {
        let pub = Crypto.ed25519Public(seed: Bytes(repeating: UInt8(String(fp).unicodeScalars.first!.value), count: 32))
        return Paired(relay: ConnectionAddress.defaultRelay, seed: Crypto.b64url(Crypto.newSeed()), deviceId: "dev_\(fp)", token: "tok\(fp)",
                      pcs: [Pc(fingerprint: Crypto.fingerprint(pub), publicKey: Crypto.b64url(pub), name: name, deviceId: "dev_pc\(fp)")])
    }

    func testEachCompanyGetsItsOwnFixedPort() {
        let store = MemoryStore()
        let c = Companies(store: store)
        XCTAssertNil(c.currentPaired)
        XCTAssertEqual(c.port, 47920)
        XCTAssertEqual(c.add(paired("a")), "c1")
        XCTAssertEqual(c.port, 47920)
        XCTAssertEqual(c.add(paired("b")), "c2")
        XCTAssertEqual(c.port, 47921)
        XCTAssertEqual(c.currentId, "c2")
        XCTAssertEqual(c.count, 2)
        XCTAssertTrue(c.setCurrent("c1"))
        XCTAssertEqual(c.port, 47920)
        XCTAssertFalse(c.setCurrent("nope"))
        // ports are never reused after a company is removed
        XCTAssertEqual(c.remove("c1"), "c2")
        XCTAssertEqual(c.add(paired("c")), "c3")
        XCTAssertEqual(c.port, 47922)
    }

    func testPairingAgainWithAKnownPcReplacesThatCompanysKeys() {
        let c = Companies(store: MemoryStore())
        c.add(paired("a"))
        c.setCard(name: "Teydra Lab", avatar: "data:image/png;base64,AAAA")
        let again = paired("a")
        XCTAssertEqual(c.add(again), "c1")
        XCTAssertEqual(c.count, 1)
        XCTAssertEqual(c.currentPaired?.token, "toka")
        XCTAssertEqual(c.currentPaired?.seed, again.seed)
        let list = try! Json.parse(c.listJson(pcName: "PC")) as! [Any]
        XCTAssertEqual(Json.str(list[0] as! JSONObject, "name"), "Teydra Lab", "name and picture stay")
    }

    func testStateSurvivesARestartAndNeverShowsSecrets() {
        let store = MemoryStore()
        let c = Companies(store: store)
        c.add(paired("a", name: "Büro"))
        c.add(paired("b", name: "Home"))
        c.setCurrent("c1")
        let c2 = Companies(store: store)
        XCTAssertEqual(c2.currentId, "c1")
        XCTAssertEqual(c2.count, 2)
        XCTAssertEqual(c2.currentPaired?.pcs.first?.name, "Büro")
        XCTAssertEqual(c2.add(paired("c")), "c3", "the counter survives too")
        let shown = c2.listJson(pcName: "Büro")
        XCTAssertFalse(shown.contains("seed"))
        XCTAssertFalse(shown.contains("token"))
        let list = try! Json.parse(shown) as! [Any]
        XCTAssertEqual(list.count, 3)
        XCTAssertEqual(Json.str(list[0] as! JSONObject, "name"), "Büro", "without a card the company is named after its first PC")
    }

    func testCardLimitsAndRemoval() {
        let c = Companies(store: MemoryStore())
        c.add(paired("a"))
        c.setCard(name: String(repeating: "x", count: 200), avatar: "http://not-an-image")
        var list = try! Json.parse(c.listJson(pcName: nil)) as! [Any]
        XCTAssertEqual((Json.str(list[0] as! JSONObject, "name") ?? "").count, 80)
        XCTAssertNil((list[0] as! JSONObject)["avatar"])
        c.setCard(name: "x", avatar: "data:image/png;base64," + String(repeating: "A", count: 20_000))
        list = try! Json.parse(c.listJson(pcName: nil)) as! [Any]
        XCTAssertNil((list[0] as! JSONObject)["avatar"], "over 16 KB: none")
        XCTAssertNil(c.remove("c1"))
        XCTAssertNil(c.currentPaired)
        XCTAssertEqual(c.count, 0)
    }
}

final class CssColorTests: XCTestCase {
    func testParse() {
        XCTAssertEqual(CssColor.parse("#202020", fallback: 1), 0xFF202020)
        XCTAssertEqual(CssColor.parse("#FFF", fallback: 1), 0xFFFFFFFF)
        XCTAssertEqual(CssColor.parse("rgb(32, 32, 32)", fallback: 1), 0xFF202020)
        XCTAssertEqual(CssColor.parse("rgba(255 0 128 / 0.5)", fallback: 1), 0xFFFF0080)
        XCTAssertEqual(CssColor.parse("rgba(0, 0, 0, 0)", fallback: 7), 7, "transparent: the fallback")
        XCTAssertEqual(CssColor.parse("transparent", fallback: 7), 7)
        XCTAssertEqual(CssColor.parse("#12", fallback: 7), 7)
        XCTAssertEqual(CssColor.parse(nil, fallback: 7), 7)
        XCTAssertEqual(CssColor.parse("rgb(300, -5, 12.6)", fallback: 7), 0xFFFF000D)
    }

    func testLight() {
        XCTAssertTrue(CssColor.isLight(0xFFF3F3F3))
        XCTAssertFalse(CssColor.isLight(0xFF202020))
    }
}
