// Owns: the phone's wake of a closed PC (W, 19.11.2026): Wake signs exactly the desktop's wake text – the vector below is the one Android's
// WakeTest.java and the desktop's test/unit/hosted/phone-wake.test.ts check – and sends it, sealed, to the helper found under its Remote ID
// at an in-process meeting server whose helper side is written from the desktop's sleeper.ts/wake-sign.ts (the signature must verify over
// "wf-wake-v1|<helper fp>|<helper box>|<at>|<nonce>" with the key the helper pinned); every refusal comes back as a sentence the page shows.
// Never: a test of a real closed PC waking – that is checked by hand with a real phone.
import XCTest
@testable import AutarkCore

final class WakeTests: XCTestCase {
    private let phoneSeed = Bytes(repeating: 0x11, count: 32)

    func testTheTextAndTheSignatureAreTheDesktopsVector() {
        let seed = hexBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60") // RFC 8032 7.1 TEST 1
        let fp = String(repeating: "a", count: 64)
        let box = Crypto.b64url(Bytes(repeating: 1, count: 32))
        XCTAssertEqual(Wake.text(wakeFp: fp, box: box, at: 1_763_500_000_000, nonce: "wakewakewakewake0001"),
                       "wf-wake-v1|\(fp)|AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE|1763500000000|wakewakewakewake0001")
        let body = Wake.body(seed: seed, wakeFp: fp, box: box, at: 1_763_500_000_000, nonce: "wakewakewakewake0001")
        #if !canImport(CryptoKit)
        // swift-crypto (BoringSSL) signs deterministically like the desktop's node and Android's JCA: byte for byte the vector. Apple's CryptoKit
        // randomises its Ed25519 signatures, so there only the verification below holds (the helper verifies, it never compares bytes).
        XCTAssertEqual(body["sig"] as? String, "tSWuVIlhc3dU7NWSk-9BKhQAxIivuIUmDLX-XM71H6ZAX5bKyPsPkz6xzMlm_uvLzuGOrK1OlYPKof3Sv19DAA")
        #endif
        XCTAssertEqual(Json.write(body), "{\"at\":1763500000000,\"nonce\":\"wakewakewakewake0001\",\"op\":\"wake\",\"sig\":\"\(body["sig"] as! String)\"}")
        XCTAssertTrue(Crypto.verify(publicKey: Crypto.ed25519Public(seed: seed), message: Crypto.utf8(Wake.text(wakeFp: fp, box: box, at: 1_763_500_000_000, nonce: "wakewakewakewake0001")),
                                    signature: Crypto.fromB64url(body["sig"] as! String)))
    }

    private struct World {
        let relay: FakeRelay
        let helper: FakeRelay.Pc
        let seen: Locked<[JSONObject]>
    }

    /// A wake helper at the meeting server (its own key, findable); it takes a wake the way sleeper.ts does: only from a pinned key.
    private func world(pinned: Bool = true, online: Bool = true, replies: Bool = true) -> World {
        let relay = FakeRelay()
        let helper = FakeRelay.Pc(seed: Bytes(repeating: 0x55, count: 32))
        let phonePub = Crypto.ed25519Public(seed: phoneSeed)
        let seen = Locked([JSONObject]())
        helper.wakeHandler = { [helper] request, from in
            seen.with { $0.append(request) }
            guard request["op"] as? String == "wake", let nonce = Json.str(request, "nonce"), let sig = Json.str(request, "sig") else { return ["ok": false] }
            let at = Json.num(request, "at", 0)
            let signed = Crypto.verify(publicKey: from, message: Crypto.utf8(Wake.text(wakeFp: helper.fingerprint, box: helper.boxPub, at: Int64(at), nonce: nonce)), signature: Crypto.fromB64url(sig))
            return ["ok": pinned && from == phonePub && signed && replies]
        }
        if online { relay.addPc(helper) }
        return World(relay: relay, helper: helper, seen: seen)
    }

    private func link(_ w: World) throws -> RelayLink {
        let link = RelayLink(seed: phoneSeed, pins: [], connector: w.relay, events: nil)
        try link.connect(url: "wss://relay.test/autark")
        return link
    }

    func testTheHelperTakesAWakeSignedByAPinnedPhone() throws {
        let w = world()
        let link = try link(w)
        defer { link.close() }
        XCTAssertNoThrow(try Wake.send(link: link, seed: phoneSeed, wakePub: Crypto.b64url(w.helper.publicKey), name: "Studio PC", now: 1_763_500_000_000, nonce: "nonce-one"))
        XCTAssertEqual(w.seen.value.count, 1)
        XCTAssertEqual(w.seen.value[0]["op"] as? String, "wake")
        XCTAssertEqual(Json.num(w.seen.value[0], "at", 0), 1_763_500_000_000)
        XCTAssertEqual(w.seen.value[0]["nonce"] as? String, "nonce-one")
    }

    func testRefusalsComeBackAsSentences() throws {
        // the helper does not know this phone (its app was closed before it pinned the phone)
        let unknown = world(pinned: false)
        let l1 = try link(unknown)
        defer { l1.close() }
        XCTAssertThrowsError(try Wake.send(link: l1, seed: phoneSeed, wakePub: Crypto.b64url(unknown.helper.publicKey), name: "Studio PC", now: 1, nonce: "n")) {
            XCTAssertTrue(($0 as? AutarkError)?.message.hasPrefix("Studio PC did not take the wake from this phone") == true, "\($0)")
        }
        // nobody waits under that key: the PC is off, asleep or its app was not closed from the app
        let off = world(online: false)
        let l2 = try link(off)
        defer { l2.close() }
        XCTAssertThrowsError(try Wake.send(link: l2, seed: phoneSeed, wakePub: Crypto.b64url(off.helper.publicKey), name: "Studio PC", now: 1, nonce: "n")) {
            XCTAssertTrue(($0 as? AutarkError)?.message.hasPrefix("Studio PC is not waiting at the meeting server") == true, "\($0)")
        }
        XCTAssertEqual(off.seen.value.count, 0, "nothing was sent to a helper that is not there")
        // an older PC: no wake key
        for key in [nil, "", "abc", Crypto.b64url(Bytes(repeating: 1, count: 31))] as [String?] {
            XCTAssertThrowsError(try Wake.send(link: l2, seed: phoneSeed, wakePub: key, name: "Studio PC", now: 1, nonce: "n")) {
                XCTAssertEqual(($0 as? AutarkError)?.message, "Studio PC runs an Autark that cannot be woken yet – start it there once.")
            }
        }
    }

    func testAWakeNeedsTheMeetingServerLink() throws {
        let w = world()
        let paired = Paired(relay: "wss://relay.test/autark", seed: Crypto.b64url(phoneSeed), deviceId: "dev_x", token: "tok", pcs: [])
        let connection = PhoneConnection(paired: paired, connector: w.relay, status: { _, _ in })
        XCTAssertThrowsError(try connection.wakePc(wakePub: Crypto.b64url(w.helper.publicKey), name: "Studio PC")) {
            XCTAssertEqual(($0 as? AutarkError)?.message, "This phone can't reach the meeting server right now – try again in a moment.")
        }
    }

    func testAConnectionWakesThroughItsOwnLink() throws {
        let w = world()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        pc.peers.insert(Crypto.fingerprint(Crypto.ed25519Public(seed: phoneSeed)))
        w.relay.addPc(pc)
        let paired = Paired(relay: "wss://relay.test/autark", seed: Crypto.b64url(phoneSeed), deviceId: "dev_x", token: "tok",
                            pcs: [Pc(fingerprint: pc.fingerprint, publicKey: Crypto.b64url(pc.publicKey), name: "Studio PC", deviceId: "dev_pc")])
        let statuses = Locked([String]())
        let connection = PhoneConnection(paired: paired, connector: w.relay, status: { text, connected in statuses.with { $0.append((connected ? "+" : "-") + text) } })
        _ = try connection.start(port: 0, gate: "g")
        defer { connection.stop() }
        eventually(10, "connected") { statuses.value.contains("+Connected to Studio PC.") }
        XCTAssertNoThrow(try connection.wakePc(wakePub: Crypto.b64url(w.helper.publicKey), name: "Laptop"))
        XCTAssertEqual(w.seen.value.count, 1)
    }
}
