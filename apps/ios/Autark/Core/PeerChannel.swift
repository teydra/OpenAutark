// Owns: the dialing side of Autark's peer handshake (devices/handshake.ts – ephemeral X25519, both device keys sign the
// transcript, HKDF into one AES-256-GCM key per direction) and the encrypted JSON channel after it (devices/channel.ts:
// [u64 counter][ciphertext‖tag], counters strictly increasing), over one LinkPipe: a meeting-server tunnel or a direct socket. Ported from
// relay/PeerChannel.java.
// Never: accepts a PC key other than the paired one, or a text frame after the handshake.
import Foundation

public protocol PeerListener: AnyObject {
    func message(_ message: JSONObject)
    func closed()
}

public final class PeerChannel: PipeListener {
    private enum Handshake { case text(String), closed }

    private static let maxFrame = 8 * 1024 * 1024

    private let tunnel: LinkPipe
    private let handshake = BlockingQueue<Handshake>()
    private let lock = NSRecursiveLock() // send() holds it while the tunnel writes; a failed write may end this channel on the same thread
    private var sendKey = Bytes()
    private var receiveKey = Bytes()
    private var sendCounter: UInt64 = 0
    private var receiveCounter: Int64 = -1
    private var ready = false
    private var closedFlag = false
    private var listener: PeerListener?

    private init(tunnel: LinkPipe) { self.tunnel = tunnel }

    /// Runs the handshake as the dialing side over `tunnel`; the PC must prove the key `pcPublicKey`.
    public static func connect(tunnel: LinkPipe, seed: Bytes, deviceId: String, pcPublicKey: Bytes, listener: PeerListener?) throws -> PeerChannel {
        let channel = PeerChannel(tunnel: tunnel)
        channel.listener = listener
        tunnel.listen(channel)
        if tunnel.isClosed { throw AutarkError("The tunnel closed.") }
        let pub = Crypto.ed25519Public(seed: seed)
        let eph = Crypto.x25519Pair()
        let nonce = Crypto.random(16)
        tunnel.sendText(Json.write(PeerHandshake.hello(deviceId: deviceId, pub: pub, eph: eph.pub, nonce: nonce)))
        guard let reply = channel.handshake.poll(timeout: 15), case .text(let welcomeText) = reply else {
            tunnel.close()
            throw AutarkError("Your PC did not answer the handshake.")
        }
        guard let welcome = try? Json.object(welcomeText) else { tunnel.close(); throw AutarkError("Bad handshake answer.") }
        let result: PeerHandshake.Result
        do { result = try PeerHandshake.finish(seed: seed, ephSecret: eph.secret, ephPub: eph.pub, nonce: nonce, welcome: welcome, pcPublicKey: pcPublicKey) }
        catch { tunnel.close(); throw error }
        channel.lock.lock()
        channel.sendKey = result.sendKey
        channel.receiveKey = result.receiveKey
        channel.ready = true
        channel.lock.unlock()
        tunnel.sendText(Json.write(result.auth))
        return channel
    }

    public var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }

    /// True while this channel runs straight to the PC (not through the meeting server).
    public var direct: Bool { tunnel.direct }

    /// Pings the PC now over a direct socket (nothing for a tunnel: its server link is probed itself).
    public func probe() { tunnel.probe() }

    /// A direct socket silent for a while is probed (nothing for a tunnel).
    public func checkAlive() { tunnel.checkAlive() }

    public func send(_ message: JSONObject) {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        let counter = sendCounter
        guard let body = try? Crypto.seal(key: sendKey, counter: counter, plain: Crypto.utf8(Json.write(message))) else { lock.unlock(); close(); return }
        var frame = Bytes()
        frame.reserveCapacity(8 + body.count)
        for i in 0..<8 { frame.append(UInt8((counter >> UInt64(56 - 8 * i)) & 0xff)) }
        frame.append(contentsOf: body)
        sendCounter += 1
        tunnel.sendBinary(frame) // under the lock: frames leave in counter order
        lock.unlock()
    }

    public func close() {
        tunnel.close()
        closed()
    }

    // MARK: PipeListener

    public func message(_ data: Bytes, text: Bool) {
        lock.lock()
        let isReady = ready
        lock.unlock()
        if !isReady {
            if !text || data.count > 4096 { tunnel.close(); return }
            handshake.offer(.text(Crypto.string(data)))
            return
        }
        if text || data.count < 24 || data.count > PeerChannel.maxFrame { close(); return }
        var counter: UInt64 = 0
        for i in 0..<8 { counter = (counter << 8) | UInt64(data[i]) }
        lock.lock()
        let last = receiveCounter
        let key = receiveKey
        lock.unlock()
        if last >= 0 && counter <= UInt64(last) { close(); return }
        guard let plain = Crypto.open(key: key, counter: counter, sealed: data, offset: 8, length: data.count - 8) else { close(); return }
        lock.lock()
        receiveCounter = Int64(truncatingIfNeeded: counter)
        let target = listener
        lock.unlock()
        guard let message = try? Json.object(Crypto.string(plain)) else { return }
        target?.message(message)
    }

    public func closed() {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let target = listener
        listener = nil // breaks the reference cycle with whoever listens
        lock.unlock()
        handshake.offer(.closed)
        target?.closed()
    }
}

/// The handshake's math (devices/handshake.ts), apart from the channel so a test can run it with fixed keys.
enum PeerHandshake {
    struct Result {
        let auth: JSONObject
        let sendKey: Bytes
        let receiveKey: Bytes
        let hash: Bytes
    }

    static func hello(deviceId: String, pub: Bytes, eph: Bytes, nonce: Bytes) -> JSONObject {
        ["t": "hello", "v": 1, "id": deviceId, "pub": Crypto.b64url(pub), "eph": Crypto.b64url(eph), "n": Crypto.b64url(nonce)]
    }

    private static func key32(_ value: String?) -> Bytes? {
        guard let value = value, let raw = Crypto.fromB64url(value), raw.count == 32 else { return nil }
        return raw
    }

    /// Verifies the PC's welcome (its key must be `pcPublicKey`) and derives the keys and the auth message.
    static func finish(seed: Bytes, ephSecret: Bytes, ephPub: Bytes, nonce: Bytes, welcome: JSONObject, pcPublicKey: Bytes) throws -> Result {
        let pub = Crypto.ed25519Public(seed: seed)
        guard welcome["t"] as? String == "welcome", let pubS = key32(Json.str(welcome, "pub")), let ephS = key32(Json.str(welcome, "eph")),
              let sig = Json.str(welcome, "sig"), pubS == pcPublicKey else {
            throw AutarkError("This is not the paired PC.")
        }
        let hash = Crypto.sha256(Crypto.concat(Crypto.utf8("wf-peer-v1"), pub, ephPub, nonce, pubS, ephS))
        guard Crypto.verify(publicKey: pubS, message: Crypto.concat(Crypto.utf8("server"), hash), signature: Crypto.fromB64url(sig)) else {
            throw AutarkError("The PC's signature is not valid.")
        }
        let shared: Bytes
        do { shared = try Crypto.x25519(secret: ephSecret, peerPublic: ephS) } catch { throw AutarkError("The PC's key is not valid.") }
        let okm = Crypto.hkdf(ikm: shared, salt: hash, info: "wf-peer-v1 keys", length: 64)
        let auth: JSONObject = ["t": "auth", "sig": Crypto.b64url(Crypto.sign(seed: seed, message: Crypto.concat(Crypto.utf8("client"), hash)))]
        return Result(auth: auth, sendKey: Bytes(okm[0..<32]), receiveKey: Bytes(okm[32..<64]), hash: hash)
    }
}
