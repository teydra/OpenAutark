// Owns: the phone's direct way to a PC (F29) in this process, as Android's DirectRouteTest.java and ReconnectTest.java run it on a host
// JVM – a PC's addresses become ws(s)://…/peer/phone and survive storage; Route takes the first direct pipe that opens and closes the
// late ones; it falls back to the tunnel when no address answers, when the handshake over the direct pipe fails (another device on that
// address) or when the PC lists none; the real pinned handshake and encrypted frames run over DirectPipe against a stand-in of the PC's
// /peer/phone and the tunnel is never opened then; a PhoneConnection goes direct, falls back, upgrades a tunnel after check(), learns the
// PC's addresses from its phone.pcs answer and replaces a direct socket that stopped answering. The PC and the meeting server are
// stand-ins (TestSupport, DirectSupport); a real network, router, Wi-Fi or tailnet is not involved.
import XCTest
@testable import AutarkCore

final class DirectUrlTests: XCTestCase {
    func testUrlsOfAddresses() {
        XCTAssertEqual(DirectPipe.url("http://192.168.1.20:47812"), "ws://192.168.1.20:47812/peer/phone")
        XCTAssertEqual(DirectPipe.url("https://desk.tail1234.ts.net/"), "wss://desk.tail1234.ts.net/peer/phone")
        XCTAssertEqual(DirectPipe.url("HTTP://Desk.local:47812"), "ws://Desk.local:47812/peer/phone")
        XCTAssertEqual(DirectPipe.url("http://[2001:db8::7]:47812"), "ws://[2001:db8::7]:47812/peer/phone")
        XCTAssertEqual(DirectPipe.url("http://100.64.0.7"), "ws://100.64.0.7/peer/phone")
        XCTAssertNil(DirectPipe.url("relay:abc"))
        XCTAssertNil(DirectPipe.url("ftp://h:1"))
        XCTAssertNil(DirectPipe.url("http://u:p@h:1"))
        XCTAssertNil(DirectPipe.url("http://h:99999"))
        XCTAssertNil(DirectPipe.url("http://h:12x"))
        XCTAssertNil(DirectPipe.url("http://"))
        XCTAssertNil(DirectPipe.url("http://[::1"))
        XCTAssertNil(DirectPipe.url("http://a b:1"))
        XCTAssertNil(DirectPipe.url("http://" + String(repeating: "a", count: 300)))
        XCTAssertNil(DirectPipe.url(nil))
    }

    /// The addresses of a PC are kept with it (storage JSON) – at most 8 usable ones, in the PC's order.
    func testStoredAddresses() throws {
        let pub = Crypto.ed25519Public(seed: Crypto.newSeed())
        var given: [Any] = ["http://203.0.113.7:47812", "http://192.168.1.20:47812", "relay:abc", "http://192.168.1.20:47812"]
        for i in 0..<10 { given.append("http://10.0.0.\(i):47812") }
        let row: JSONObject = ["fingerprint": Crypto.fingerprint(pub), "publicKey": Crypto.b64url(pub), "name": "Desk", "deviceId": "dev_desk", "addresses": given]
        let pcs = Paired.pcsOf([row])
        XCTAssertEqual(pcs.count, 1)
        XCTAssertEqual(pcs[0].addresses.count, 8, "at most 8, invalid and repeated ones skipped")
        XCTAssertEqual(pcs[0].addresses.first, "http://203.0.113.7:47812")
        XCTAssertFalse(pcs[0].addresses.contains("relay:abc"))
        let paired = Paired(relay: "wss://relay.test", seed: Crypto.b64url(Crypto.newSeed()), deviceId: "dev_phone", token: "token", pcs: pcs)
        XCTAssertEqual(Paired.pcsOf(try Json.parse(paired.pcsJson))[0].addresses, pcs[0].addresses, "the addresses survive storage")
        let old = Paired.pcsOf([["fingerprint": Crypto.fingerprint(pub), "publicKey": Crypto.b64url(pub), "name": "Desk"] as JSONObject])[0]
        XCTAssertTrue(old.addresses.isEmpty)
        XCTAssertFalse(Paired(relay: "r", seed: "s", deviceId: "d", token: "t", pcs: [old]).pcsJson.contains("addresses"), "a PC without addresses stays as it was stored")
    }
}

final class RouteTests: XCTestCase {
    private func after(_ ms: Int, _ pipe: LinkPipe) -> Route.Opener { { Thread.sleep(forTimeInterval: Double(ms) / 1000); return pipe } }
    private func failing(_ ms: Int) -> Route.Opener { { Thread.sleep(forTimeInterval: Double(ms) / 1000); throw AutarkError("refused") } }

    /// The first pipe that opens wins; a slower one is closed when it opens; a failing one does not matter.
    func testTheFirstThatOpensWins() {
        let slow = FakePipe("slow", direct: true), fast = FakePipe("fast", direct: true)
        let start = Date()
        let won = Route.first([after(800, slow), after(20, fast), failing(5)], windowMs: 3_000)
        XCTAssertTrue(won === fast, "the first pipe that opens wins")
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.7, "at once, not after the slow one")
        eventually(5, "the later pipe closed as it opened") { slow.isClosed }
        XCTAssertFalse(fast.isClosed)
        let all = Date()
        XCTAssertNil(Route.first([failing(5), failing(10)], windowMs: 3_000))
        XCTAssertLessThan(Date().timeIntervalSince(all), 1.5, "every address failing ends the wait at once")
    }

    /// Nothing within the window: nil after the window; a pipe opening later is closed.
    func testNothingWithinTheWindow() {
        let late = FakePipe("late", direct: true)
        let start = Date()
        XCTAssertNil(Route.first([after(900, late)], windowMs: 200))
        let took = Date().timeIntervalSince(start)
        XCTAssertGreaterThanOrEqual(took, 0.19)
        XCTAssertLessThan(took, 0.8)
        eventually(5, "a pipe opening after the window is closed") { late.isClosed }
    }

    func testFallsBackToTheTunnel() throws {
        let tunnels = Locked(0)
        let tunnel: Route.Opener = { tunnels.with { $0 += 1 }; return FakePipe("tunnel", direct: false) }
        let named: (LinkPipe) throws -> String = { ($0 as! FakePipe).name }
        XCTAssertEqual(try Route.open(direct: [after(10, FakePipe("direct", direct: true))], windowMs: 500, tunnel: tunnel, handshake: named), "direct")
        XCTAssertEqual(tunnels.value, 0, "a direct address that answers is used, the tunnel never opened")
        XCTAssertEqual(try Route.open(direct: [failing(5)], windowMs: 500, tunnel: tunnel, handshake: named), "tunnel")
        XCTAssertEqual(tunnels.value, 1, "no direct answer: the tunnel")
        let stranger = FakePipe("stranger", direct: true)
        let refusing: (LinkPipe) throws -> String = { pipe in if pipe.direct { throw AutarkError("This is not the paired PC.") }; return (pipe as! FakePipe).name }
        XCTAssertEqual(try Route.open(direct: [after(5, stranger)], windowMs: 500, tunnel: tunnel, handshake: refusing), "tunnel")
        XCTAssertTrue(stranger.isClosed)
        XCTAssertEqual(tunnels.value, 2, "a failed handshake on the direct pipe closes it and takes the tunnel")
        XCTAssertEqual(try Route.open(direct: [], windowMs: 500, tunnel: tunnel, handshake: named), "tunnel")
        XCTAssertEqual(tunnels.value, 3, "a PC without addresses: the tunnel at once")
        XCTAssertThrowsError(try Route.open(direct: [failing(5)], windowMs: 300, tunnel: nil, handshake: named)) // direct only (the upgrade after a resume)
        XCTAssertEqual(tunnels.value, 3, "direct only throws and opens no tunnel")
        XCTAssertThrowsError(try Route.open(direct: [after(5, FakePipe("x", direct: true))], windowMs: 300, tunnel: nil, handshake: { (_: LinkPipe) throws -> String in throw AutarkError("handshake failed") })) {
            XCTAssertEqual(($0 as? AutarkError)?.message, "handshake failed", "direct only reports why the handshake failed")
        }
    }
}

final class DirectPipeTests: XCTestCase {
    /// The real handshake and encrypted frames run over DirectPipe against a stand-in of the PC's /peer/phone; the tunnel stays shut.
    func testTheHandshakeAndFramesRunOverTheDirectPipe() throws {
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        let direct = FakeDirect()
        direct.host("127.0.0.1:47812", pc: pc)
        let tunnels = Locked(0)
        let messages = BlockingQueue<JSONObject>()
        final class Listener: PeerListener {
            let messages: BlockingQueue<JSONObject>
            let closedFuture = Future<Bool>()
            init(_ messages: BlockingQueue<JSONObject>) { self.messages = messages }
            func message(_ message: JSONObject) { messages.offer(message) }
            func closed() { closedFuture.complete(true) }
        }
        let listener = Listener(messages)
        let seed = Bytes(repeating: 0x11, count: 32)
        let openers = DirectPipe.openers(["http://127.0.0.1:1", "http://127.0.0.1:47812"], connector: direct)
        XCTAssertEqual(openers.count, 2)
        let channel = try Route.open(direct: openers, windowMs: Route.directMs, tunnel: { tunnels.with { $0 += 1 }; throw AutarkError("no tunnel in this test") }) { pipe in
            try PeerChannel.connect(tunnel: pipe, seed: seed, deviceId: "dev_phone", pcPublicKey: pc.publicKey, listener: listener)
        }
        XCTAssertTrue(channel.direct)
        XCTAssertEqual(tunnels.value, 0, "the handshake ran over the direct pipe, no tunnel opened")
        XCTAssertEqual(direct.options.last, DirectPipe.options, "a short connect and 8 MiB frames")
        XCTAssertEqual(DirectPipe.options.connectTimeoutMs, 1_500)
        XCTAssertEqual(DirectPipe.options.maxMessage, 8 * 1024 * 1024 + 1024)
        let peer = direct.peers[0]
        XCTAssertEqual(try peer.authenticated.get(timeout: 5), true, "the PC saw the phone's key and its signed auth")
        // a request through the channel reaches the PC's stream server and its answer comes back encrypted
        channel.send(["t": "o", "s": 1] as JSONObject)
        channel.send(["t": "d", "s": 1, "b": Crypto.b64Std(Crypto.utf8("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))] as JSONObject)
        var got = Bytes()
        while let message = messages.poll(timeout: 5) {
            if Json.str(message, "t") == "d", let b = Json.str(message, "b"), let data = Crypto.fromB64Std(b) { got.append(contentsOf: data) }
            if Json.str(message, "t") == "e" { break }
        }
        XCTAssertTrue(Crypto.string(got).contains("Autark phone UI"), Crypto.string(got))
        peer.close()
        XCTAssertEqual(try listener.closedFuture.get(timeout: 5), true, "the PC closing the socket closes the channel")
        XCTAssertTrue(channel.isClosed)
    }

    func testAnotherKeyOnTheAddressFailsTheHandshake() {
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        let direct = FakeDirect()
        direct.host("192.168.1.20:47812", pc: pc, impostorSeed: Bytes(repeating: 0x77, count: 32))
        XCTAssertThrowsError(try Route.open(direct: DirectPipe.openers(["http://192.168.1.20:47812"], connector: direct), windowMs: 1_500, tunnel: nil) { pipe in
            try PeerChannel.connect(tunnel: pipe, seed: Bytes(repeating: 0x11, count: 32), deviceId: "dev_phone", pcPublicKey: pc.publicKey, listener: nil)
        }) { XCTAssertEqual(($0 as? AutarkError)?.message, "This is not the paired PC.") }
    }

    func testARefusedAddressFailsFastAndASilentOneWithinTheWindow() {
        let direct = FakeDirect()
        let started = Date()
        XCTAssertNil(Route.first(DirectPipe.openers(["http://127.0.0.1:9"], connector: direct), windowMs: 1_500))
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0, "a closed port fails at once")
        direct.failDelay = 3
        let silent = Date()
        XCTAssertNil(Route.first(DirectPipe.openers(["http://127.0.0.1:9"], connector: direct), windowMs: 400))
        XCTAssertLessThan(Date().timeIntervalSince(silent), 1.5, "a silent address costs the window, not its own timeout")
    }

    func testQuietSocketIsPingedAndADeadOneEnds() throws {
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        let direct = FakeDirect()
        direct.host("192.168.1.20:47812", pc: pc)
        let pipe = try DirectPipe.open(url: "ws://192.168.1.20:47812/peer/phone", connector: direct)
        let socket = direct.sockets[0]
        final class Sink: PipeListener { var heardClosed = false; func message(_ data: Bytes, text: Bool) {}; func closed() { heardClosed = true } }
        let sink = Sink()
        pipe.listen(sink)
        pipe.checkAlive()
        XCTAssertEqual(socket.pings, 0, "a socket that was heard of lately is not pinged")
        socket.backdate(40)
        pipe.checkAlive()
        XCTAssertEqual(socket.pings, 1, "after 25 s of quiet checkAlive pings (URLSession hides the PC's own pings)")
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertFalse(pipe.isClosed, "a socket that answers stays")
        socket.answerPings = false
        pipe.probe()
        eventually(6, "a probe on a socket that does not answer ends it within seconds") { pipe.isClosed }
        eventually(3, "the listener heard it") { sink.heardClosed }
    }
}

final class DirectConnectionTests: XCTestCase {
    private struct Rig {
        let relay: FakeRelay
        let direct: FakeDirect
        let pc: FakeRelay.Pc
        let paired: Paired
        let connector: CombinedConnector
    }

    private let address = "http://192.168.1.20:47812"
    private let hosted = "192.168.1.20:47812"

    private func rig(addresses: [String]) -> Rig {
        let relay = FakeRelay()
        let direct = FakeDirect()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        let seed = Bytes(repeating: 0x11, count: 32)
        pc.peers.insert(Crypto.fingerprint(Crypto.ed25519Public(seed: seed))) // the PC pinned the phone when the person accepted
        relay.addPc(pc)
        let paired = Paired(relay: "wss://relay.test/autark", seed: Crypto.b64url(seed), deviceId: "dev_phoneaccepted0001", token: "tok_direct",
                            pcs: [Pc(fingerprint: pc.fingerprint, publicKey: Crypto.b64url(pc.publicKey), name: "Studio PC", deviceId: "dev_fakepc0000000001", addresses: addresses)])
        return Rig(relay: relay, direct: direct, pc: pc, paired: paired, connector: CombinedConnector(relay: relay, direct: direct))
    }

    private func start(_ r: Rig) throws -> (PhoneConnection, Locked<[String]>, String) {
        let statuses = Locked([String]())
        let connection = PhoneConnection(paired: r.paired, connector: r.connector, status: { text, connected in statuses.with { $0.append((connected ? "+" : "-") + text) } })
        connection.channelWaitMs = 1_500
        let origin = try connection.start(port: 0, gate: "gate-secret")
        return (connection, statuses, origin)
    }

    private func get(_ origin: String, _ path: String = "/") -> String? {
        let port = Int(origin.split(separator: ":").last!)!
        guard let client = TcpConnection.connect(port: port) else { return nil }
        client.write(Crypto.utf8("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: autark_gate=gate-secret\r\nConnection: close\r\n\r\n"))
        var all = Bytes()
        while let part = client.read(max: 64 * 1024, timeoutSeconds: 10) { all.append(contentsOf: part) }
        return String(decoding: all, as: UTF8.self)
    }

    func testTheDirectAddressServesAndTheTunnelIsNeverOpened() throws {
        let r = rig(addresses: [address])
        r.direct.host(hosted, pc: r.pc)
        let (connection, statuses, origin) = try start(r)
        defer { connection.stop() }
        eventually(10, "connected directly") { statuses.value.contains("+Connected to Studio PC directly.") }
        XCTAssertEqual(r.relay.peers.count, 0, "no tunnel was opened for the PC")
        XCTAssertEqual(connection.version, "0.9.9", "the version request ran over the direct channel")
        XCTAssertEqual(connection.pc, r.pc.fingerprint)
        let page = get(origin)
        XCTAssertTrue(page?.contains("Autark phone UI") == true, page ?? "nil")
        XCTAssertEqual(r.direct.peers.count, 1)
        XCTAssertTrue(r.direct.streams[0].requestHeads.contains { $0.contains("Authorization: Bearer tok_direct") }, "the token went to the PC over the direct socket")
    }

    func testWithoutAnAnswerTheTunnelServes() throws {
        let r = rig(addresses: [address])
        let (connection, statuses, origin) = try start(r)
        defer { connection.stop() }
        eventually(10, "connected through the tunnel") { statuses.value.contains("+Connected to Studio PC.") }
        XCTAssertTrue(r.direct.attempts.contains("ws://192.168.1.20:47812/peer/phone"), "the address was tried first")
        XCTAssertEqual(r.relay.peers.count, 1)
        XCTAssertFalse(statuses.value.contains { $0.contains("directly") })
        XCTAssertTrue(get(origin)?.contains("Autark phone UI") == true)
    }

    func testAnotherDeviceOnTheAddressIsRefusedAndTheTunnelServes() throws {
        let r = rig(addresses: [address])
        r.direct.host(hosted, pc: r.pc, impostorSeed: Bytes(repeating: 0x77, count: 32)) // someone else's PC at the old address
        let (connection, statuses, origin) = try start(r)
        defer { connection.stop() }
        eventually(10, "connected through the tunnel") { statuses.value.contains("+Connected to Studio PC.") }
        XCTAssertEqual(r.direct.peers.count, 1, "the impostor was tried (and failed the pinned handshake)")
        XCTAssertEqual(r.relay.peers.count, 1)
        XCTAssertTrue(get(origin)?.contains("Autark phone UI") == true)
    }

    func testCheckMovesAPageOnTheTunnelToTheDirectChannel() throws {
        let r = rig(addresses: [address])
        let (connection, statuses, origin) = try start(r)
        defer { connection.stop() }
        let linked = Locked(0)
        connection.onLinked { linked.with { $0 += 1 } }
        eventually(10, "connected through the tunnel") { statuses.value.contains("+Connected to Studio PC.") }
        let before = linked.value
        r.direct.host(hosted, pc: r.pc) // home Wi-Fi came back
        connection.check() // the app came forward
        eventually(10, "moved to the direct channel") { statuses.value.contains("+Connected to Studio PC directly.") }
        eventually(5, "the page heard of the new channel") { linked.value > before }
        eventually(5, "the old tunnel ended") { r.relay.peers[0].pipe.isClosed }
        XCTAssertEqual(connection.linkedCount, 1, "one pipe per PC: the direct socket replaced the tunnel")
        eventually(10, "the page is served over the direct channel") { self.get(origin)?.contains("Autark phone UI") == true }
        XCTAssertGreaterThanOrEqual(r.direct.streams[0].requestHeads.count, 1)
    }

    func testThePcListGivesTheAddressesAndTheConnectionGoesDirectByItself() throws {
        let r = rig(addresses: []) // paired before this PC had any address
        r.direct.host(hosted, pc: r.pc)
        r.relay.phonePcs = [["deviceId": "dev_fakepc0000000001", "name": "Studio PC", "fingerprint": r.pc.fingerprint, "publicKey": Crypto.b64url(r.pc.publicKey), "addresses": [address] as [Any]] as JSONObject]
        let kept = Locked([[Pc]]())
        let statuses = Locked([String]())
        let connection = PhoneConnection(paired: r.paired, connector: r.connector, status: { text, connected in statuses.with { $0.append((connected ? "+" : "-") + text) } })
        connection.onPcsChanged { pcs in kept.with { $0.append(pcs) } }
        connection.channelWaitMs = 1_500
        _ = try connection.start(port: 0, gate: "gate-secret")
        defer { connection.stop() }
        eventually(10, "connected through the tunnel first") { statuses.value.contains("+Connected to Studio PC.") }
        eventually(15, "then directly, learned from the PC's own list") { statuses.value.contains("+Connected to Studio PC directly.") }
        XCTAssertEqual(r.relay.streams[0].phonePcsAsked, 1, "the PC was asked for its list once")
        XCTAssertEqual(kept.value.last?.first?.addresses, [address], "the caller stores the list with its addresses")
        XCTAssertEqual(connection.pcs.first?.addresses, [address])
        XCTAssertEqual(connection.linkedCount, 1)
    }

    func testAnOlderPcWithoutPhonePcsChangesNothing() throws {
        let r = rig(addresses: [])
        r.relay.phonePcs = nil // answers 400 "Unknown method."
        let (connection, statuses, origin) = try start(r)
        defer { connection.stop() }
        eventually(10, "connected through the tunnel") { statuses.value.contains("+Connected to Studio PC.") }
        eventually(10, "the list was asked") { r.relay.streams.first?.phonePcsAsked == 1 }
        XCTAssertTrue(connection.pcs[0].addresses.isEmpty)
        XCTAssertTrue(get(origin)?.contains("Autark phone UI") == true, "the page is served as before")
    }

    func testADirectSocketThatStoppedAnsweringIsReplaced() throws {
        let r = rig(addresses: [address])
        r.direct.host(hosted, pc: r.pc)
        let (connection, statuses, origin) = try start(r)
        defer { connection.stop() }
        eventually(10, "connected directly") { statuses.value.contains("+Connected to Studio PC directly.") }
        r.direct.sockets[0].answerPings = false // Wi-Fi gone silently
        connection.check()
        eventually(15, "the dead socket was found and a new direct channel made") { r.direct.sockets.count >= 2 && connection.linkedCount == 1 && connection.pc != nil }
        eventually(10, "the page is served again") { self.get(origin)?.contains("Autark phone UI") == true }
    }
}

final class PcListTests: XCTestCase {
    private func pc(_ seedByte: UInt8, name: String, addresses: [String] = []) -> Pc {
        let pub = Crypto.ed25519Public(seed: Bytes(repeating: seedByte, count: 32))
        return Pc(fingerprint: Crypto.fingerprint(pub), publicKey: Crypto.b64url(pub), name: name, deviceId: "dev_\(name)", addresses: addresses)
    }

    private func row(_ pc: Pc) -> JSONObject {
        ["deviceId": pc.deviceId, "name": pc.name, "fingerprint": pc.fingerprint, "publicKey": pc.publicKey, "addresses": pc.addresses as [Any]]
    }

    private func http(_ body: String, status: String = "200 OK") -> String { "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)" }

    func testTheAnswerIsParsedAndEachRowChecked() {
        let a = pc(1, name: "Desk", addresses: ["http://192.168.1.20:47812", "relay:x"])
        var forged = row(pc(2, name: "Laptop"))
        forged["fingerprint"] = String(repeating: "a", count: 64) // not the hash of its key
        let body = Json.write(["id": 1, "result": ["pcs": [row(a), forged] as [Any]] as JSONObject] as JSONObject)
        let told = PcList.pcsOf(http(body))
        XCTAssertEqual(told?.count, 1, "a row whose fingerprint is not the hash of its key is dropped")
        XCTAssertEqual(told?[0].addresses, ["http://192.168.1.20:47812"], "only addresses the direct way can dial")
        XCTAssertNil(PcList.pcsOf(http("{\"id\":1,\"error\":{\"code\":\"bad_request\"}}", status: "400 Bad Request")))
        XCTAssertNil(PcList.pcsOf(http("{\"id\":1,\"result\":{\"pcs\":[]}}")))
        XCTAssertNil(PcList.pcsOf("garbage"))
    }

    func testFetchSendsTheBearerRequestOnItsOwnStreamAndReadsTheAnswer() throws {
        let a = pc(1, name: "Desk", addresses: ["http://192.168.1.20:47812"])
        let messages = Locked([JSONObject]())
        let question = PcList(send: { message in messages.with { $0.append(message) } })
        let answer = Crypto.utf8(http(Json.write(["id": 1, "result": ["pcs": [row(a)] as [Any]] as JSONObject] as JSONObject)))
        spawn("pc-list-answer") {
            eventually(5, "request sent") { messages.value.count >= 2 }
            question.deliver(["t": "d", "s": PcList.stream, "b": Crypto.b64Std(answer)] as JSONObject)
            question.deliver(["t": "e", "s": PcList.stream] as JSONObject)
        }
        let told = question.fetch(token: "tok_x", timeoutMs: 5_000)
        XCTAssertEqual(told?.count, 1)
        XCTAssertEqual(messages.value[0]["t"] as? String, "o")
        XCTAssertEqual(Json.num(messages.value[0], "s", -1), PcList.stream)
        let request = Crypto.string(Crypto.fromB64Std(Json.str(messages.value[1], "b") ?? "") ?? Bytes())
        XCTAssertTrue(request.hasPrefix("POST /rpc HTTP/1.1\r\n"))
        XCTAssertTrue(request.contains("Authorization: Bearer tok_x\r\n"))
        XCTAssertTrue(request.hasSuffix("{\"id\":1,\"method\":\"phone.pcs\"}"))
        XCTAssertTrue(PcList.mine(["s": PcList.stream]))
        XCTAssertFalse(PcList.mine(["s": 0]), "the version request's stream is another one")
        XCTAssertFalse(PcList.mine(["s": 1]))
    }

    func testAnUnansweredRequestEndsItsStream() {
        let messages = Locked([JSONObject]())
        let question = PcList(send: { message in messages.with { $0.append(message) } })
        XCTAssertNil(question.fetch(token: "tok", timeoutMs: 200))
        XCTAssertEqual(messages.value.last?["t"] as? String, "e", "the PC is told to let go of the stream")
    }

    func testMergingKeepsTheReachedPcAndTheOrderAndAddsNewOnes() {
        let desk = pc(1, name: "Desk"), laptop = pc(2, name: "Laptop"), studio = pc(3, name: "Studio")
        let deskNow = pc(1, name: "Desk", addresses: ["http://192.168.1.20:47812"])
        // the PC told: Desk (now with an address) and Studio (new); Laptop is gone from its list
        let merged = PcList.merged(known: [laptop, desk], told: [deskNow, studio], reached: desk.fingerprint)
        XCTAssertEqual(merged.map { $0.name }, ["Desk", "Studio"], "Laptop was removed on the PC; the phone's order is kept, new ones follow")
        XCTAssertEqual(merged[0].addresses, ["http://192.168.1.20:47812"])
        // the reached PC stays even when its own list leaves it out
        let kept = PcList.merged(known: [desk], told: [studio], reached: desk.fingerprint)
        XCTAssertEqual(kept.map { $0.name }, ["Desk", "Studio"])
        // a name the phone has is kept; "PC" (unknown) takes the PC's name
        let unnamed = Pc(fingerprint: desk.fingerprint, publicKey: desk.publicKey, name: nil, deviceId: nil)
        XCTAssertEqual(PcList.merged(known: [unnamed], told: [deskNow], reached: desk.fingerprint)[0].name, "Desk")
        XCTAssertEqual(PcList.merged(known: [laptop], told: [pc(2, name: "Renamed")], reached: laptop.fingerprint)[0].name, "Laptop")
    }
}
