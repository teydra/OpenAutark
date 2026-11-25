// Owns: checking the person code (decision 13 of B-084, as apps/desktop remote/code.ts) – a device answers for a Remote ID
// when it is that ID's own key, or when its chain {root, links:[{pub, sig}]} runs from the root key of that ID to it, each
// link signed by the key before it over "wf-code-v1|" + the member's fingerprint. Ported from relay/CodeChain.java.
// Never: trusts a chain longer than 8 links, signs anything, or stores a chain.
import Foundation

public enum CodeChain {
    static let maxLinks = 8

    /// True when the device `fingerprintHex` may answer for `remoteId` (its own ID, or a chain that proves it).
    public static func belongs(remoteId: String?, fingerprintHex: String?, chainJson: String?) -> Bool {
        guard let remoteId = remoteId, let fingerprintHex = fingerprintHex else { return false }
        let fp = fingerprintHex.lowercased()
        if Crypto.remoteId(fp) == remoteId { return true }
        guard let chainJson = chainJson else { return false }
        guard let parsed = try? Json.parse(chainJson), let chain = parsed as? JSONObject else { return false }
        guard var prev = key(chain["root"], 32), let links = chain["links"] as? [Any], links.count <= maxLinks else { return false }
        if Crypto.remoteId(Crypto.fingerprint(prev)) != remoteId { return false }
        for item in links {
            guard let link = item as? JSONObject, let pub = key(link["pub"], 32), let sig = key(link["sig"], 64) else { return false }
            if !Crypto.verify(publicKey: prev, message: Crypto.utf8("wf-code-v1|" + Crypto.fingerprint(pub)), signature: sig) { return false }
            prev = pub
        }
        return Crypto.fingerprint(prev) == fp
    }

    /// base64url text of exactly `length` bytes, else nil.
    private static func key(_ value: Any?, _ length: Int) -> Bytes? {
        guard let text = value as? String, text.count <= 128, let raw = Crypto.fromB64url(text), raw.count == length else { return nil }
        return raw
    }
}
