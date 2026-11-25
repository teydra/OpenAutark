// Owns: the message the native side sends the page so its offline cache knows whose data it may show – {t:'offline.owner',
// owner:{companyId, pcFingerprint}} or owner:null when there is no clear owner (forgotten, no company, unclear PC). Format fixed with
// Felix (Android shell, ch_25d1j1jh #3). Carries no token and no seed, only the company's local id (c1, c2 …) and the fingerprint of
// the locally chosen PC (a public value).
// Never: puts a secret into the message.
import Foundation

public enum OfflineOwner {
    public static func message(companyId: String?, pcFingerprint: String?) -> JSONObject {
        guard let company = companyId, !company.isEmpty, let fp = pcFingerprint, !fp.isEmpty else { return ["t": "offline.owner", "owner": NSNull()] }
        return ["t": "offline.owner", "owner": ["companyId": company, "pcFingerprint": fp] as JSONObject]
    }
}
