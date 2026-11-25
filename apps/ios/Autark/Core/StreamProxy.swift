// Owns: the phone's local entrance to its PC – a listener on 127.0.0.1 only the app's own WKWebView passes (its first
// request carries the app's private gate cookie), each TCP connection one stream over the encrypted peer channel to the
// PC's own runtime port (rendezvous/phone.ts: o/d/a/e messages, at most `window` unacknowledged bytes per direction).
// The WebView therefore shows the PC's unchanged phone UI at http://127.0.0.1:<port>, a secure context like https.
// A request whose channel dies before the PC answered gets a 503 instead of hanging; one that hears nothing for 4 s has the
// link probed once, so a dead link is found within seconds. The phone holds channels to several PCs; a new stream takes
// the page's one (Channels.waitChannel) and retire() ends the streams left on the others. Ported from relay/StreamProxy.java.
// Never: listens beyond loopback, lets another app's connection through, or buffers without bound.
import Foundation

/// The current channel to the PC, waited for up to a few seconds when a stream starts.
public protocol Channels: AnyObject {
    func waitChannel(timeoutMs: Int) -> PeerChannel?
    /// The page's channel now, or nil (never waits).
    func usedChannel() -> PeerChannel?
    /// A stream heard nothing for a while: check the link now (a dead one ends, its streams get their 503).
    func probe()
}

public final class StreamProxy {
    public static let gateCookie = "autark_gate"
    static let window = 256 * 1024
    private static let chunk = 32 * 1024
    private static let quietMs = 4_000

    private enum Item { case data(Bytes), end, dead }

    private final class Stream {
        let id: Int
        let channel: PeerChannel
        let conn: TcpConnection
        let toLocal = BlockingQueue<Item>()
        let cond = NSCondition()
        var unacked = 0
        var done = false
        var answered = false
        init(id: Int, channel: PeerChannel, conn: TcpConnection) { self.id = id; self.channel = channel; self.conn = conn }
    }

    private let listener: LoopbackListener
    private let gate: String
    private weak var channels: Channels?
    private let lock = NSLock()
    private var live = [ObjectIdentifier: (channel: PeerChannel, streams: [Int: Stream])]()
    private var nextId = 1
    private var closedFlag = false
    /// How long a new request waits for a channel before it gets its 503 (a slow PC is still being opened meanwhile).
    public var channelWaitMs = 20_000

    /// Listens on 127.0.0.1:`port` (0 or a taken port: any free one).
    public init(port: Int, gate: String, channels: Channels) throws {
        self.gate = gate
        self.channels = channels
        self.listener = try LoopbackListener(port: port)
        let listener = self.listener
        spawn("autark-proxy") { [weak self] in
            while let conn = listener.accept() {
                guard let me = self else { return }
                spawn("autark-stream") { me.serve(conn) }
            }
        }
    }

    public var port: Int { listener.port }

    public var origin: String { "http://127.0.0.1:\(port)" }

    public func close() {
        lock.lock(); closedFlag = true; lock.unlock()
        listener.close()
    }

    /// Messages of a channel from the PC: the bytes and acknowledgements of this proxy's streams.
    public func deliver(_ channel: PeerChannel, _ message: JSONObject) {
        lock.lock()
        let stream = live[ObjectIdentifier(channel)]?.streams[Json.num(message, "s", -1)]
        lock.unlock()
        guard let target = stream else { return }
        switch Json.str(message, "t") {
        case "d": if let b = Json.str(message, "b"), let data = Crypto.fromB64Std(b) { target.toLocal.offer(.data(data)) }
        case "a": acked(target, Json.num(message, "n", 0))
        case "e": target.toLocal.offer(.end)
        default: break
        }
    }

    /// The channel ended: its streams end (503 where the PC had not answered yet), the WebView reconnects on its own.
    public func channelClosed(_ channel: PeerChannel) {
        lock.lock()
        let entry = live.removeValue(forKey: ObjectIdentifier(channel))
        lock.unlock()
        if let streams = entry?.streams.values { for stream in streams { stream.toLocal.offer(.dead) } }
    }

    /// The page moved to `keep`: streams still on another PC's channel end there too (that PC hears it), so the page's
    /// sockets come back through `keep`; the other channels stay open.
    public func retire(keep: PeerChannel) {
        lock.lock()
        var others = [Stream]()
        for (key, entry) in live where key != ObjectIdentifier(keep) { others.append(contentsOf: entry.streams.values) }
        lock.unlock()
        for stream in others { stream.toLocal.offer(.dead); finish(stream, tell: true) }
    }

    /// For a test or the status line: open streams over all channels.
    public var openStreams: Int {
        lock.lock(); defer { lock.unlock() }
        return live.values.reduce(0) { $0 + $1.streams.count }
    }

    // MARK: one connection

    private func unavailable(_ conn: TcpConnection) {
        let body = Crypto.utf8("Your PC is not reachable right now. Autark must be running on it.")
        conn.write(Crypto.utf8("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n") + body)
    }

    private func serve(_ conn: TcpConnection) {
        guard let head = readHead(conn), hasGate(String(decoding: head.header, as: UTF8.self)) else {
            conn.write(Crypto.utf8("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
            conn.shutdown()
            return
        }
        guard let channel = channels?.waitChannel(timeoutMs: channelWaitMs), !channel.isClosed else {
            unavailable(conn)
            conn.shutdown()
            return
        }
        lock.lock()
        let id = nextId
        nextId += 1
        let stream = Stream(id: id, channel: channel, conn: conn)
        let key = ObjectIdentifier(channel)
        var entry = live[key] ?? (channel: channel, streams: [:])
        entry.streams[id] = stream
        live[key] = entry
        lock.unlock()
        if channel.isClosed { channelClosed(channel) }
        if channels?.usedChannel() !== channel { unavailable(conn); finish(stream, tell: false); return } // the page moved meanwhile: one PC per page
        channel.send(["t": "o", "s": id] as JSONObject)
        startWriter(stream)
        later(milliseconds: StreamProxy.quietMs) { [weak self] in
            stream.cond.lock(); let waiting = !stream.answered && !stream.done; stream.cond.unlock()
            if waiting { self?.channels?.probe() }
        }
        _ = upload(stream, head.all)
        while let chunk = conn.read(max: StreamProxy.chunk) {
            if !upload(stream, chunk) { break }
        }
        finish(stream, tell: true)
    }

    /// The first request head: all bytes read so far and the header part (through the empty line); nil when it is not one.
    private func readHead(_ conn: TcpConnection) -> (all: Bytes, header: Bytes)? {
        var all = Bytes()
        let end: Bytes = [13, 10, 13, 10]
        while all.count <= 32 * 1024 {
            guard let part = conn.read(max: 8192, timeoutSeconds: 15) else { return nil }
            all.append(contentsOf: part)
            let from = max(0, all.count - part.count - 3)
            var at = from
            while at + 4 <= all.count {
                if all[at] == end[0] && all[at + 1] == end[1] && all[at + 2] == end[2] && all[at + 3] == end[3] {
                    return (all, Bytes(all[0..<(at + 4)]))
                }
                at += 1
            }
        }
        return nil
    }

    private func hasGate(_ head: String) -> Bool {
        for line in head.components(separatedBy: "\r\n") {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { continue }
            if line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased() != "cookie" { continue }
            for part in line[line.index(after: colon)...].split(separator: ";") {
                let pair = part.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                if pair.count == 2, pair[0] == StreamProxy.gateCookie, StreamProxy.constantEquals(String(pair[1]), gate) { return true }
            }
        }
        return false
    }

    private static func constantEquals(_ a: String, _ b: String) -> Bool {
        Crypto.constantEquals(Crypto.sha256(Crypto.utf8(a)), Crypto.sha256(Crypto.utf8(b)))
    }

    // MARK: a stream

    /// Bytes from the PC go to the WebView on a thread of their own; each written chunk is acknowledged.
    private func startWriter(_ stream: Stream) {
        spawn("autark-stream-out") { [weak self] in
            loop: while true {
                switch stream.toLocal.take() {
                case .data(let data):
                    stream.cond.lock(); stream.answered = true; stream.cond.unlock()
                    if !stream.conn.write(data) { break loop }
                    stream.channel.send(["t": "a", "s": stream.id, "n": data.count] as JSONObject)
                case .end:
                    break loop
                case .dead:
                    stream.cond.lock(); let answered = stream.answered; stream.cond.unlock()
                    if !answered { self?.unavailable(stream.conn) }
                    break loop
                }
            }
            if let me = self { me.finish(stream, tell: true) } else { stream.conn.shutdown() }
        }
    }

    /// Sends bytes to the PC, waiting while `window` bytes are unacknowledged; false once the stream ended.
    private func upload(_ stream: Stream, _ data: Bytes) -> Bool {
        stream.cond.lock()
        while !stream.done && stream.unacked >= StreamProxy.window {
            _ = stream.cond.wait(until: Date().addingTimeInterval(1))
            if stream.channel.isClosed { stream.done = true }
        }
        if stream.done { stream.cond.unlock(); return false }
        stream.unacked += data.count
        stream.cond.unlock()
        stream.channel.send(["t": "d", "s": stream.id, "b": Crypto.b64Std(data)] as JSONObject)
        return true
    }

    private func acked(_ stream: Stream, _ n: Int) {
        stream.cond.lock()
        stream.unacked = max(0, stream.unacked - n)
        stream.cond.broadcast()
        stream.cond.unlock()
    }

    private func finish(_ stream: Stream, tell: Bool) {
        stream.cond.lock()
        if stream.done && stream.conn.isShutdown { stream.cond.unlock(); return }
        stream.done = true
        stream.cond.broadcast()
        stream.cond.unlock()
        lock.lock()
        let key = ObjectIdentifier(stream.channel)
        let mine = live[key]?.streams[stream.id] != nil
        if mine { live[key]?.streams[stream.id] = nil }
        lock.unlock()
        if tell && mine { stream.channel.send(["t": "e", "s": stream.id] as JSONObject) }
        stream.toLocal.offer(.end)
        stream.conn.shutdown()
    }
}
