// Owns: what PeerChannel runs over – a tunnel through the meeting server (Tunnel) or this phone's own socket straight to the PC
// (DirectPipe) – and the thin seams to the platform's WebSocket (the app plugs in URLSession; the host tests plug in an in-memory
// meeting server or PC). Ported from relay/Pipe.java. `direct` is false for a tunnel, and probe/checkAlive are no-ops for it (its
// server link is probed by RelayLink); a direct socket pings and watches itself.
// Never: decides trust (the pinned handshake in PeerChannel does).
import Foundation

public protocol PipeListener: AnyObject {
    func message(_ data: Bytes, text: Bool)
    func closed()
}

public protocol LinkPipe: AnyObject {
    func listen(_ listener: PipeListener)
    var isClosed: Bool { get }
    func sendText(_ text: String)
    func sendBinary(_ data: Bytes)
    func close()
    /// True for a socket straight to the PC, false for a tunnel through the meeting server.
    var direct: Bool { get }
    /// Pings now and ends the pipe when nothing answers within RelayLink.probeMs (a tunnel's server link is probed itself).
    func probe()
    /// Ends (by a probe) a pipe silent for a while (a tunnel's server link has its own check).
    func checkAlive()
}

public extension LinkPipe {
    func probe() {}
    func checkAlive() {}
}

/// What a meeting-server socket tells its owner (called on the platform's reader thread).
public protocol WebSocketListener: AnyObject {
    func text(_ text: String)
    func binary(_ data: Bytes)
    func closed(_ reason: String)
}

/// One open WebSocket. `start()` begins delivering frames to the listener (nothing arrives before it).
public protocol WebSocketLink: AnyObject {
    func start()
    func sendText(_ text: String) throws
    func sendBinary(_ data: Bytes) throws
    /// A ping frame; its pong counts as a frame.
    func ping() throws
    func close()
    /// Ends a stuck connection at once, the listener hears `closed` once.
    func kill()
    var isClosed: Bool { get }
    /// Seconds since 1970 of the last frame of any kind.
    var lastFrameAt: TimeInterval { get }
    /// Frames read so far.
    var frames: Int { get }
}

/// What a connect may take: how long the TCP connect and the upgrade get, and the biggest message the socket accepts.
public struct WebSocketOptions: Equatable {
    public var connectTimeoutMs: Int
    public var maxMessage: Int
    /// Extra request headers of the upgrade (UseLink: the local entrance's gate cookie); none for the meeting server and the PCs.
    public var headers: [String: String]
    public init(connectTimeoutMs: Int, maxMessage: Int, headers: [String: String] = [:]) {
        self.connectTimeoutMs = connectTimeoutMs; self.maxMessage = maxMessage; self.headers = headers
    }
    /// The meeting server: 15 s, 2 MiB.
    public static let relay = WebSocketOptions(connectTimeoutMs: 15_000, maxMessage: 2 * 1024 * 1024)
}

public protocol WebSocketConnector {
    /// Connects and upgrades (wss with the platform's normal certificate checks); returns once the upgrade is done.
    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink
    /// The same with its own limits (a direct socket to a PC: a short connect, 8 MiB frames). A connector that only knows the
    /// first form ignores them.
    func connect(url: String, listener: WebSocketListener, options: WebSocketOptions) throws -> WebSocketLink
}

public extension WebSocketConnector {
    func connect(url: String, listener: WebSocketListener, options: WebSocketOptions) throws -> WebSocketLink {
        try connect(url: url, listener: listener)
    }
}
