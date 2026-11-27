// Owns: the phone's whole path in this process – pairing through a meeting server (RelayLink, PhonePairing, RemotePair), then
// PhoneConnection holding a tunnel and a peer channel to the PC and the local entrance serving the page through them, and
// what happens when the server, the PC or the link goes away. The meeting server and the PC are stand-ins written from the
// desktop sources (TestSupport); what only a real PC, relay and device can prove is listed in apps/ios/README.md.
import XCTest
@testable import AutarkCore

final class RelayLinkTests: XCTestCase {
    func testRegistersAndSeesAPinnedPcOnline() throws {
        let relay = FakeRelay()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        let phoneSeed = Bytes(repeating: 0x11, count: 32)
        let phoneFp = Crypto.fingerprint(Crypto.ed25519Public(seed: phoneSeed))
        pc.peers.insert(phoneFp)
        relay.addPc(pc)
        final class Events: RelayEvents {
            var presence = [Bool](), downs = [String]()
            func presence(online: Bool) { presence.append(online) }
            func down(reason: String) { downs.append(reason) }
        }
        let events = Events()
        let link = RelayLink(seed: phoneSeed, pins: [(pc.fingerprint, pc.publicKey)], connector: relay, events: events)
        try link.connect(url: "wss://relay.test/autark")
        XCTAssertTrue(link.isUp)
        XCTAssertTrue(link.online(pc.fingerprint))
        XCTAssertTrue(link.pcOnline)
        XCTAssertFalse(link.online(String(repeating: "0", count: 64)))
        XCTAssertEqual(link.fingerprint, phoneFp)
        relay.removePcOnline(pc)
        eventually(3, "presence off") { !link.online(pc.fingerprint) }
        XCTAssertEqual(events.presence, [true, false])
        link.close()
        eventually(3, "link down") { !link.isUp }
    }

    func testAPresenceFromAPcThatIsNotPinnedOrWithAForgedBoxIsIgnored() throws {
        let relay = FakeRelay()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        let other = FakeRelay.Pc(seed: Bytes(repeating: 0x23, count: 32))
        let phoneSeed = Bytes(repeating: 0x11, count: 32)
        let phoneFp = Crypto.fingerprint(Crypto.ed25519Public(seed: phoneSeed))
        pc.peers.insert(phoneFp)
        other.peers.insert(phoneFp)
        let link = RelayLink(seed: phoneSeed, pins: [(pc.fingerprint, pc.publicKey)], connector: relay, events: nil)
        try link.connect(url: "wss://relay.test/autark")
        XCTAssertFalse(link.online(pc.fingerprint))
        relay.pcCameOnline(other) // not pinned
        // a pinned PC whose box is signed by another key
        let forged = ["t": "presence", "fp": pc.fingerprint, "box": pc.boxPub, "boxSig": Crypto.b64url(Crypto.sign(seed: Bytes(repeating: 9, count: 32), message: Crypto.utf8("wf-relay-v1|box|" + pc.boxPub))), "online": true] as JSONObject
        link.text(Json.write(forged))
        XCTAssertFalse(link.online(pc.fingerprint))
        XCTAssertFalse(link.online(other.fingerprint))
        relay.pcCameOnline(pc)
        eventually(3, "genuine presence") { link.online(pc.fingerprint) }
        link.close()
    }

    func testFindChecksTheKeyAgainstTheRemoteId() throws {
        let relay = FakeRelay()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        relay.addPc(pc)
        let link = RelayLink(seed: Bytes(repeating: 0x11, count: 32), pins: [], connector: relay, events: nil)
        try link.connect(url: "wss://relay.test/autark")
        let found = try link.find(remoteId: pc.remoteId)
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].fingerprint, pc.fingerprint)
        XCTAssertEqual(found[0].box, pc.boxPub)
        XCTAssertEqual(try link.find(remoteId: "123456782").count, 0)
        link.close()
    }

    func testTheServerNotAnsweringFailsConnect() {
        let relay = FakeRelay()
        relay.down = true
        let link = RelayLink(seed: Bytes(repeating: 0x11, count: 32), pins: [], connector: relay, events: nil)
        XCTAssertThrowsError(try link.connect(url: "wss://relay.test/autark"))
        XCTAssertFalse(link.isUp)
    }

    func testProbeKillsAConnectionThatDoesNotAnswerAndSparesOneThatDoes() throws {
        let relay = FakeRelay()
        let link = RelayLink(seed: Bytes(repeating: 0x11, count: 32), pins: [], connector: relay, events: nil)
        try link.connect(url: "wss://relay.test/autark")
        link.probe()
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertTrue(link.isUp, "an answering server stays")
        let silent = RelayLink(seed: Bytes(repeating: 0x12, count: 32), pins: [], connector: relay, events: nil)
        try silent.connect(url: "wss://relay.test/autark")
        // find the silent one's socket: the last one the relay made
        relay.lastSocket?.answerPings = false
        silent.probe()
        eventually(5, "the silent connection ends within seconds") { !silent.isUp }
        link.close()
    }
}

final class PairingAndConnectionTests: XCTestCase {
    private struct World {
        let relay: FakeRelay
        let pc: FakeRelay.Pc
    }

    private func world() -> World {
        let relay = FakeRelay()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        relay.addPc(pc)
        return World(relay: relay, pc: pc)
    }

    /// Pairs the way the app does (code, accept on the PC) and returns what the app would keep.
    private func pair(_ w: World, accept: Bool = true) throws -> Paired {
        let codes = Locked([String]())
        let pairing = Pairing()
        let done = Future<Paired>()
        spawn("pair-test") {
            do {
                done.complete(try PhonePairing.pair(relay: "wss://relay.test/autark", remoteId: " \(w.pc.remoteId.prefix(3)) \(w.pc.remoteId.dropFirst(3).prefix(3))-\(w.pc.remoteId.suffix(3)) ",
                                                    name: "Stanislaus' iPhone", pairing: pairing, connector: w.relay, codes: { code, name in codes.with { $0.append("\(code)|\(name)") } }))
            } catch { done.fail(error) }
        }
        eventually(5, "code shown") { !codes.value.isEmpty }
        XCTAssertEqual(codes.value.first, "\(w.pc.remote.code)|Studio PC", "both screens show the same code")
        w.pc.remote.decision.complete(accept)
        return try done.get(timeout: 10)
    }

    func testPairingGivesTheKeysTokenAndPc() throws {
        let w = world()
        let paired = try pair(w)
        XCTAssertEqual(paired.token, w.pc.remote.token)
        XCTAssertEqual(paired.deviceId, "dev_phoneaccepted0001")
        XCTAssertEqual(paired.relay, "wss://relay.test/autark")
        XCTAssertEqual(paired.pcs.count, 1)
        XCTAssertEqual(paired.pcs[0].fingerprint, w.pc.fingerprint)
        XCTAssertEqual(paired.pcs[0].name, "Studio PC")
        XCTAssertEqual(Crypto.fromB64url(paired.pcs[0].publicKey), w.pc.publicKey)
        XCTAssertEqual(Crypto.fromB64url(paired.seed)?.count, 32)
        XCTAssertEqual(w.pc.remote.phoneDeviceIdSeen.value?.hasPrefix("dev_"), true)
        // storage JSON round trip
        let back = Paired.pcsOf(try Json.parse(paired.pcsJson))
        XCTAssertEqual(back, paired.pcs)
    }

    func testDeclinedOnThePc() {
        let w = world()
        XCTAssertThrowsError(try pair(w, accept: false)) { XCTAssertEqual(($0 as? AutarkError)?.message, "The person declined on the PC.") }
    }

    func testNoPcOnlineUnderThatId() {
        let w = world()
        let pairing = Pairing()
        XCTAssertThrowsError(try PhonePairing.pair(relay: "wss://relay.test/autark", remoteId: "123456782", name: "x", pairing: pairing, connector: w.relay, codes: { _, _ in })) {
            XCTAssertTrue(($0 as? AutarkError)?.message.hasPrefix("No PC with this Remote ID is online") == true)
        }
        XCTAssertThrowsError(try PhonePairing.pair(relay: "wss://relay.test/autark", remoteId: "12345", name: "x", pairing: pairing, connector: w.relay, codes: { _, _ in })) {
            XCTAssertEqual(($0 as? AutarkError)?.message, "The Remote ID has nine digits.")
        }
    }

    func testCancellingTheWaitTellsThePc() throws {
        let w = world()
        let pairing = Pairing()
        let codes = Locked([String]())
        let done = Future<Bool>()
        spawn("pair-cancel") {
            do { _ = try PhonePairing.pair(relay: "wss://relay.test/autark", remoteId: w.pc.remoteId, name: "x", pairing: pairing, connector: w.relay, codes: { c, _ in codes.with { $0.append(c) } }); done.complete(true) }
            catch { done.complete(false) }
        }
        eventually(5, "code shown") { !codes.value.isEmpty }
        pairing.cancel()
        XCTAssertEqual(try done.get(timeout: 10), false)
    }

    // MARK: the connection

    private func connect(_ w: World, paired: Paired, wait: Int = 1_500, announce: ((String) -> Void)? = nil) throws -> (PhoneConnection, Locked<[String]>, String) {
        let phoneFp = Crypto.fingerprint(Crypto.ed25519Public(seed: Crypto.fromB64url(paired.seed)!))
        w.pc.peers.insert(phoneFp) // the PC pinned the phone when the person accepted
        w.relay.addPc(w.pc)
        w.relay.streamVersion = "0.9.9"
        let statuses = Locked([String]())
        let connection = PhoneConnection(paired: paired, connector: w.relay, status: { text, connected in statuses.with { $0.append((connected ? "+" : "-") + text) } })
        connection.channelWaitMs = wait // the tests do not wait the app's 20 s for a 503
        if let announce = announce { connection.onPageChannel(announce) }
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

    func testAfterPairingTheAppConnectsAndServesThePage() throws {
        let w = world()
        let paired = try pair(w)
        let (connection, statuses, origin) = try connect(w, paired: paired)
        defer { connection.stop() }
        eventually(10, "connected") { statuses.value.contains("+Connected to Studio PC.") }
        XCTAssertEqual(connection.pcName, "Studio PC")
        XCTAssertEqual(connection.pc, w.pc.fingerprint)
        XCTAssertEqual(connection.linkedCount, 1)
        XCTAssertEqual(connection.selfFingerprint, Crypto.fingerprint(Crypto.ed25519Public(seed: Crypto.fromB64url(paired.seed)!)))
        let page = get(origin)
        XCTAssertTrue(page?.contains("Autark phone UI") == true, page ?? "nil")
        // the token the PC gave the phone went to the PC with the PC-list request
        eventually(5, "the PC list asked with the token") { w.relay.streams.first?.requestHeads.contains { $0.contains("Authorization: Bearer \(w.pc.remote.token)") } == true }
        XCTAssertTrue(statuses.value.contains("-Reaching the meeting server…"))
    }

    func testTheLinkComingBackAfterTheServerDroppedIt() throws {
        let w = world()
        let paired = try pair(w)
        let (connection, statuses, origin) = try connect(w, paired: paired)
        defer { connection.stop() }
        let linked = Locked(0)
        connection.onLinked { linked.with { $0 += 1 } }
        eventually(10, "connected") { statuses.value.contains("+Connected to Studio PC.") }
        let before = w.relay.helloCount
        w.relay.killAllSockets()
        eventually(15, "reconnected through a new server connection") { w.relay.helloCount > before && connection.pc != nil && connection.linkedCount == 1 }
        eventually(10, "page again") { self.get(origin)?.contains("Autark phone UI") == true }
        XCTAssertGreaterThanOrEqual(linked.value, 1, "the page hears of the new channel (it then refreshes its data)")
    }

    func testThePcGoingOfflineAndComingBack() throws {
        let w = world()
        let paired = try pair(w)
        let (connection, statuses, origin) = try connect(w, paired: paired)
        defer { connection.stop() }
        eventually(10, "connected") { statuses.value.contains("+Connected to Studio PC.") }
        w.relay.removePcOnline(w.pc)
        w.relay.closeTunnels()
        eventually(10, "offline notice") { statuses.value.contains("-None of your PCs is online. Autark must be running on one of them.") }
        XCTAssertNil(connection.pc)
        let answer = get(origin) // waits its few seconds, then 503 – never hangs
        XCTAssertTrue(answer?.hasPrefix("HTTP/1.1 503") == true, answer ?? "nil")
        w.relay.pcCameOnline(w.pc)
        eventually(15, "connected again") { connection.pc == w.pc.fingerprint }
        eventually(10, "page again") { self.get(origin)?.contains("Autark phone UI") == true }
    }

    func testCheckAfterReturningToTheAppProbesAndReconnectsAtOnce() throws {
        let w = world()
        let paired = try pair(w)
        let (connection, statuses, _) = try connect(w, paired: paired)
        defer { connection.stop() }
        eventually(10, "connected") { statuses.value.contains("+Connected to Studio PC.") }
        // the page's first channel is up at once now; its PC-list request (traffic the probe would count as life) is answered before the link "dies"
        eventually(5, "the PC list was asked and answered") { (w.relay.streams.first?.phonePcsAsked ?? 0) >= 1 }
        Thread.sleep(forTimeInterval: 0.5)
        // the server connection died silently (airplane mode): it never answers a ping
        w.relay.lastSocket?.answerPings = false
        let before = w.relay.helloCount
        connection.check()
        eventually(10, "dead link found and replaced") { w.relay.helloCount > before }
        eventually(10, "connected again") { connection.pc != nil && connection.linkedCount == 1 }
    }

    func testStopFreesTheEntrance() throws {
        let w = world()
        let paired = try pair(w)
        let (connection, statuses, origin) = try connect(w, paired: paired)
        eventually(10, "connected") { statuses.value.contains("+Connected to Studio PC.") }
        connection.stop()
        eventually(5, "no more connections") { TcpConnection.connect(port: Int(origin.split(separator: ":").last!)!) == nil }
        let spoken = statuses.value.count
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(statuses.value.count, spoken, "a stopped connection never speaks again")
    }

    func testWhenThePcRefusesThePageTokenAnotherPcOfTheCompanyServes() throws {
        let w = world()
        let second = FakeRelay.Pc(seed: Bytes(repeating: 0x24, count: 32))
        let paired = try pair(w)
        let phoneFp = Crypto.fingerprint(Crypto.ed25519Public(seed: Crypto.fromB64url(paired.seed)!))
        second.peers.insert(phoneFp)
        w.relay.addPc(second)
        w.relay.streamVersion = "0.9.9"
        let both = paired.withPcs(paired.pcs + [Pc(fingerprint: second.fingerprint, publicKey: Crypto.b64url(second.publicKey), name: "Laptop", deviceId: "dev_laptop")])
        let owners = Locked([String]())
        let (connection, statuses, _) = try connect(w, paired: both, announce: { fp in owners.with { $0.append(fp) } })
        defer { connection.stop() }
        eventually(15, "both linked") { connection.linkedCount == 2 }
        let first = connection.pc
        XCTAssertNotNil(first)
        XCTAssertTrue(statuses.value.contains { $0.hasPrefix("+Connected to") && $0.hasSuffix("(+1).") })
        connection.refused()
        eventually(10, "the page moved to the other PC") { connection.pc != nil && connection.pc != first }
        eventually(5, "the other PC announced") { owners.value.last == connection.pc }
        XCTAssertGreaterThanOrEqual(owners.value.count, 2, "every move of the page is announced")
        let onNow = connection.pc
        connection.refused()
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertEqual(connection.pc, onNow, "every linked PC refused: the page stays where it is, nobody picks")
    }

    func testTheNewPcIsAnnouncedBeforeTheFirstDataFrameGoesToThePage() throws {
        let w = world()
        let paired = try pair(w)
        let events = Locked([String]())
        let announcedAt = Locked<Date?>(nil)
        let (connection, statuses, origin) = try connect(w, paired: paired, wait: 8_000, announce: { fp in
            events.with { $0.append("owner:" + fp) }
            Thread.sleep(forTimeInterval: 0.4) // a slow page: the entrance must wait for the announcement
            announcedAt.value = Date()
        })
        defer { connection.stop() }
        let page = get(origin) // asks at once; it takes the PC's channel only after the announcement
        XCTAssertTrue(page?.contains("Autark phone UI") == true, page ?? "nil")
        XCTAssertEqual(events.value, ["owner:" + w.pc.fingerprint])
        let streams = try XCTUnwrap(w.relay.streams.first)
        let index = try XCTUnwrap(streams.requestHeads.firstIndex { $0.hasPrefix("GET / ") })
        XCTAssertGreaterThanOrEqual(streams.requestTimes[index], try XCTUnwrap(announcedAt.value), "the first data of this PC for the page went out after the announcement")
        eventually(5, "status") { statuses.value.contains("+Connected to Studio PC.") }
    }
}

final class OfflineOwnerTests: XCTestCase {
    func testTheMessageCarriesOnlyTheCompanyAndThePcFingerprint() throws {
        let fp = String(repeating: "ab", count: 32)
        let text = Json.write(OfflineOwner.message(companyId: "c2", pcFingerprint: fp))
        let object = try Json.object(text)
        XCTAssertEqual(Json.str(object, "t"), "offline.owner")
        let owner = try XCTUnwrap(object["owner"] as? JSONObject)
        XCTAssertEqual(Json.str(owner, "companyId"), "c2")
        XCTAssertEqual(Json.str(owner, "pcFingerprint"), fp)
        XCTAssertEqual(Set(owner.keys), ["companyId", "pcFingerprint"])
        XCTAssertEqual(Set(object.keys), ["t", "owner"])
        for secret in ["token", "seed", "tok"] { XCTAssertFalse(text.contains(secret)) }
    }

    func testNoClearOwnerIsNull() throws {
        for (c, f) in [(nil, nil), ("c1", nil), (nil, "ab"), ("", "ab"), ("c1", "")] as [(String?, String?)] {
            let object = try Json.object(Json.write(OfflineOwner.message(companyId: c, pcFingerprint: f)))
            XCTAssertTrue(object["owner"] is NSNull, "\(String(describing: c)) \(String(describing: f))")
            XCTAssertEqual(Json.write(object), "{\"owner\":null,\"t\":\"offline.owner\"}")
        }
    }
}
