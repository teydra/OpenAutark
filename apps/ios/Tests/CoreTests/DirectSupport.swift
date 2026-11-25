// Test stand-ins for the direct way: a PC's peer listener (`/peer/phone`) in this process – each connect to a hosted address
// makes a WebSocketLink over an in-memory pipe to the PC's side of the peer handshake and its stream server (TestSupport) – a
// connector that sends wss:// to the in-process meeting server and ws:// to those listeners, and a plain LinkPipe for Route.
// Written from the desktop sources (http/peer.ts, rendezvous/phone.ts), not from the Swift code under test.
import Foundation
@testable import AutarkCore

/// A WebSocketLink over one end of a MemoryPipe: what URLSession would give the app for a direct socket.
final class PipeSocket: WebSocketLink, PipeListener {
    private let pipe: MemoryPipe
    private weak var listener: WebSocketListener?
    private let lock = NSLock()
    private var closedFlag = false
    private var last = Date().timeIntervalSince1970
    private var count = 0
    private(set) var pings = 0
    /// False: the other end never answers a ping (a dead Wi-Fi).
    var answerPings = true

    init(pipe: MemoryPipe, listener: WebSocketListener) {
        self.pipe = pipe
        self.listener = listener
        pipe.listen(self)
    }

    func start() {}
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var lastFrameAt: TimeInterval { lock.lock(); defer { lock.unlock() }; return last }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return count }

    private func touch() { lock.lock(); last = Date().timeIntervalSince1970; count += 1; lock.unlock() }

    /// Makes the socket look silent for `seconds` (checkAlive's quiet time).
    func backdate(_ seconds: TimeInterval) { lock.lock(); last -= seconds; lock.unlock() }

    func sendText(_ text: String) throws { if isClosed { throw AutarkError("closed") }; pipe.sendText(text) }
    func sendBinary(_ data: Bytes) throws { if isClosed { throw AutarkError("closed") }; pipe.sendBinary(data) }

    func ping() throws {
        if isClosed { throw AutarkError("closed") }
        lock.lock(); pings += 1; let answer = answerPings; lock.unlock()
        if answer { touch() }
    }

    func close() { pipe.close() }
    func kill() { pipe.close() }

    func message(_ data: Bytes, text: Bool) {
        touch()
        if text { listener?.text(Crypto.string(data)) } else { listener?.binary(data) }
    }

    func closed() {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        lock.unlock()
        listener?.closed("closed")
    }
}

/// The peer listeners of some PCs: `host` an address, and a connect to `ws://<address>/peer/phone` reaches it.
final class FakeDirect: WebSocketConnector {
    private struct Host { let pc: FakeRelay.Pc; let seed: Bytes? }
    private let lock = NSLock()
    private var hosts = [String: Host]()
    private(set) var attempts = [String]()
    private(set) var options = [WebSocketOptions]()
    private(set) var peers = [FakePcPeer]()
    private(set) var streams = [FakePcStreams]()
    private(set) var sockets = [PipeSocket]()
    /// How long a refused connect takes before it fails (a silent address).
    var failDelay: TimeInterval = 0
    var version = "0.9.9"
    var phonePcs: [JSONObject]?

    /// A PC listening on `address` ("192.168.1.20:47812"); `impostorSeed`: another device with another key answers there.
    func host(_ address: String, pc: FakeRelay.Pc, impostorSeed: Bytes? = nil) {
        lock.lock(); hosts[address] = Host(pc: pc, seed: impostorSeed); lock.unlock()
    }

    func unhost(_ address: String) { lock.lock(); hosts[address] = nil; lock.unlock() }

    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink {
        try connect(url: url, listener: listener, options: .relay)
    }

    func connect(url: String, listener: WebSocketListener, options: WebSocketOptions) throws -> WebSocketLink {
        lock.lock(); attempts.append(url); self.options.append(options); lock.unlock()
        let suffix = "/peer/phone"
        guard url.hasPrefix("ws://"), url.hasSuffix(suffix) else { throw AutarkError("not a peer address") }
        let address = String(url.dropFirst(5).dropLast(suffix.count))
        lock.lock(); let entry = hosts[address]; let delay = failDelay; lock.unlock()
        guard let host = entry else {
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            throw AutarkError("The connection was refused.")
        }
        let (phoneEnd, pcEnd) = MemoryPipe.pair()
        let peer = FakePcPeer(pipe: pcEnd, seed: host.seed ?? host.pc.seed, trustedPhone: nil)
        let served = FakePcStreams(peer: peer)
        served.version = version
        served.phonePcs = phonePcs
        let socket = PipeSocket(pipe: phoneEnd, listener: listener)
        lock.lock(); peers.append(peer); streams.append(served); sockets.append(socket); lock.unlock()
        return socket
    }
}

/// wss:// goes to the meeting server, ws:// to the PCs' peer listeners (what URLSession would do with the real network).
final class CombinedConnector: WebSocketConnector {
    let relay: WebSocketConnector
    let direct: WebSocketConnector
    init(relay: WebSocketConnector, direct: WebSocketConnector) { self.relay = relay; self.direct = direct }

    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink {
        try connect(url: url, listener: listener, options: .relay)
    }

    func connect(url: String, listener: WebSocketListener, options: WebSocketOptions) throws -> WebSocketLink {
        if url.hasPrefix("wss://") { return try relay.connect(url: url, listener: listener, options: options) }
        return try direct.connect(url: url, listener: listener, options: options)
    }
}

/// A pipe that does nothing but remember what happened to it (Route's tests).
final class FakePipe: LinkPipe {
    let name: String
    private let isDirect: Bool
    private let lock = NSLock()
    private var closedFlag = false
    init(_ name: String, direct: Bool) { self.name = name; self.isDirect = direct }
    func listen(_ listener: PipeListener) {}
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var direct: Bool { isDirect }
    func sendText(_ text: String) {}
    func sendBinary(_ data: Bytes) {}
    func close() { lock.lock(); closedFlag = true; lock.unlock() }
}
