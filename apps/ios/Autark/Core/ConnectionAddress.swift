// Owns: what the connect screen accepts – the PC's Remote ID, typed ("482 913 071") or as the QR's pair link
// (https://openautark.com/pair/#<ID>, apps/desktop/src/shared/api/methods-phone.ts PHONE_PAIR_LINK; iOS Universal Links
// open it here, the custom scheme autark://pair/<ID> is the fallback) – and the origin comparison for the local entrance
// (http://127.0.0.1:<port>); scanned(): what a QR or picture may carry. Ported from ConnectionAddress.java.
// Never: persists what was typed, or takes a pair link of another host.
import Foundation

public enum ConnectionAddress {
    /// Autark's own meeting server (apps/desktop/src/shared/model/relay.ts DEFAULT_RELAY).
    public static let defaultRelay = "wss://telecoding-relay.onrender.com/autark"
    /// The QR on the PC: this plus the Remote ID (the site openautark.com).
    static let pairLink = "https://openautark.com/pair/#"
    /// QR codes of PCs before the move to openautark.com (the old Meta Jarvis address, which now forwards there).
    static let metaPairLink = "https://metajarvis.teydralab.com/autark/pair/#"
    /// The spelling before the site page (no slash before #); older QR codes still carry it.
    static let oldPairLink = "https://metajarvis.teydralab.com/autark/pair#"
    /// The custom-scheme fallback: autark://pair/<ID>.
    static let appScheme = "autark://pair/"

    /// Nine digits, spaces or dashes allowed ("482 913 071"), or the pair link that carries them.
    public static func remoteId(_ text: String?) throws -> String {
        var value = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let hash = value.lastIndex(of: "#"), value.contains("/pair/#") || value.contains("/pair#") {
            value = String(value[value.index(after: hash)...])
        } else if value.lowercased().hasPrefix(appScheme) {
            value = String(value.dropFirst(appScheme.count))
        }
        let digits = value.filter { !$0.isWhitespace && $0 != "-" }
        if digits.count != 9 || !digits.allSatisfy({ $0.isASCII && $0.isNumber }) {
            throw AutarkError("The Remote ID has nine digits (Settings → Devices on the PC).")
        }
        return digits
    }

    /// The Remote ID of an opened pair link (Universal Link, an older PC's link, or autark://pair/<id>), else nil.
    public static func fromLink(_ url: String?) -> String? {
        guard let url = url else { return nil }
        let known = url.hasPrefix(pairLink) || url.hasPrefix(metaPairLink) || url.hasPrefix(oldPairLink) || url.lowercased().hasPrefix(appScheme)
        if !known { return nil }
        return try? remoteId(url)
    }

    /// A scanned QR's text: the pair link of this host, or the nine digits alone ("482 913 071"); anything else nil.
    public static func scanned(_ text: String?) -> String? {
        let value = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty && value.allSatisfy({ $0.isNumber || $0.isWhitespace || $0 == "-" }) { return try? remoteId(value) }
        return fromLink(value)
    }

    /// True when `url` has the origin `origin` (scheme, host and port; the default port counts as none).
    public static func sameOrigin(_ origin: String?, _ url: String?) -> Bool {
        guard let origin = origin, let url = url, let target = originOf(url) else { return false }
        return origin == target
    }

    static func originOf(_ url: String) -> String? {
        guard let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host?.lowercased(), parts.user == nil, parts.password == nil else { return nil }
        if let port = parts.port, port == 0 || port > 65535 { return nil }
        let isDefault = parts.port == nil || parts.port == (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host)" + (isDefault ? "" : ":\(parts.port!)")
    }
}
