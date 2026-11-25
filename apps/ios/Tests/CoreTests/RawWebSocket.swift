// Owns: a small RFC 6455 client over plain TCP (ws:// to 127.0.0.1 only) for the host tests – the Linux URLSession cannot do
// WebSockets (its libcurl has none), and the interop test must reach the real meeting server. Masked frames, fragments, ping/pong,
// close; the core's WebSocketLink on top. Not shipped: the app uses URLSession (Autark/Platform/URLSessionSocket.swift).
// Never: wss, a host other than loopback, or any use outside tests.
import Foundation
@testable import AutarkCore

struct RawWebSocketConnector: WebSocketConnector {
    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink {
        guard let parts = URLComponents(string: url), parts.scheme == "ws", parts.host == "127.0.0.1", let port = parts.port else { throw AutarkError("ws://127.0.0.1:<port> only") }
        let path = parts.path.isEmpty ? "/" : parts.path
        guard let tcp = TcpConnection.connect(port: port) else { throw AutarkError("The meeting server did not answer.") }
        let key = Crypto.b64Std(Crypto.random(16))
        tcp.write(Crypto.utf8("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n"))
        var head = Bytes()
        while true {
            guard let part = tcp.read(max: 4096, timeoutSeconds: 10) else { throw AutarkError("The meeting server did not answer.") }
            head.append(contentsOf: part)
            if let end = RawWebSocket.find(head, [13, 10, 13, 10]) {
                let text = Crypto.string(Bytes(head[0..<end]))
                if !text.hasPrefix("HTTP/1.1 101") { throw AutarkError("The meeting server refused the upgrade.") }
                return RawWebSocket(tcp: tcp, listener: listener, leftover: Bytes(head[(end + 4)...]))
            }
            if head.count > 16 * 1024 { throw AutarkError("The meeting server did not answer.") }
        }
    }
}

final class RawWebSocket: WebSocketLink {
    private let tcp: TcpConnection
    private weak var listener: WebSocketListener?
    private let lock = NSLock()
    private let sendLock = NSLock()
    private var buffer: Bytes
    private var closedFlag = false
    private var started = false
    private var last = Date().timeIntervalSince1970
    private var count = 0

    init(tcp: TcpConnection, listener: WebSocketListener, leftover: Bytes) {
        self.tcp = tcp
        self.listener = listener
        self.buffer = leftover
    }

    static func find(_ data: Bytes, _ needle: Bytes) -> Int? {
        if data.count < needle.count { return nil }
        for i in 0...(data.count - needle.count) where Array(data[i..<(i + needle.count)]) == needle { return i }
        return nil
    }

    func start() {
        lock.lock(); if started { lock.unlock(); return }; started = true; lock.unlock()
        spawn("raw-ws-reader") { [self] in readLoop() }
    }

    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var lastFrameAt: TimeInterval { lock.lock(); defer { lock.unlock() }; return last }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return count }

    private func need(_ n: Int) -> Bool {
        while buffer.count < n {
            guard let part = tcp.read(max: 64 * 1024) else { return false }
            buffer.append(contentsOf: part)
        }
        return true
    }

    private func take(_ n: Int) -> Bytes { let out = Bytes(buffer[0..<n]); buffer.removeFirst(n); return out }

    private func readLoop() {
        var message = Bytes()
        var kind: UInt8 = 0
        while !isClosed {
            guard need(2) else { break }
            let h = take(2)
            let fin = h[0] & 0x80 != 0
            let opcode = h[0] & 0x0f
            var length = Int(h[1] & 0x7f)
            if length == 126 { guard need(2) else { break }; let e = take(2); length = Int(e[0]) << 8 | Int(e[1]) }
            else if length == 127 { guard need(8) else { break }; let e = take(8); length = e.reduce(0) { $0 << 8 | Int($1) } }
            guard need(length) else { break }
            let payload = take(length)
            lock.lock(); last = Date().timeIntervalSince1970; count += 1; lock.unlock()
            switch opcode {
            case 0x1, 0x2, 0x0:
                if opcode != 0 { kind = opcode; message = [] }
                message.append(contentsOf: payload)
                if fin {
                    if kind == 0x1 { listener?.text(Crypto.string(message)) } else { listener?.binary(message) }
                    message = []
                }
            case 0x9: try? send(opcode: 0xA, payload: payload)
            case 0x8: finish("closed by the server"); return
            default: break
            }
        }
        finish("connection ended")
    }

    private func send(opcode: UInt8, payload: Bytes) throws {
        if isClosed { throw AutarkError("closed") }
        var frame: Bytes = [0x80 | opcode]
        if payload.count < 126 { frame.append(0x80 | UInt8(payload.count)) }
        else if payload.count < 65536 { frame.append(0x80 | 126); frame.append(UInt8(payload.count >> 8)); frame.append(UInt8(payload.count & 0xff)) }
        else { frame.append(0x80 | 127); for i in (0..<8).reversed() { frame.append(UInt8((payload.count >> (8 * i)) & 0xff)) } }
        let mask = Crypto.random(4)
        frame.append(contentsOf: mask)
        for (i, b) in payload.enumerated() { frame.append(b ^ mask[i % 4]) }
        sendLock.lock(); defer { sendLock.unlock() }
        if !tcp.write(frame) { kill(); throw AutarkError("closed") }
    }

    func sendText(_ text: String) throws { try send(opcode: 0x1, payload: Crypto.utf8(text)) }
    func sendBinary(_ data: Bytes) throws { try send(opcode: 0x2, payload: data) }
    func ping() throws { try send(opcode: 0x9, payload: []) }
    func close() { finish("closed") }
    func kill() { finish("killed") }

    private func finish(_ reason: String) {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let target = listener
        lock.unlock()
        tcp.shutdown()
        target?.closed(reason)
    }
}
