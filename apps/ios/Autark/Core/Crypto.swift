// Owns: the exact primitives Autark's PCs use for the meeting server and the peer channel (Ed25519 device keys,
// X25519, HKDF-SHA256, AES-256-GCM with counter nonces, base64url without padding), byte for byte as
// apps/desktop/src/runtime/devices/{keys,handshake,channel}.ts and rendezvous/seal.ts – ported from
// apps/android/.../relay/Crypto.java. Never: stores keys or logs them.
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public typealias Bytes = [UInt8]

/// One error type for everything the relay core reports to the person: the text is shown as is.
public struct AutarkError: Error, LocalizedError, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

public enum Crypto {
    // MARK: text and bytes

    public static func utf8(_ text: String) -> Bytes { Bytes(text.utf8) }

    public static func string(_ bytes: Bytes) -> String { String(decoding: bytes, as: UTF8.self) }

    public static func b64url(_ data: Bytes) -> String {
        Data(data).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Standard base64 with padding (the PC's stream bytes).
    public static func b64Std(_ data: Bytes) -> String { Data(data).base64EncodedString() }

    public static func fromB64Std(_ text: String) -> Bytes? { Data(base64Encoded: text).map { Bytes($0) } }

    /// base64url with or without padding; nil for anything outside the alphabet (like Java's URL decoder).
    public static func fromB64url(_ text: String) -> Bytes? {
        let cleaned = text.replacingOccurrences(of: "=", with: "")
        for scalar in cleaned.unicodeScalars {
            let v = scalar.value
            let ok = (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 45 || v == 95
            if !ok { return nil }
        }
        if cleaned.count % 4 == 1 { return nil }
        var standard = cleaned.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while standard.count % 4 != 0 { standard += "=" }
        return Data(base64Encoded: standard).map { Bytes($0) }
    }

    public static func random(_ length: Int) -> Bytes {
        var generator = SystemRandomNumberGenerator()
        var out = Bytes()
        out.reserveCapacity(length)
        for _ in 0..<length { out.append(UInt8.random(in: 0...255, using: &generator)) }
        return out
    }

    public static func concat(_ parts: Bytes...) -> Bytes {
        var out = Bytes()
        for part in parts { out.append(contentsOf: part) }
        return out
    }

    public static func sha256(_ data: Bytes) -> Bytes { Bytes(SHA256.hash(data: data)) }

    public static func hex(_ data: Bytes) -> String {
        let digits = Array("0123456789abcdef")
        var out = ""
        out.reserveCapacity(data.count * 2)
        for b in data { out.append(digits[Int(b >> 4)]); out.append(digits[Int(b & 15)]) }
        return out
    }

    public static func fromHex(_ text: String) -> Bytes {
        var out = Bytes()
        var high: UInt8? = nil
        for ch in text.utf8 {
            let v: UInt8
            switch ch {
            case 48...57: v = ch - 48
            case 97...102: v = ch - 87
            case 65...70: v = ch - 55
            default: continue
            }
            if let h = high { out.append(h << 4 | v); high = nil } else { high = v }
        }
        return out
    }

    /// The device fingerprint: sha256 (hex) of the raw Ed25519 public key.
    public static func fingerprint(_ publicKey: Bytes) -> String { hex(sha256(publicKey)) }

    /// The 9-digit Remote ID of a fingerprint (remote/id.ts): 8 digits from a hash plus a Luhn check digit.
    public static func remoteId(_ fingerprint: String) -> String {
        let digest = sha256(utf8("wf-remote-id-v1|" + fingerprint.lowercased()))
        let high = (UInt64(digest[0]) << 24) | (UInt64(digest[1]) << 16) | (UInt64(digest[2]) << 8) | UInt64(digest[3])
        var all = String(high * 4 + UInt64(digest[4] & 3))
        while all.count < 10 { all = "0" + all }
        let payload = Array(all.suffix(8))
        var sum = 0
        for i in 0..<payload.count {
            var digit = Int(payload[payload.count - 1 - i].asciiValue! - 48)
            if i % 2 == 0 { digit *= 2; if digit > 9 { digit -= 9 } }
            sum += digit
        }
        return String(payload) + String((10 - (sum % 10)) % 10)
    }

    // MARK: Ed25519 device key

    public static func newSeed() -> Bytes { random(32) }

    public static func ed25519Public(seed: Bytes) -> Bytes {
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return Bytes(repeating: 0, count: 32) }
        return Bytes(key.publicKey.rawRepresentation)
    }

    public static func sign(seed: Bytes, message: Bytes) -> Bytes {
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed), let sig = try? key.signature(for: message) else { return Bytes(repeating: 0, count: 64) }
        return Bytes(sig)
    }

    public static func verify(publicKey: Bytes?, message: Bytes, signature: Bytes?) -> Bool {
        guard let publicKey = publicKey, publicKey.count == 32, let signature = signature, signature.count == 64 else { return false }
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    // MARK: X25519

    /// A fresh X25519 pair: (private, public).
    public static func x25519Pair() -> (secret: Bytes, pub: Bytes) {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return (Bytes(key.rawRepresentation), Bytes(key.publicKey.rawRepresentation))
    }

    public static func x25519(secret: Bytes, peerPublic: Bytes) throws -> Bytes {
        guard peerPublic.count == 32, secret.count == 32 else { throw AutarkError("bad key") }
        guard let priv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret),
              let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublic),
              let shared = try? priv.sharedSecretFromKeyAgreement(with: pub) else { throw AutarkError("weak key") }
        let out = shared.withUnsafeBytes { Bytes($0) }
        if out.allSatisfy({ $0 == 0 }) { throw AutarkError("weak key") }
        return out
    }

    // MARK: HMAC, HKDF and AES-GCM

    public static func hmacSHA256(key: Bytes, data: Bytes) -> Bytes {
        Bytes(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    public static func hkdf(ikm: Bytes, salt: Bytes, info: String, length: Int) -> Bytes {
        let prk = hmacSHA256(key: salt.isEmpty ? Bytes(repeating: 0, count: 32) : salt, data: ikm)
        var out = Bytes()
        var previous = Bytes()
        var counter: UInt8 = 1
        let infoBytes = utf8(info)
        while out.count < length {
            var mac = HMAC<SHA256>(key: SymmetricKey(data: prk))
            mac.update(data: previous)
            mac.update(data: infoBytes)
            mac.update(data: [counter])
            previous = Bytes(mac.finalize())
            out.append(contentsOf: previous.prefix(length - out.count))
            counter &+= 1
        }
        return out
    }

    static func nonce(_ counter: UInt64) -> Bytes {
        var out = Bytes(repeating: 0, count: 12)
        for i in 0..<8 { out[4 + i] = UInt8((counter >> UInt64(56 - 8 * i)) & 0xff) }
        return out
    }

    /// ciphertext ‖ 16-byte tag, nonce = 4 zero bytes ‖ counter (big endian).
    public static func seal(key: Bytes, counter: UInt64, plain: Bytes) throws -> Bytes {
        guard let n = try? AES.GCM.Nonce(data: nonce(counter)) else { throw AutarkError("bad nonce") }
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: n)
        return Bytes(box.ciphertext) + Bytes(box.tag)
    }

    /// The plain bytes, or nil when the frame does not open with this key and counter.
    public static func open(key: Bytes, counter: UInt64, sealed: Bytes, offset: Int = 0, length: Int? = nil) -> Bytes? {
        let length = length ?? (sealed.count - offset)
        if length < 16 || offset < 0 || offset + length > sealed.count { return nil }
        guard let n = try? AES.GCM.Nonce(data: nonce(counter)) else { return nil }
        let cipher = Bytes(sealed[offset..<(offset + length - 16)])
        let tag = Bytes(sealed[(offset + length - 16)..<(offset + length)])
        guard let box = try? AES.GCM.SealedBox(nonce: n, ciphertext: cipher, tag: tag),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key)) else { return nil }
        return Bytes(plain)
    }

    public static func constantEquals(_ a: Bytes, _ b: Bytes) -> Bool {
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}
