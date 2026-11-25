// Owns: waking a PC of mine whose Autark app is closed, from this phone (W, 19.11.2026): the PC's wake helper waits at the meeting
// server under its own key (desktop runtime/devices/sleeper.ts); this phone finds it under that key's Remote ID and sends one sealed
// request {op:'wake', at, nonce, sig} – the signature by this phone's device key over "wf-wake-v1|<helper fp>|<helper box>|<at>|<nonce>",
// byte for byte the desktop's shared/model/wake.ts wakeText (vector in Tests/CoreTests/WakeTests.swift, the same one as Android's
// WakeTest.java and the desktop's phone-wake.test.ts). The helper takes it because the PC pinned my phones in its wake file.
// Needs only the meeting-server link, which the app can hold in the foreground: iOS keeps no connection in the background, so the
// phone wakes a PC when the person asks for it (the page's 'wake' message), never by itself. Ported from relay/Wake.java.
// Never: keeps a key, wakes a helper other than the one asked for, or needs a PC online.
import Foundation

public enum Wake {
    /// How long the helper's answer may take (as the desktop's WAKE_REPLY_MS).
    public static let replyMs = 10_000

    /// The text a waker signs.
    public static func text(wakeFp: String, box: String, at: Int64, nonce: String) -> String {
        "wf-wake-v1|\(wakeFp)|\(box)|\(at)|\(nonce)"
    }

    /// The wake body for the helper session found (its fingerprint and box), signed with this phone's key.
    public static func body(seed: Bytes, wakeFp: String, box: String, at: Int64, nonce: String) -> JSONObject {
        ["op": "wake", "at": at, "nonce": nonce,
         "sig": Crypto.b64url(Crypto.sign(seed: seed, message: Crypto.utf8(text(wakeFp: wakeFp, box: box, at: at, nonce: nonce))))]
    }

    /// One wake of the PC whose helper key is `wakePub` (base64url), named `name` in the errors, through `link`.
    public static func send(link: RelayLink, seed: Bytes, wakePub: String?, name: String, now: Int64, nonce: String = Crypto.b64url(Crypto.random(18))) throws {
        guard let wakePub = wakePub, let key = Crypto.fromB64url(wakePub), key.count == 32 else {
            throw AutarkError("\(name) runs an Autark that cannot be woken yet – start it there once.")
        }
        let wakeFp = Crypto.fingerprint(key)
        let found = try link.find(remoteId: Crypto.remoteId(wakeFp))
        guard let helper = found.first(where: { $0.fingerprint == wakeFp }) else {
            throw AutarkError("\(name) is not waiting at the meeting server – the PC is off or asleep, has no internet, or its app was not closed from the app.")
        }
        let reply = try link.request(helper, body: body(seed: seed, wakeFp: wakeFp, box: helper.box, at: now, nonce: nonce), timeoutMs: replyMs)
        if reply["ok"] as? Bool != true {
            throw AutarkError("\(name) did not take the wake from this phone – its app was closed before it knew this phone. Wake it from another PC, or start it there once.")
        }
    }
}
