// Owns: the byte layer of the Autark runner protocol, version 1 (workspace/apple-plattformen/PROTOKOLL-RUNNER.md, sections 1–3
// and 8): the preamble, frames (u32be jsonLen | u32be binLen | JSON | binary), their limits, the two-sided HMAC proof of the run
// token, the runner's environment (token, port, idle end) and the time limits per operation. Our own protocol – no HTTP, no
// sessions, no element ids. Never: sends the token, logs it, or depends on anything beyond Foundation + Crypto (runs on Linux).
import Foundation

public enum RunnerWire {
    public static let version = 1
    /// "ATKRUN1\n": the PC sends it first, the runner answers with the same 8 bytes.
    public static let preamble: Bytes = Array("ATKRUN1\n".utf8)
    public static let requestJsonMax = 262_144
    public static let answerJsonMax = 4_194_304
    public static let answerBinMax = 25_165_824
    public static let textMax = 400
    public static let swipePointsMax = 32
    public static let treeNodesMax = 3000
    public static let appsMax = 800
    public static let bundleMax = 155
    public static let urlMax = 2048

    /// One frame: both lengths big-endian, then the JSON object (sorted keys, UTF-8), then the raw attachment.
    public static func frame(_ json: JSONObject, _ binary: Bytes = []) -> Bytes {
        let body = Bytes(Json.write(json).utf8)
        var out = Bytes()
        out.reserveCapacity(8 + body.count + binary.count)
        out += u32(body.count)
        out += u32(binary.count)
        out += body
        out += binary
        return out
    }

    static func u32(_ value: Int) -> Bytes {
        let v = UInt32(truncatingIfNeeded: value)
        return [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]
    }

    // MARK: proof

    public static let runnerLabel = "ATKRUN1 runner"
    public static let pcLabel = "ATKRUN1 pc"

    /// HMAC-SHA256(key = token bytes, msg = label ‖ pcNonce ‖ runnerNonce) as lowercase hex.
    public static func proof(token: Bytes, label: String, pcNonce: Bytes, runnerNonce: Bytes) -> String {
        Crypto.hex(Crypto.hmacSHA256(key: token, data: Bytes(label.utf8) + pcNonce + runnerNonce))
    }

    /// Exactly `count` bytes written as 2·count hex digits (either case), else nil.
    public static func hexBytes(_ text: String?, count: Int) -> Bytes? {
        guard let text = text else { return nil }
        let digits = Array(text.utf8)
        guard digits.count == count * 2 else { return nil }
        var out = Bytes()
        out.reserveCapacity(count)
        var at = 0
        while at < digits.count {
            guard let high = nibble(digits[at]), let low = nibble(digits[at + 1]) else { return nil }
            out.append(high << 4 | low)
            at += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }

    // MARK: environment (AUTARK_RUNNER_TOKEN, AUTARK_RUNNER_PORT, AUTARK_RUNNER_IDLE_S)

    /// The run token: 32 bytes as 64 hex characters. Anything else: nil – the runner then does not serve (there is no default).
    public static func token(_ text: String?) -> Bytes? { hexBytes(text, count: 32) }

    /// The port the PC chose: 49152–65535, else nil (the runner never picks another one).
    public static func port(_ text: String?) -> UInt16? {
        guard let text = text, let value = Int(text), (49152...65535).contains(value) else { return nil }
        return UInt16(value)
    }

    /// Seconds without an authenticated connection before the runner ends itself: 30–3600, default 300.
    public static func idleSeconds(_ text: String?) -> Int {
        guard let text = text, let value = Int(text) else { return 300 }
        return min(3600, max(30, value))
    }

    // MARK: time limits (section 8)

    /// How long the runner gives an operation before it answers `timeout`, in milliseconds.
    public static func limitMs(_ op: RunnerOp) -> Int {
        switch op {
        case .state: return 5000
        case .screenshot: return 10_000
        case .tree: return 20_000
        case .tap(_, _, _, let holdMs): return 5000 + holdMs
        case .swipe(let points): return (points.last?.t ?? 0) + 5000
        case .text: return 30_000
        case .button: return 5000
        case .openURL, .openBundle: return 20_000
        }
    }
}

/// Reads frames out of a byte stream that arrives in pieces of any size (one byte, or several frames glued together).
public struct RunnerFrameReader {
    private var buffer = Bytes()
    private var at = 0
    public let jsonMax: Int
    public let binMax: Int

    public init(jsonMax: Int, binMax: Int) {
        self.jsonMax = jsonMax
        self.binMax = binMax
    }

    public var buffered: Int { buffer.count - at }

    public mutating func push(_ bytes: Bytes) {
        if at > 0 && at == buffer.count {
            buffer.removeAll(keepingCapacity: true)
            at = 0
        } else if at > 65_536 {
            buffer.removeFirst(at)
            at = 0
        }
        buffer += bytes
    }

    /// Takes `count` raw bytes (the preamble), or nil while fewer are there.
    public mutating func take(_ count: Int) -> Bytes? {
        guard buffered >= count else { return nil }
        let out = Bytes(buffer[at..<(at + count)])
        at += count
        return out
    }

    /// The next whole frame, nil while it is incomplete. Throws on a frame outside the limits or one that is not a JSON object
    /// (the caller closes the connection then).
    public mutating func next() throws -> (json: JSONObject, binary: Bytes)? {
        guard buffered >= 8 else { return nil }
        let jsonLen = Self.int(buffer, at)
        let binLen = Self.int(buffer, at + 4)
        if jsonLen == 0 || jsonLen > jsonMax || binLen > binMax { throw AutarkError("frame outside the limits") }
        guard buffered >= 8 + jsonLen + binLen else { return nil }
        let start = at + 8
        guard let text = String(bytes: buffer[start..<(start + jsonLen)], encoding: .utf8) else { throw AutarkError("frame is not UTF-8") }
        let json = try Json.object(text)
        let binary = Bytes(buffer[(start + jsonLen)..<(start + jsonLen + binLen)])
        at = start + jsonLen + binLen
        return (json, binary)
    }

    private static func int(_ b: Bytes, _ i: Int) -> Int {
        Int(b[i]) << 24 | Int(b[i + 1]) << 16 | Int(b[i + 2]) << 8 | Int(b[i + 3])
    }
}
