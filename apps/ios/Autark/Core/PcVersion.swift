// Owns: learning which Autark version a PC runs, with one small request over its new channel – stream 0 of the stream
// protocol (rendezvous/phone.ts; the local entrance numbers its streams from 1) carries one bearer `POST /rpc`
// `system.info` with this phone's own token to the PC's own runtime port, and the answer's `version` comes back – and
// ordering two versions (0.3.10 > 0.3.9 > 0.3.9-local.2 > 0.3.9-local.1; an unknown one is the oldest). Ported from
// relay/PcVersion.java.
// Never: keeps the channel's stream open after the answer, half-closes before it (the PC would cut the request), or
// sends anything but that one request.
import Foundation

public final class PcVersion {
    /// The stream number of this request; the local entrance's streams start at 1.
    static let stream = 0
    private static let maxAnswer = 64 * 1024

    private let send: (JSONObject) -> Void
    private let lock = NSLock()
    private var answer = Bytes()
    private let ended = Future<Bool>()

    /// `send`: a message onto the channel (PeerChannel.send).
    public init(send: @escaping (JSONObject) -> Void) { self.send = send }

    /// True for a message of this request's stream (the channel's listener hands it to deliver).
    public static func mine(_ message: JSONObject) -> Bool { Json.num(message, "s", -1) == stream }

    /// The PC's version, or nil when it did not answer within `timeoutMs` or the answer has none.
    public func fetch(token: String, timeoutMs: Int) -> String? {
        let body = Crypto.utf8(Json.write(["id": 1, "method": "system.info"] as JSONObject))
        let head = "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer \(token)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        let request = Crypto.utf8(head) + body
        send(["t": "o", "s": PcVersion.stream])
        send(["t": "d", "s": PcVersion.stream, "b": Crypto.b64Std(request)])
        let done = (try? ended.get(timeout: Double(timeoutMs) / 1000)) != nil
        if !done { send(["t": "e", "s": PcVersion.stream]) } // the PC still holds the request: it ends there now
        lock.lock()
        let whole = answer
        lock.unlock()
        return PcVersion.versionOf(Crypto.string(whole))
    }

    /// A message of stream 0 from the PC: its bytes or its end.
    public func deliver(_ message: JSONObject) {
        let type = Json.str(message, "t")
        if type == "e" { ended.complete(true); return }
        guard type == "d", let b = Json.str(message, "b"), let data = Crypto.fromB64Std(b) else { return }
        // No acknowledgement: the answer is far below the PC's window, and the reader thread this runs on never sends.
        lock.lock()
        if answer.count + data.count <= PcVersion.maxAnswer { answer.append(contentsOf: data) }
        lock.unlock()
    }

    /// The `result.version` of an HTTP 200 answer with a JSON body, or nil.
    public static func versionOf(_ response: String) -> String? {
        guard response.hasPrefix("HTTP/1.1 200"), let split = response.range(of: "\r\n\r\n") else { return nil }
        let bodyText = response[split.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        guard let object = try? Json.object(bodyText), let result = object["result"] as? JSONObject, let version = Json.str(result, "version") else { return nil }
        let allowed = Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-")
        return version.count >= 1 && version.count <= 64 && version.allSatisfy({ allowed.contains($0) }) ? version : nil
    }

    /// Orders versions like semver: numbers first, then a release above its pre-releases; nil is the oldest.
    public static func compare(_ a: String?, _ b: String?) -> Int {
        guard let a = a, let b = b else { return a == nil ? (b == nil ? 0 : -1) : 1 }
        let x = a.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let y = b.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let core = parts(x[0], y[0])
        if core != 0 { return core }
        if x.count != y.count { return x.count < y.count ? 1 : -1 } // 0.3.9 > 0.3.9-local.1
        return x.count == 1 ? 0 : parts(x[1], y[1])
    }

    /// Dot-separated identifiers: numbers by value, below words; words by text; a shorter list first.
    private static func parts(_ a: String, _ b: String) -> Int {
        let x = a.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let y = b.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        for i in 0..<max(x.count, y.count) {
            if i >= x.count || i >= y.count { return i >= x.count ? -1 : 1 }
            let nx = isNumber(x[i]), ny = isNumber(y[i])
            var c = 0
            if nx && ny { let l = Int(x[i])!, r = Int(y[i])!; c = l < r ? -1 : (l > r ? 1 : 0) }
            else if nx != ny { c = nx ? -1 : 1 }
            else { c = x[i] < y[i] ? -1 : (x[i] > y[i] ? 1 : 0) }
            if c != 0 { return c }
        }
        return 0
    }

    private static func isNumber(_ text: String) -> Bool {
        text.count >= 1 && text.count <= 9 && text.allSatisfy { $0.isASCII && $0.isNumber }
    }
}
