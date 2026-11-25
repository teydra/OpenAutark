// Owns: this phone's side of the PC's connect request (the phone pairs like a PC, role "phone"), byte for byte as
// apps/desktop/src/runtime/remote/{sas,join}.ts and devices/pair-proof.ts: remote1 with the phone's own key and an X25519
// key, the PC's commitment, remote2 with the phone's nonce and signature, the PC's nonce and signature, the 4-digit code
// both screens show, then remote3 waits until the person accepts on the PC – the accepted answer carries the phone's
// device token (sealed by the meeting server request). Ported from relay/RemotePair.java.
// Never: trusts a PC whose key is not the one found under the Remote ID, or an acceptance without the session key's MAC.
import Foundation

public final class RemotePair {
    /// One sealed request step to the PC and its opened reply.
    public typealias Transport = (_ body: JSONObject, _ timeoutMs: Int) throws -> JSONObject

    public static let role = "phone"
    private static let stepMs = 20_000
    private static let waitMs = 70_000

    /// What the phone shows while the person compares the code on the PC.
    public final class Asked {
        public let code: String
        public let pcName: String
        public let pcDeviceId: String?
        let session: String
        let key: Bytes
        let transcript: Bytes
        let pcInfo: JSONObject
        init(code: String, pcName: String, pcDeviceId: String?, session: String, key: Bytes, transcript: Bytes, pcInfo: JSONObject) {
            self.code = code; self.pcName = pcName; self.pcDeviceId = pcDeviceId; self.session = session
            self.key = key; self.transcript = transcript; self.pcInfo = pcInfo
        }
    }

    /// The accepted answer: the device token and id this PC gave the phone.
    public struct Accepted {
        public let token: String
        public let deviceId: String
    }

    private let transport: Transport
    private let seed: Bytes
    let info: JSONObject

    /// `deviceId` "dev_…" and `name` (≤ 60 UTF-16 units) as the PC will store them; `seed` the phone's Ed25519 key.
    public init(transport: @escaping Transport, seed: Bytes, deviceId: String, name: String?) {
        self.transport = transport
        self.seed = seed
        var label = ""
        var units = 0
        for scalar in (name ?? "").unicodeScalars {
            let clean: Unicode.Scalar = (scalar.value < 0x20 || scalar.value == 0x7f) ? " " : scalar
            let width = clean.value > 0xffff ? 2 : 1
            if units + width > 60 { break }
            label.unicodeScalars.append(clean)
            units += width
        }
        label = label.trimmingCharacters(in: .whitespaces)
        self.info = ["id": deviceId, "name": label.isEmpty ? "iPhone" : label, "role": "client",
                     "pub": Crypto.b64url(Crypto.ed25519Public(seed: seed)), "addresses": [Any]()]
    }

    /// A new device id the PC accepts (dev_ + 20 base-36 characters).
    public static func newDeviceId() -> String {
        let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        var out = "dev_"
        for b in Crypto.random(20) { out.append(digits[Int(b) % 36]) }
        return out
    }

    /// remote1 and remote2: the code both screens show. `pcFingerprint`: the key found under the Remote ID.
    public func ask(remoteId: String, pcFingerprint: String) throws -> Asked {
        let eph = Crypto.x25519Pair()
        let first = try step(["kind": "remote1", "v": 1, "role": RemotePair.role, "device": info, "eph": Crypto.b64url(eph.pub),
                              "target": ["remoteId": remoteId] as JSONObject] as JSONObject, RemotePair.stepMs)
        guard let pc = first["device"] as? JSONObject, let session = Json.str(first, "session"), let commit = Json.str(first, "commit"),
              let ephA = RemotePair.bytes(Json.str(first, "eph"), 32) else { throw AutarkError("Update Autark on the PC.") }
        guard let pcPub = RemotePair.bytes(Json.str(pc, "pub"), 32), Crypto.fingerprint(pcPub) == pcFingerprint else {
            throw AutarkError("A different PC answered than the one with this Remote ID.")
        }
        let t = RemotePair.transcript(a: pc, b: info, ephA: ephA, ephB: eph.pub, commit: commit, role: RemotePair.role)
        let nb = Crypto.random(16)
        let second = try step(["kind": "remote2", "session": session, "nb": Crypto.b64url(nb),
                               "sig": Crypto.b64url(Crypto.sign(seed: seed, message: RemotePair.signed("B", t)))] as JSONObject, RemotePair.stepMs)
        guard let na = RemotePair.bytes(Json.str(second, "na"), 16), let sig = Json.str(second, "sig"),
              RemotePair.commitment(ephA: ephA, ephB: eph.pub, na: na) == commit,
              Crypto.verify(publicKey: pcPub, message: RemotePair.signed("A", t), signature: Crypto.fromB64url(sig)) else {
            throw AutarkError("The PC could not prove its identity.")
        }
        let key = Crypto.hkdf(ikm: try Crypto.x25519(secret: eph.secret, peerPublic: ephA), salt: t, info: "wf-remote-v1 key", length: 32)
        let name = Json.str(pc, "name")
        return Asked(code: RemotePair.code(t: t, na: na, nb: nb), pcName: name ?? "PC", pcDeviceId: Json.str(pc, "id"), session: session, key: key, transcript: t, pcInfo: pc)
    }

    /// remote3 until the person decides on the PC (each wait ≤ 55 s there).
    public func awaitAccept(_ asked: Asked, cancelled: () -> Bool) throws -> Accepted {
        while !cancelled() {
            let reply = try step(["kind": "remote3", "session": asked.session, "mac": RemotePair.mac(key: asked.key, label: "remote-wait", parts: [asked.session])] as JSONObject, RemotePair.waitMs)
            let status = Json.str(reply, "status")
            if status == "pending" { continue }
            if status == "declined" { throw AutarkError(Json.str(reply, "reason") ?? "The PC declined.") }
            if status != "accepted" { throw AutarkError("Nobody accepted on the PC in time.") }
            guard let device = reply["device"], let given = Json.str(reply, "mac"),
                  Crypto.constantEquals(Crypto.utf8(RemotePair.mac(key: asked.key, label: "remote-accept", parts: [device, Crypto.b64url(asked.transcript)])), Crypto.utf8(given)) else {
                throw AutarkError("The PC could not prove its identity.")
            }
            guard let token = Json.str(reply, "token"), let deviceId = Json.str(reply, "deviceId") else { throw AutarkError("Update Autark on the PC.") }
            return Accepted(token: token, deviceId: deviceId)
        }
        cancel(asked)
        throw AutarkError("Cancelled.")
    }

    /// Tells the PC this request ends (≤ 3 s, errors ignored).
    public func cancel(_ asked: Asked) {
        _ = try? transport(["kind": "remoteCancel", "session": asked.session, "mac": RemotePair.mac(key: asked.key, label: "remote-cancel", parts: [asked.session])] as JSONObject, 3_000)
    }

    private func step(_ body: JSONObject, _ timeoutMs: Int) throws -> JSONObject {
        let reply = try transport(body, timeoutMs)
        if reply["ok"] as? Bool == true { return reply }
        if let error = reply["error"] as? JSONObject, let message = Json.str(error, "message") { throw AutarkError(message) }
        throw AutarkError("The PC refused the request.")
    }

    static func bytes(_ b64: String?, _ length: Int) -> Bytes? {
        guard let b64 = b64, b64.count <= 100, let out = Crypto.fromB64url(b64), out.count == length else { return nil }
        return out
    }

    // MARK: remote/sas.ts and devices/pair-proof.ts, exactly

    /// sha256 over length-prefixed parts ("<length>:" + bytes each).
    static func hash(_ parts: [Bytes]) -> Bytes {
        var data = Bytes()
        for part in parts {
            data.append(contentsOf: Bytes("\(part.count):".utf8))
            data.append(contentsOf: part)
        }
        return Crypto.sha256(data)
    }

    static func commitment(ephA: Bytes, ephB: Bytes, na: Bytes) -> String {
        Crypto.b64url(hash([Crypto.utf8("wf-remote-v1 commit"), ephA, ephB, na]))
    }

    static func transcript(a: JSONObject, b: JSONObject, ephA: Bytes, ephB: Bytes, commit: String, role: String) -> Bytes {
        hash([Crypto.utf8("wf-remote-v1 transcript"), Crypto.utf8(stable(a)), Crypto.utf8(stable(b)), ephA, ephB, Crypto.utf8(commit), Crypto.utf8(role)])
    }

    static func code(t: Bytes, na: Bytes, nb: Bytes) -> String {
        let h = hash([Crypto.utf8("wf-remote-v1 code"), t, na, nb])
        let value = (UInt64(h[0]) << 24) | (UInt64(h[1]) << 16) | (UInt64(h[2]) << 8) | UInt64(h[3])
        var text = String(value % 10_000)
        while text.count < 4 { text = "0" + text }
        return text
    }

    static func signed(_ side: String, _ t: Bytes) -> Bytes { Crypto.utf8("wf-remote-v1 \(side)|") + t }

    static func mac(key: Bytes, label: String, parts: [Any]) -> String {
        var text = "wf-pair-v1|\(label)|"
        for (i, part) in parts.enumerated() {
            if i > 0 { text += "|" }
            text += stable(part)
        }
        return Crypto.b64url(Crypto.hmacSHA256(key: key, data: Crypto.utf8(text)))
    }

    /// pair-proof.ts stable(): sorted keys, JSON.stringify for every leaf.
    static func stable(_ value: Any?) -> String {
        var out = ""
        stable(&out, value)
        return out
    }

    private static func stable(_ out: inout String, _ value: Any?) {
        if let map = value as? JSONObject {
            out += "{"
            var first = true
            for key in Json.sortedKeys(Array(map.keys)) {
                if !first { out += "," }
                first = false
                quote(&out, key)
                out += ":"
                stable(&out, map[key] ?? nil)
            }
            out += "}"
        } else if let list = value as? [Any] {
            out += "["
            for (i, item) in list.enumerated() {
                if i > 0 { out += "," }
                stable(&out, item)
            }
            out += "]"
        } else if let text = value as? String {
            quote(&out, text)
        } else {
            out += Json.write(value)
        }
    }

    /// JSON.stringify of a string (ES2019 well-formed: lone surrogates escaped).
    private static func quote(_ out: inout String, _ text: String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += "\\u" + Json.hex4(UInt16(scalar.value)) } else { out.unicodeScalars.append(scalar) }
            }
        }
        out += "\""
    }
}
