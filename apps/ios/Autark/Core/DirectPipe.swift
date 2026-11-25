// Owns: this phone's own socket straight to a PC's peer listener – `<address>/peer/phone` as ws:// or wss:// (the PC's LAN,
// tailnet, router-mapped or IPv6 address, from the pairing or from the PC's phone.pcs answer) – as a LinkPipe: plain text frames for
// the handshake, binary for the encrypted channel, a PC's 8 MiB frames like a tunnel. The PC pings it every 30 s; URLSession answers
// those pings itself and shows them to nobody, so checkAlive() pings after 25 s of quiet and probe() ends the socket when no frame at
// all (a pong included) arrives within 2 s (foreground, network change). Ported from relay/DirectPipe.java.
// Never: decides trust (the pinned handshake in PeerChannel does), reconnects, or dials anything but http(s) addresses.
import Foundation

public final class DirectPipe: LinkPipe, WebSocketListener {
    /// A PC's channel frames are at most 8 MiB (devices/channel.ts), the same as a tunnel joins.
    public static let maxMessage = 8 * 1024 * 1024 + 1024
    /// One try per address: the TCP connect and the upgrade answer each within this (a LAN answers in milliseconds).
    public static let connectMs = 1_500
    /// Addresses tried at once per PC (the PC lists at most 8).
    public static let maxAddresses = 8
    /// Silence after which checkAlive() pings.
    static let quietSeconds: TimeInterval = 25
    public static let options = WebSocketOptions(connectTimeoutMs: connectMs, maxMessage: maxMessage)

    private let lock = NSLock()
    private var socket: WebSocketLink?
    private weak var listener: PipeListener?
    private var closedFlag = false
    private var startedFlag = false

    private init() {}

    /// Opens `url` (ws://host:port/peer/phone); throws when nothing answers within `connectMs`.
    public static func open(url: String, connector: WebSocketConnector) throws -> DirectPipe {
        let pipe = DirectPipe()
        let link = try connector.connect(url: url, listener: pipe, options: options)
        pipe.lock.lock(); pipe.socket = link; let gone = pipe.closedFlag; pipe.lock.unlock()
        if gone { throw AutarkError("The PC closed the direct connection.") }
        return pipe
    }

    /// `http(s)://host:port` → `ws(s)://host:port/peer/phone`; nil for anything else (a user name, a path-less relay: address, a bad port).
    public static func url(_ address: String?) -> String? {
        guard let address = address, address.count <= 200 else { return nil }
        let rest: Substring
        let secure: Bool
        let lower = address.lowercased()
        if lower.hasPrefix("http://") { secure = false; rest = address.dropFirst(7) }
        else if lower.hasPrefix("https://") { secure = true; rest = address.dropFirst(8) }
        else { return nil }
        let end = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? rest.endIndex
        let authority = String(rest[..<end])
        if authority.isEmpty || authority.contains("@") || authority.contains(where: { $0.isWhitespace }) { return nil }
        let host: String
        var port: String?
        if authority.hasPrefix("[") { // an IPv6 address keeps its brackets
            guard let close = authority.firstIndex(of: "]") else { return nil }
            host = String(authority[...close])
            let after = authority[authority.index(after: close)...]
            if !after.isEmpty {
                guard after.hasPrefix(":") else { return nil }
                port = String(after.dropFirst())
            }
            if host.count <= 2 || !host.dropFirst().dropLast().allSatisfy({ $0.isHexDigit || $0 == ":" || $0 == "." || $0 == "%" || $0.isLetter || $0.isNumber }) { return nil }
        } else {
            let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
            if parts.count > 2 || parts[0].isEmpty { return nil }
            host = String(parts[0])
            if parts.count == 2 { port = String(parts[1]) }
            if !host.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "." || $0 == "-" || $0 == "_" }) { return nil }
        }
        var portPart = ""
        if let port = port, !port.isEmpty {
            guard port.count <= 5, port.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(port), number > 0, number < 65536 else { return nil }
            portPart = ":" + port
        }
        return (secure ? "wss" : "ws") + "://" + host + portPart + "/peer/phone"
    }

    /// One opener per usable address, in the PC's order (at most `maxAddresses`).
    public static func openers(_ addresses: [String], connector: WebSocketConnector) -> [Route.Opener] {
        var out = [Route.Opener]()
        for address in addresses {
            guard out.count < maxAddresses, let url = url(address) else { continue }
            out.append { try DirectPipe.open(url: url, connector: connector) }
        }
        return out
    }

    // MARK: LinkPipe

    /// Starts delivering frames: nothing reaches the listener before it is set.
    public func listen(_ listener: PipeListener) {
        lock.lock()
        self.listener = listener
        let go = !startedFlag && !closedFlag
        startedFlag = true
        let link = socket
        lock.unlock()
        if go { link?.start() }
    }

    public var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }

    public var direct: Bool { true }

    private func current() -> WebSocketLink? { lock.lock(); defer { lock.unlock() }; return socket }

    public func sendText(_ text: String) {
        guard let link = current() else { return }
        do { try link.sendText(text) } catch { link.kill() }
    }

    public func sendBinary(_ data: Bytes) {
        guard let link = current() else { return }
        do { try link.sendBinary(data) } catch { link.kill() }
    }

    public func close() {
        if let link = current() { link.close() } else { closed("closed") }
    }

    public func probe() {
        guard let link = current(), !isClosed else { return }
        let before = link.frames
        later(milliseconds: RelayLink.probeMs) { if link.frames == before { link.kill() } }
        do { try link.ping() } catch { link.kill() }
    }

    public func checkAlive() {
        guard let link = current(), !isClosed else { return }
        if Date().timeIntervalSince1970 - link.lastFrameAt > DirectPipe.quietSeconds { probe() }
    }

    // MARK: WebSocketListener (the platform's reader thread)

    public func text(_ text: String) {
        lock.lock(); let target = listener; lock.unlock()
        target?.message(Crypto.utf8(text), text: true)
    }

    public func binary(_ data: Bytes) {
        lock.lock(); let target = listener; lock.unlock()
        target?.message(data, text: false)
    }

    public func closed(_ reason: String) {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let target = listener
        lock.unlock()
        target?.closed()
    }
}
