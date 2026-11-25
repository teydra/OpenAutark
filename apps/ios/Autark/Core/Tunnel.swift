// Owns: one meeting-server tunnel exactly as rendezvous/tunnel.ts frames it – [u32 tunnel id][flags][≤ 60 KiB chunk], flag
// MORE joins chunks, text (handshake) frames sealed to the other device with the counter cipher of seal.ts. A LinkPipe.
// Ported from relay/Tunnel.java.
// Never: decides trust (the peer handshake does) or holds more than one message being joined.
import Foundation

public protocol TunnelLink: AnyObject {
    func send(_ frame: Bytes)
    func close(_ tid: Int)
}

public final class Tunnel: LinkPipe {
    static let header = 5
    static let chunk = 60 * 1024
    private static let textFlag: UInt8 = 1
    private static let moreFlag: UInt8 = 2
    private static let maxMessage = 8 * 1024 * 1024 + 1024

    public let tid: Int
    let peer: String
    private let link: TunnelLink
    private let sendKey: Bytes
    private let receiveKey: Bytes
    private let sendLock = NSLock()
    private let state = NSLock()
    private var sent: UInt64 = 0
    private var received: UInt64 = 0
    private var parts = Bytes()
    private weak var listener: PipeListener?
    private var closedFlag = false

    public init(tid: Int, peer: String, link: TunnelLink, sendKey: Bytes, receiveKey: Bytes) {
        self.tid = tid; self.peer = peer; self.link = link; self.sendKey = sendKey; self.receiveKey = receiveKey
    }

    public func listen(_ listener: PipeListener) { state.lock(); self.listener = listener; state.unlock() }

    public var isClosed: Bool { state.lock(); defer { state.unlock() }; return closedFlag }

    public var direct: Bool { false }

    public func sendText(_ text: String) {
        sendLock.lock(); defer { sendLock.unlock() }
        guard let sealed = try? Crypto.seal(key: sendKey, counter: sent, plain: Crypto.utf8(text)) else { close(); return }
        sent += 1
        frames(sealed, text: true)
    }

    public func sendBinary(_ data: Bytes) {
        sendLock.lock(); defer { sendLock.unlock() }
        frames(data, text: false)
    }

    private func frames(_ body: Bytes, text: Bool) {
        if isClosed { return }
        var offset = 0
        repeat {
            let length = min(Tunnel.chunk, body.count - offset)
            let more = offset + length < body.count
            var frame = Bytes()
            frame.reserveCapacity(Tunnel.header + length)
            frame.append(UInt8((tid >> 24) & 0xff)); frame.append(UInt8((tid >> 16) & 0xff)); frame.append(UInt8((tid >> 8) & 0xff)); frame.append(UInt8(tid & 0xff))
            frame.append((text ? Tunnel.textFlag : 0) | (more ? Tunnel.moreFlag : 0))
            frame.append(contentsOf: body[offset..<(offset + length)])
            link.send(frame)
            offset += length
        } while offset < body.count
    }

    /// A binary frame from the server for this tunnel (called on the reader thread).
    func receive(_ frame: Bytes) {
        if isClosed || frame.count < Tunnel.header { return }
        let flags = frame[4]
        parts.append(contentsOf: frame[Tunnel.header...])
        if parts.count > Tunnel.maxMessage { close(); return }
        if flags & Tunnel.moreFlag != 0 { return }
        var whole = parts
        parts = Bytes()
        let text = flags & Tunnel.textFlag != 0
        if text {
            state.lock()
            let counter = received
            state.unlock()
            guard let plain = Crypto.open(key: receiveKey, counter: counter, sealed: whole) else { close(); return }
            state.lock(); received += 1; state.unlock()
            whole = plain
        }
        state.lock()
        let target = listener
        state.unlock()
        target?.message(whole, text: text)
    }

    public func close() {
        state.lock()
        if closedFlag { state.unlock(); return }
        state.unlock()
        link.close(tid)
        ended()
    }

    /// The server or the connection ended the tunnel.
    func ended() {
        state.lock()
        if closedFlag { state.unlock(); return }
        closedFlag = true
        let target = listener
        state.unlock()
        target?.closed()
    }
}
