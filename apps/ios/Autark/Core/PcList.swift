// Owns: learning the company's PCs – their keys and their peer-listener addresses – from the PC the page uses, with one small request
// over its channel: stream 1_000_000_000 of the stream protocol (rendezvous/phone.ts; the local entrance numbers its streams from 1)
// carries one bearer `POST /rpc` `phone.pcs` with this phone's own token to the PC's runtime port. The PC answers
// with `myPcs` (runtime/rpc/handlers/phone-use.ts): every PC of the person with its key and, F29, up to 8 addresses. Android gets the
// same list from `phoneUse.attach`, which an iPhone does not claim (no phone use on iOS); the iPhone web app asks `phone.pcs` too.
// Each row is checked like a stored one (fingerprint = SHA-256 of the key, PhonePairing.pcsOf).
// Never: keeps the channel's stream open after the answer, half-closes before it, or sends anything but that one request.
import Foundation

public final class PcList {
    /// The stream number of this request; the local entrance's streams start at 1.
    static let stream = 1_000_000_000
    private static let maxAnswer = 256 * 1024

    private let send: (JSONObject) -> Void
    private let lock = NSLock()
    private var answer = Bytes()
    private let ended = Future<Bool>()

    /// `send`: a message onto the channel (PeerChannel.send).
    public init(send: @escaping (JSONObject) -> Void) { self.send = send }

    /// True for a message of this request's stream (the channel's listener hands it to deliver).
    public static func mine(_ message: JSONObject) -> Bool { Json.num(message, "s", -1) == stream }

    /// The PCs the PC listed, or nil when it did not answer within `timeoutMs` (an older PC has no phone.pcs) or the answer has none.
    public func fetch(token: String, timeoutMs: Int) -> [Pc]? {
        let body = Crypto.utf8(Json.write(["id": 1, "method": "phone.pcs"] as JSONObject))
        let head = "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer \(token)\r\nContent-Type: application/json\r\nX-Workforce-Protocol: 1\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        send(["t": "o", "s": PcList.stream])
        send(["t": "d", "s": PcList.stream, "b": Crypto.b64Std(Crypto.utf8(head) + body)])
        let done = (try? ended.get(timeout: Double(timeoutMs) / 1000)) != nil
        if !done { send(["t": "e", "s": PcList.stream]) } // the PC still holds the request: it ends there now
        lock.lock()
        let whole = answer
        lock.unlock()
        return PcList.pcsOf(Crypto.string(whole))
    }

    /// A message of this stream from the PC: its bytes or its end.
    public func deliver(_ message: JSONObject) {
        let type = Json.str(message, "t")
        if type == "e" { ended.complete(true); return }
        guard type == "d", let b = Json.str(message, "b"), let data = Crypto.fromB64Std(b) else { return }
        lock.lock()
        if answer.count + data.count <= PcList.maxAnswer { answer.append(contentsOf: data) }
        lock.unlock()
    }

    /// The `result.pcs` of an HTTP 200 answer with a JSON body, as checked PCs (at most 16); nil when there are none.
    public static func pcsOf(_ response: String) -> [Pc]? {
        guard response.hasPrefix("HTTP/1.1 200"), let split = response.range(of: "\r\n\r\n") else { return nil }
        let bodyText = response[split.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        guard let object = try? Json.object(bodyText), let result = object["result"] as? JSONObject else { return nil }
        let pcs = PhonePairing.pcsOf(result["pcs"])
        return pcs.isEmpty ? nil : pcs
    }

    /// The list the phone keeps after the PC `reached` told its list: the PC reached stays (first) even when the list leaves it out
    /// (as the iPhone web app keeps it), the phone's own order and names are kept for the PCs it already knew, and the new ones follow.
    public static func merged(known: [Pc], told: [Pc], reached: String?) -> [Pc] {
        var out = [Pc]()
        for pc in known {
            if let fresh = told.first(where: { $0.fingerprint == pc.fingerprint && $0.publicKey == pc.publicKey }) {
                out.append(Pc(fingerprint: pc.fingerprint, publicKey: pc.publicKey, name: pc.name == "PC" ? fresh.name : pc.name,
                              deviceId: pc.deviceId.isEmpty ? fresh.deviceId : pc.deviceId, addresses: fresh.addresses))
            } else if pc.fingerprint == reached {
                out.append(pc) // the PC the page uses stays pinned
            } else if told.contains(where: { $0.fingerprint == pc.fingerprint }) {
                continue // the same fingerprint with another key: never pinned
            }
            // a PC the answering PC no longer lists is unpinned (it was removed there)
        }
        for pc in told where !out.contains(where: { $0.fingerprint == pc.fingerprint }) && !known.contains(where: { $0.fingerprint == pc.fingerprint }) {
            if out.count >= 16 { break } // the PC lists at most 16
            out.append(pc)
        }
        return out
    }
}
