// Owns: the proof that the core's public surface is complete – this file imports AutarkCore WITHOUT @testable, so it only compiles
// when everything the app target (AppModel, PageBridge, the views, URLSessionSocket, KeychainStore) calls is public. It uses the
// core exactly the way the app does and checks nothing about behaviour that the other tests do not.
import XCTest
import Foundation
import AutarkCore

private struct NoConnector: WebSocketConnector {
    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink { throw AutarkError("no network in this test") }
}

private final class StoreLikeKeychain: StringStore {
    var values = [String: String]()
    func get(_ key: String) -> String? { values[key] }
    func put(_ key: String, _ value: String?) { values[key] = value }
}

final class PublicApiTests: XCTestCase {
    func testTheSurfaceTheAppUses() throws {
        let store = StoreLikeKeychain()
        let companies = Companies(store: store)
        XCTAssertNil(companies.currentPaired)
        XCTAssertEqual(companies.port, 47920)
        let pub = Crypto.ed25519Public(seed: Bytes(repeating: 3, count: 32))
        let pc = Pc(fingerprint: Crypto.fingerprint(pub), publicKey: Crypto.b64url(pub), name: "Studio PC", deviceId: "dev_x")
        let paired = Paired(relay: ConnectionAddress.defaultRelay, seed: Crypto.b64url(Crypto.newSeed()), deviceId: "dev_p", token: "tok", pcs: [pc])
        let id = companies.add(paired)
        XCTAssertEqual(companies.currentId, id)
        XCTAssertEqual(companies.count, 1)
        XCTAssertTrue(companies.setCurrent(id))
        companies.setCard(name: "Teydra", avatar: nil)
        companies.setPcs(company: id, [pc])
        XCTAssertTrue(companies.listJson(pcName: "Studio PC").contains("Teydra"))
        XCTAssertEqual(companies.currentPaired?.pcs.first?.name, "Studio PC")

        XCTAssertEqual(PairRun.Wait(line: "x", code: nil), PairRun.Wait(line: "x", code: nil))
        XCTAssertEqual(try ConnectionAddress.remoteId("482 913 071"), "482913071")
        XCTAssertEqual(ConnectionAddress.fromLink("autark://pair/482913071"), "482913071")
        XCTAssertNil(ConnectionAddress.scanned("nope"))
        XCTAssertTrue(ConnectionAddress.sameOrigin("http://127.0.0.1:1", "http://127.0.0.1:1/x"))
        XCTAssertEqual(CssColor.parse("#202020", fallback: 0), 0xFF202020)
        XCTAssertFalse(CssColor.isLight(0xFF202020))
        let parsed = try Json.parse("{\"t\":\"x\"}") as? JSONObject
        XCTAssertEqual(Json.str(parsed ?? [:], "t"), "x")
        XCTAssertEqual(Json.num(["n": 3.0], "n", 0), 3)
        XCTAssertEqual(Json.write(["a": 1] as JSONObject), "{\"a\":1}")
        XCTAssertEqual(StreamProxy.gateCookie, "autark_gate")
        XCTAssertEqual(Crypto.b64url(Crypto.random(32)).count, 43)

        // the connection the model owns
        let connection = PhoneConnection(paired: paired, connector: NoConnector(), status: { _, _ in })
        connection.channelWaitMs = 100
        connection.onLinked {}
        let origin = try connection.start(port: 0, gate: "gate")
        XCTAssertTrue(origin.hasPrefix("http://127.0.0.1:"))
        XCTAssertEqual(connection.pcs.first?.fingerprint, pc.fingerprint)
        XCTAssertFalse(connection.online(pc.fingerprint))
        XCTAssertNil(connection.pc)
        XCTAssertNil(connection.pcName)
        XCTAssertEqual(connection.linkedCount, 0)
        XCTAssertEqual(connection.paired.token, "tok")
        XCTAssertEqual(connection.openStreams, 0)
        XCTAssertFalse(connection.selfFingerprint.isEmpty)
        connection.front(false)
        connection.front(true)
        connection.refused()
        connection.check()
        connection.nudge()
        connection.probe()
        connection.updatePcs([pc])
        connection.stop()

        // a pairing the model starts and cancels
        let started = Locked(false)
        let running: Pairing = PairRun.start(remoteId: "482913071", name: "iPhone", connector: NoConnector(), status: { _ in started.value = true }, done: { _, _ in })
        running.cancel()
        XCTAssertTrue(running.cancelled)
        XCTAssertTrue(started.value)
        XCTAssertEqual(companies.remove(id), nil)
    }

    func testTheStoreProtocolAndTheMemoryStoreAreUsableOutside() {
        let memory = MemoryStore()
        memory.put("a", "b")
        XCTAssertEqual(memory.get("a"), "b")
    }
}
