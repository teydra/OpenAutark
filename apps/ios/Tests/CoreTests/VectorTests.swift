// Owns: the proof that the Swift port is byte-equal with the others – published vectors (RFC 8032, 7748, 5869), the Android
// tests' vectors (RelayCryptoTest, RemotePairTest, CodeChainTest) and values the REAL desktop code printed (DesktopVectors:
// remote/sas.ts, devices/{pair-proof,handshake,channel}.ts, rendezvous/seal.ts, the relay's protocol.ts).
// Never: a network test.
import XCTest
@testable import AutarkCore

final class CryptoVectorTests: XCTestCase {
    func testEd25519Rfc8032Test1() {
        let seed = hexBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        let pub = Crypto.ed25519Public(seed: seed)
        XCTAssertEqual(Crypto.hex(pub), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        // the RFC's signature of the empty message verifies (CryptoKit may sign non-deterministically, so no byte comparison)
        let rfc = hexBytes("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
        XCTAssertTrue(Crypto.verify(publicKey: pub, message: [], signature: rfc))
        var bad = rfc
        bad[0] ^= 1
        XCTAssertFalse(Crypto.verify(publicKey: pub, message: [], signature: bad))
        let own = Crypto.sign(seed: seed, message: Crypto.utf8("hello"))
        XCTAssertTrue(Crypto.verify(publicKey: pub, message: Crypto.utf8("hello"), signature: own))
        XCTAssertFalse(Crypto.verify(publicKey: pub, message: Crypto.utf8("hellO"), signature: own))
        XCTAssertFalse(Crypto.verify(publicKey: nil, message: [], signature: rfc))
        XCTAssertFalse(Crypto.verify(publicKey: Bytes(repeating: 1, count: 31), message: [], signature: rfc))
    }

    func testX25519Rfc7748() throws {
        let alice = hexBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        let bobPublic = hexBytes("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        XCTAssertEqual(Crypto.hex(try Crypto.x25519(secret: alice, peerPublic: bobPublic)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        XCTAssertThrowsError(try Crypto.x25519(secret: alice, peerPublic: Bytes(repeating: 0, count: 32))) // a weak key
        XCTAssertThrowsError(try Crypto.x25519(secret: alice, peerPublic: Bytes(repeating: 1, count: 5)))
    }

    func testHkdfRfc5869A3() {
        let okm = Crypto.hkdf(ikm: hexBytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"), salt: [], info: "", length: 42)
        XCTAssertEqual(Crypto.hex(okm), "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
        // 64 bytes (two blocks) are the first 42 of a longer run
        let long = Crypto.hkdf(ikm: Bytes(repeating: 7, count: 32), salt: Bytes(repeating: 9, count: 32), info: "wf-peer-v1 keys", length: 64)
        XCTAssertEqual(long.count, 64)
        XCTAssertEqual(Array(long[0..<20]), Array(Crypto.hkdf(ikm: Bytes(repeating: 7, count: 32), salt: Bytes(repeating: 9, count: 32), info: "wf-peer-v1 keys", length: 20)))
    }

    func testAesGcmCounterFramesOpenOnlyWithTheirCounter() throws {
        let key = Crypto.random(32)
        let sealed = try Crypto.seal(key: key, counter: 7, plain: Crypto.utf8("hello"))
        XCTAssertEqual(sealed.count, 5 + 16)
        XCTAssertEqual(Crypto.open(key: key, counter: 7, sealed: sealed), Crypto.utf8("hello"))
        XCTAssertNil(Crypto.open(key: key, counter: 8, sealed: sealed))
        var tampered = sealed
        tampered[0] ^= 1
        XCTAssertNil(Crypto.open(key: key, counter: 7, sealed: tampered))
        XCTAssertNil(Crypto.open(key: key, counter: 7, sealed: Bytes(repeating: 0, count: 15)))
        XCTAssertEqual(Crypto.hex(Crypto.nonce(1)), "000000000000000000000001")
    }

    func testBase64UrlLikeNode() {
        XCTAssertEqual(Crypto.b64url([0xfb, 0xff]), "-_8")
        XCTAssertEqual(Crypto.fromB64url("-_8"), [0xfb, 0xff])
        XCTAssertEqual(Crypto.fromB64url("-_8="), [0xfb, 0xff])
        XCTAssertNil(Crypto.fromB64url("a+b"))   // not the URL alphabet
        XCTAssertNil(Crypto.fromB64url("!!"))
        XCTAssertNil(Crypto.fromB64url("abcde")) // length 5 mod 4 = 1
        XCTAssertEqual(Crypto.fromB64url(""), [])
    }

    func testRemoteIdsAsTheDesktopComputesThem() {
        XCTAssertEqual(Crypto.remoteId("0000000000000000000000000000000000000000000000000000000000000000"), "114875446")
        XCTAssertEqual(Crypto.remoteId("81f39bf2061bf1c90aa791641ecf949f794ec5eae41a1185ab04e58ca2e6e9a5"), "552774309")
        let ids = section("ids")
        XCTAssertEqual(Crypto.remoteId("0000000000000000000000000000000000000000000000000000000000000000"), Json.str(ids, "zero"))
        XCTAssertEqual(Crypto.remoteId("81f39bf2061bf1c90aa791641ecf949f794ec5eae41a1185ab04e58ca2e6e9a5"), Json.str(ids, "other"))
        let phone = Crypto.ed25519Public(seed: Bytes(repeating: 0x11, count: 32))
        XCTAssertEqual(Crypto.fingerprint(phone), Json.str(ids, "phoneFingerprint"))
        XCTAssertEqual(Crypto.remoteId(Crypto.fingerprint(phone)), Json.str(ids, "phone"))
    }
}

final class ConnectRequestVectorTests: XCTestCase {
    private func inputs() -> (a: JSONObject, b: JSONObject, ephA: Bytes, ephB: Bytes, na: Bytes, nb: Bytes) {
        let a: JSONObject = ["id": "dev_pc00000000001", "name": "Büro-PC \"Nord\"\u{08}\u{0C}", "role": "home", "pub": String(repeating: "A", count: 43),
                             "addresses": ["http://192.168.1.2:47812", "relay:x"] as [Any]]
        let b: JSONObject = ["id": "dev_phone00000001", "name": "Pixel 8 😀", "role": "client", "pub": String(repeating: "B", count: 43), "addresses": [Any]()]
        return (a, b, Bytes(repeating: 1, count: 32), Bytes(repeating: 2, count: 32), Bytes(repeating: 3, count: 16), Bytes(repeating: 4, count: 16))
    }

    /// The Android vectors (RemotePairTest.java, printed by the desktop on 06.11.2026).
    func testAndroidVectors() {
        let i = inputs()
        XCTAssertEqual(RemotePair.stable(i.a), "{\"addresses\":[\"http://192.168.1.2:47812\",\"relay:x\"],\"id\":\"dev_pc00000000001\",\"name\":\"Büro-PC \\\"Nord\\\"\\b\\f\",\"pub\":\"" + String(repeating: "A", count: 43) + "\",\"role\":\"home\"}")
        let commit = RemotePair.commitment(ephA: i.ephA, ephB: i.ephB, na: i.na)
        XCTAssertEqual(commit, "n3COWC9UlCCqDOpIne6s5D01wBTN6IurBDoqNCHoGm4")
        let t = RemotePair.transcript(a: i.a, b: i.b, ephA: i.ephA, ephB: i.ephB, commit: commit, role: "phone")
        XCTAssertEqual(Crypto.hex(t), "1db4ffb7d7e36cbf29572f5eb12ae9df9a2940aaf41059658ddc538c1c783001")
        XCTAssertEqual(RemotePair.code(t: t, na: i.na, nb: i.nb), "8629")
        XCTAssertEqual(RemotePair.mac(key: Bytes(repeating: 5, count: 32), label: "remote-accept", parts: [i.a, Crypto.b64url(t)]), "30e2N-SIxf7uJVX2uehSOYY4OYeC8rTIEb9xP9Dn_xY")
        XCTAssertEqual(RemotePair.mac(key: Bytes(repeating: 5, count: 32), label: "remote-wait", parts: ["sess"]), "PTqd7ef_lYKBJOEU4Edkrk2Gi6e3T9SYRT8MwDY96NI")
        XCTAssertEqual(String(Crypto.hex(RemotePair.signed("B", t)).prefix(40)), "77662d72656d6f74652d763120427c1db4ffb7d7")
        XCTAssertTrue(RemotePair.newDeviceId().range(of: "^dev_[0-9a-z]{20}$", options: .regularExpression) != nil)
    }

    /// The same values, computed just now by apps/desktop's own sas.ts / pair-proof.ts / stable-json.ts.
    func testDesktopPrintedVectors() {
        let i = inputs()
        let v = section("sas")
        XCTAssertEqual(RemotePair.stable(i.a), Json.str(v, "stableA"))
        let commit = RemotePair.commitment(ephA: i.ephA, ephB: i.ephB, na: i.na)
        XCTAssertEqual(commit, Json.str(v, "commit"))
        let t = RemotePair.transcript(a: i.a, b: i.b, ephA: i.ephA, ephB: i.ephB, commit: commit, role: "phone")
        XCTAssertEqual(Crypto.hex(t), Json.str(v, "transcript"))
        XCTAssertEqual(RemotePair.code(t: t, na: i.na, nb: i.nb), Json.str(v, "code"))
        XCTAssertEqual(RemotePair.mac(key: Bytes(repeating: 5, count: 32), label: "remote-accept", parts: [i.a, Crypto.b64url(t)]), Json.str(v, "macAccept"))
        XCTAssertEqual(RemotePair.mac(key: Bytes(repeating: 5, count: 32), label: "remote-wait", parts: ["sess"]), Json.str(v, "macWait"))
        XCTAssertEqual(String(Crypto.hex(RemotePair.signed("B", t)).prefix(40)), Json.str(v, "signedBPrefix"))
    }
}

final class HandshakeVectorTests: XCTestCase {
    /// The desktop's handshake.ts ran with fixed phone key material; the phone side here must reach the same keys.
    func testPhoneSideReachesTheDesktopsKeys() throws {
        let v = section("handshake")
        let seed = hexBytes(Json.str(v, "phoneSeed")!)
        XCTAssertEqual(Crypto.hex(Crypto.ed25519Public(seed: seed)), Json.str(v, "phonePublic"))
        let ephSecret = hexBytes(Json.str(v, "ephPrivate")!)
        let ephPub = Bytes((try Curve25519Helper.publicKey(ephSecret)))
        let nonce = hexBytes(Json.str(v, "nonce")!)
        // the hello the desktop was given is exactly what the phone builds
        let hello = PeerHandshake.hello(deviceId: Json.str(v, "phoneDeviceId")!, pub: Crypto.ed25519Public(seed: seed), eph: ephPub, nonce: nonce)
        XCTAssertEqual(Json.write(try Json.object(Json.str(v, "hello")!)), Json.write(hello))
        let welcome = try Json.object(Json.str(v, "welcome")!)
        let result = try PeerHandshake.finish(seed: seed, ephSecret: ephSecret, ephPub: ephPub, nonce: nonce, welcome: welcome, pcPublicKey: hexBytes(Json.str(v, "pcPublic")!))
        XCTAssertEqual(Crypto.hex(result.sendKey), Json.str(v, "clientToServerKey"))
        XCTAssertEqual(Crypto.hex(result.receiveKey), Json.str(v, "serverToClientKey"))
        // the auth signature is valid for the phone's key over "client" ‖ H (CryptoKit signs with its own randomness, so no byte compare)
        let sig = Crypto.fromB64url(Json.str(result.auth, "sig")!)
        XCTAssertTrue(Crypto.verify(publicKey: Crypto.ed25519Public(seed: seed), message: Crypto.concat(Crypto.utf8("client"), result.hash), signature: sig))
        // the desktop's own auth message verifies against the hash the phone computed
        let desktopAuth = try Json.object(Json.str(v, "auth")!)
        XCTAssertTrue(Crypto.verify(publicKey: Crypto.ed25519Public(seed: seed), message: Crypto.concat(Crypto.utf8("client"), result.hash), signature: Crypto.fromB64url(Json.str(desktopAuth, "sig")!)))
    }

    func testAnotherPcKeyIsRefused() throws {
        let v = section("handshake")
        let seed = hexBytes(Json.str(v, "phoneSeed")!)
        let ephSecret = hexBytes(Json.str(v, "ephPrivate")!)
        let ephPub = try Curve25519Helper.publicKey(ephSecret)
        XCTAssertThrowsError(try PeerHandshake.finish(seed: seed, ephSecret: ephSecret, ephPub: ephPub, nonce: hexBytes(Json.str(v, "nonce")!),
                                                     welcome: try Json.object(Json.str(v, "welcome")!), pcPublicKey: Crypto.ed25519Public(seed: Bytes(repeating: 9, count: 32)))) { error in
            XCTAssertEqual((error as? AutarkError)?.message, "This is not the paired PC.")
        }
        // a welcome with a tampered signature
        var welcome = try Json.object(Json.str(v, "welcome")!)
        var sig = Crypto.fromB64url(Json.str(welcome, "sig")!)!
        sig[3] ^= 0x40
        welcome["sig"] = Crypto.b64url(sig)
        XCTAssertThrowsError(try PeerHandshake.finish(seed: seed, ephSecret: ephSecret, ephPub: ephPub, nonce: hexBytes(Json.str(v, "nonce")!), welcome: welcome, pcPublicKey: hexBytes(Json.str(v, "pcPublic")!))) { error in
            XCTAssertEqual((error as? AutarkError)?.message, "The PC's signature is not valid.")
        }
    }

    /// Frames the desktop's SecureChannel sealed open with the phone's keys, and the phone's frames equal the desktop's bytes.
    func testChannelFramesAreByteEqual() throws {
        let v = section("handshake")
        let sendKey = hexBytes(Json.str(v, "clientToServerKey")!)
        let receiveKey = hexBytes(Json.str(v, "serverToClientKey")!)
        let fromPc = v["fromPc"] as! [Any]
        XCTAssertEqual(fromPc.count, 2)
        for (counter, item) in fromPc.enumerated() {
            let row = item as! JSONObject
            let frame = hexBytes(Json.str(row, "hex")!)
            XCTAssertEqual(Array(frame[0..<8]), [0, 0, 0, 0, 0, 0, 0, UInt8(counter)])
            let plain = Crypto.open(key: receiveKey, counter: UInt64(counter), sealed: frame, offset: 8, length: frame.count - 8)
            XCTAssertEqual(plain.map(Crypto.string), Json.str(row, "plain"))
        }
        let fromPhone = (v["fromPhone"] as! [Any])[0] as! JSONObject
        let sealed = try Crypto.seal(key: sendKey, counter: 0, plain: Crypto.utf8(Json.str(fromPhone, "plain")!))
        XCTAssertEqual(Crypto.hex(Bytes([0, 0, 0, 0, 0, 0, 0, 0]) + sealed), Json.str(fromPhone, "hex"))
    }
}

final class RelaySealVectorTests: XCTestCase {
    /// rendezvous/seal.ts: a pairing request's keys, the sealed request and the PC's sealed reply.
    func testPairRequestSealing() throws {
        let v = section("seal")
        let boxPub = Crypto.fromB64url(Json.str(v, "boxPublic")!)!
        let openerSecret = hexBytes(Json.str(v, "openerPrivate")!)
        let okm = Crypto.hkdf(ikm: try Crypto.x25519(secret: openerSecret, peerPublic: boxPub), salt: Crypto.concat(Crypto.fromB64url(Json.str(v, "openerPublic")!)!, boxPub), info: RelayLink.pairInfo, length: 64)
        XCTAssertEqual(RelayLink.pairInfo, Json.str(v, "info"))
        XCTAssertEqual(Crypto.hex(Bytes(okm[0..<32])), Json.str(v, "toOwnerKey"))
        XCTAssertEqual(Crypto.hex(Bytes(okm[32..<64])), Json.str(v, "toOpenerKey"))
        let sealed = try Crypto.seal(key: Bytes(okm[0..<32]), counter: 0, plain: Crypto.utf8(Json.str(v, "requestPlain")!))
        XCTAssertEqual(Crypto.b64url(sealed), Json.str(v, "requestSealed"))
        let reply = Crypto.fromB64url(Json.str(v, "replySealed")!)!
        XCTAssertEqual(Crypto.open(key: Bytes(okm[32..<64]), counter: 0, sealed: reply).map(Crypto.string), Json.str(v, "replyPlain"))
        // what the relay has a phone sign
        XCTAssertEqual(Json.str(v, "helloText"), "wf-relay-v1|hello|CHALLENGE")
        XCTAssertEqual(Json.str(v, "boxText"), "wf-relay-v1|box|" + Json.str(v, "boxPublic")!)
        XCTAssertEqual(Json.str(v, "tunnelText"), "wf-relay-v1|tunnel|" + Json.str(v, "openerPublic")! + "|" + Json.str(v, "boxPublic")!)
    }

    /// A tunnel's first text frame: the PC's welcome sealed with the tunnel keys, counter 0, opened by the phone's Tunnel.
    func testTunnelTextFrame() throws {
        let v = section("seal")
        let t = section("tunnel")
        let boxPub = Crypto.fromB64url(Json.str(v, "boxPublic")!)!
        let okm = Crypto.hkdf(ikm: try Crypto.x25519(secret: hexBytes(Json.str(v, "openerPrivate")!), peerPublic: boxPub),
                              salt: Crypto.concat(Crypto.fromB64url(Json.str(v, "openerPublic")!)!, boxPub), info: RelayLink.tunnelInfo, length: 64)
        XCTAssertEqual(Crypto.hex(Bytes(okm[0..<32])), Json.str(t, "toOwnerKey"))
        XCTAssertEqual(Crypto.hex(Bytes(okm[32..<64])), Json.str(t, "toOpenerKey"))
        final class Sink: TunnelLink, PipeListener {
            var got = [(Bytes, Bool)]()
            func send(_ frame: Bytes) {}
            func close(_ tid: Int) {}
            func message(_ data: Bytes, text: Bool) { got.append((data, text)) }
            func closed() {}
        }
        let sink = Sink()
        let tunnel = Tunnel(tid: 7, peer: "pc", link: sink, sendKey: Bytes(okm[0..<32]), receiveKey: Bytes(okm[32..<64]))
        tunnel.listen(sink)
        let sealed = hexBytes(Json.str(t, "textFromPcSealed0")!)
        tunnel.receive([0, 0, 0, 7, 1] + sealed)
        XCTAssertEqual(sink.got.count, 1)
        XCTAssertEqual(Crypto.string(sink.got[0].0), Json.str(t, "textFromPcPlain"))
        XCTAssertTrue(sink.got[0].1)
    }
}

/// X25519 public key of a raw secret (a helper for the fixed-key tests).
enum Curve25519Helper {
    static func publicKey(_ secret: Bytes) throws -> Bytes {
        // the base point u = 9
        var base = Bytes(repeating: 0, count: 32)
        base[0] = 9
        return try Crypto.x25519(secret: secret, peerPublic: base)
    }
}
