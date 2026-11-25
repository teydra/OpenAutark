// Owns: this phone's one connection to Autark's meeting server (services/remote-relay, protocol v1) – registration with
// the phone's own device key, the PCs it pins (every PC of the company it belongs to, in the order the app keeps them),
// presence of those PCs, finding a PC by Remote ID, sealed pairing requests and tunnels it opens – mirroring the PC side
// (rendezvous/relay-client.ts). Ported from relay/RelayLink.java. Every frame counts as traffic; probe() ends a connection
// that does not answer a ping within 2 s, and checkAlive() probes one that was silent for a while (URLSession answers the
// server's pings itself, so the app never sees them).
// Never: trusts a box key its PC's device key did not sign, accepts tunnels, or makes this phone findable.
import Foundation

public protocol RelayEvents: AnyObject {
    /// A PC this phone pins came online at the server.
    func presence(online: Bool)
    /// The server connection ended.
    func down(reason: String)
}

public final class RelayLink: WebSocketListener {
    public static let pairInfo = "wf-relay-pair-v1"
    public static let tunnelInfo = "wf-relay-tunnel-v1"
    static let probeMs = 2_000
    /// Silence after which checkAlive() pings (the server pings every 30 s; URLSession hides those from us).
    static let quietSeconds: TimeInterval = 25

    public struct Found {
        public let fingerprint: String
        public let publicKey: Bytes
        public let box: String
    }

    private let seed: Bytes
    private let publicKey: Bytes
    /// fingerprint → raw Ed25519 key of each pinned PC, in the app's order.
    private let pins: [(String, Bytes)]
    private weak var events: RelayEvents?
    private let connector: WebSocketConnector
    private let box = Crypto.x25519Pair()
    private let boxPub: String
    private let lock = NSLock()
    private var pending = [Int: Future<JSONObject>]()
    private var tunnels = [Int: Tunnel]()
    private var nextRef = 1
    private let ready = Future<Bool>()
    private var socket: WebSocketLink?
    /// Box keys of the pinned PCs online now.
    private var boxes = [String: String]()
    private var downFlag = false

    /// `pins`: fingerprint → key of the PCs this phone belongs to (empty while pairing: nothing pinned).
    public init(seed: Bytes, pins: [(String, Bytes)], connector: WebSocketConnector, events: RelayEvents?) {
        self.seed = seed
        self.publicKey = Crypto.ed25519Public(seed: seed)
        self.pins = pins
        self.connector = connector
        self.events = events
        self.boxPub = Crypto.b64url(box.pub)
    }

    /// Connects and registers; returns once the server said ready.
    public func connect(url: String) throws {
        let link = try connector.connect(url: url, listener: self)
        lock.lock(); socket = link; lock.unlock()
        link.start()
        do { _ = try ready.get(timeout: 15) } catch {
            close()
            throw AutarkError("The meeting server did not register this phone.")
        }
    }

    public var isUp: Bool { lock.lock(); defer { lock.unlock() }; return !downFlag && ready.isDone }

    /// True when the server reported a pinned PC online (with a box key its device key signed).
    public var pcOnline: Bool { lock.lock(); defer { lock.unlock() }; return !boxes.isEmpty }

    /// True when the server reported the pinned PC `fp` online.
    public func online(_ fp: String?) -> Bool {
        guard let fp = fp else { return false }
        lock.lock(); defer { lock.unlock() }
        return boxes[fp] != nil
    }

    private func current() -> WebSocketLink? { lock.lock(); defer { lock.unlock() }; return socket }

    /// A connection silent for a while is checked at once (one ping, 2 s).
    public func checkAlive() {
        guard let ws = current(), !isDown else { return }
        if Date().timeIntervalSince1970 - ws.lastFrameAt > RelayLink.quietSeconds { probe() }
    }

    private var isDown: Bool { lock.lock(); defer { lock.unlock() }; return downFlag }

    /// Pings the server now and kills the connection when no frame at all arrives within 2 s – one check, armed here.
    public func probe() {
        guard let ws = current(), !isDown else { return }
        let before = ws.frames
        later(milliseconds: RelayLink.probeMs) { if ws.frames == before { ws.kill() } }
        do { try ws.ping() } catch { ws.kill() } // a send stuck here ends with the kill above
    }

    public func close() {
        if let ws = current() { ws.close() } else { closed("closed") }
    }

    // MARK: requests

    /// The PCs that accept requests under this Remote ID (key checked against the ID or its code chain, box signed by that key).
    public func find(remoteId: String) throws -> [Found] {
        let reply = try ask(["t": "find", "id": remoteId] as JSONObject, timeoutMs: 10_000)
        var out = [Found]()
        guard let entries = reply["entries"] as? [Any] else { return out }
        for item in entries {
            guard out.count < 4, let entry = item as? JSONObject, let pub = Json.str(entry, "pub"), let key = Crypto.fromB64url(pub), key.count == 32 else { continue }
            let box = Json.str(entry, "box")
            if !RelayLink.boxSigned(pub: key, box: box, boxSig: Json.str(entry, "boxSig")) { continue }
            let fp = Crypto.fingerprint(key)
            var belongs = Crypto.remoteId(fp) == remoteId
            if !belongs, let chain = entry["chain"] as? JSONObject { // a PC of the same person answers for the person code with its chain
                belongs = CodeChain.belongs(remoteId: remoteId, fingerprintHex: fp, chainJson: Json.write(chain))
            }
            if belongs, let box = box { out.append(Found(fingerprint: fp, publicKey: key, box: box)) }
        }
        return out
    }

    /// One sealed message to a PC found by Remote ID and its opened reply.
    public func request(_ pc: Found, body: JSONObject, timeoutMs: Int) throws -> JSONObject {
        let eph = Crypto.x25519Pair()
        guard let boxRaw = Crypto.fromB64url(pc.box) else { throw AutarkError("The PC's key is not valid.") }
        let okm = Crypto.hkdf(ikm: try Crypto.x25519(secret: eph.secret, peerPublic: boxRaw), salt: Crypto.concat(eph.pub, boxRaw), info: RelayLink.pairInfo, length: 64)
        let toOwner = Bytes(okm[0..<32])
        let toOpener = Bytes(okm[32..<64])
        let sealed = Crypto.b64url(try Crypto.seal(key: toOwner, counter: 0, plain: Crypto.utf8(Json.write(body))))
        let reply = try ask(["t": "pair", "to": pc.fingerprint, "e": Crypto.b64url(eph.pub), "c": sealed] as JSONObject, timeoutMs: timeoutMs)
        if let error = reply["error"] as? String { throw AutarkError("The meeting server could not deliver the request (\(error)).") }
        guard let c = Json.str(reply, "c"), let raw = Crypto.fromB64url(c), let plain = Crypto.open(key: toOpener, counter: 0, sealed: raw) else {
            throw AutarkError("The reply could not be opened.")
        }
        return try Json.object(Crypto.string(plain))
    }

    /// A tunnel to the pinned PC `fp`; the opener's ephemeral key is signed with this phone's device key.
    public func open(_ fp: String) throws -> Tunnel {
        lock.lock(); let boxText = boxes[fp]; lock.unlock()
        guard let box = boxText, let boxRaw = Crypto.fromB64url(box) else { throw AutarkError("Your PC is not online at the meeting server.") }
        let eph = Crypto.x25519Pair()
        let okm = Crypto.hkdf(ikm: try Crypto.x25519(secret: eph.secret, peerPublic: boxRaw), salt: Crypto.concat(eph.pub, boxRaw), info: RelayLink.tunnelInfo, length: 64)
        let e = Crypto.b64url(eph.pub)
        let es = Crypto.b64url(Crypto.sign(seed: seed, message: Crypto.utf8("wf-relay-v1|tunnel|\(e)|\(box)")))
        let reply = try ask(["t": "open", "to": fp, "e": e, "es": es] as JSONObject, timeoutMs: 10_000)
        let tid = Json.num(reply, "tid", -1)
        if tid < 0 || reply["t"] as? String != "opened" { throw AutarkError("The meeting server did not open a tunnel.") }
        let tunnel = Tunnel(tid: tid, peer: fp, link: LinkAdapter(owner: self), sendKey: Bytes(okm[0..<32]), receiveKey: Bytes(okm[32..<64]))
        lock.lock(); tunnels[tid] = tunnel; lock.unlock()
        return tunnel
    }

    private final class LinkAdapter: TunnelLink {
        weak var owner: RelayLink?
        init(owner: RelayLink) { self.owner = owner }
        func send(_ frame: Bytes) {
            guard let owner = owner, let ws = owner.current() else { return }
            do { try ws.sendBinary(frame) } catch { ws.kill() }
        }
        func close(_ tid: Int) {
            guard let owner = owner else { return }
            owner.lock.lock(); owner.tunnels[tid] = nil; owner.lock.unlock()
            owner.sendJson(["t": "close", "tid": tid] as JSONObject)
        }
    }

    private func ask(_ frameIn: JSONObject, timeoutMs: Int) throws -> JSONObject {
        if !isUp { throw AutarkError("The meeting server is not connected.") }
        let future = Future<JSONObject>()
        lock.lock()
        let ref = nextRef
        nextRef += 1
        pending[ref] = future
        lock.unlock()
        defer { lock.lock(); pending[ref] = nil; lock.unlock() }
        var frame = frameIn
        frame["ref"] = ref
        sendJson(frame)
        let reply: JSONObject
        do { reply = try future.get(timeout: Double(timeoutMs) / 1000) } catch let error as AutarkError where error.message == "timeout" {
            throw AutarkError("The meeting server did not answer in time.")
        } catch {
            throw AutarkError("The meeting server connection ended.")
        }
        if reply["t"] as? String == "error" { throw AutarkError("The meeting server refused this (\(reply["code"] ?? "error")).") }
        return reply
    }

    private func sendJson(_ frame: JSONObject) {
        guard let ws = current() else { return }
        do { try ws.sendText(Json.write(frame)) } catch { ws.kill() }
    }

    // MARK: frames from the server

    public func text(_ text: String) {
        guard let frame = try? Json.object(text), let type = Json.str(frame, "t") else { return }
        switch type {
        case "challenge":
            guard let n = Json.str(frame, "n"), n.count <= 64 else { close(); return }
            sendJson(["t": "hello", "v": 1, "pub": Crypto.b64url(publicKey),
                      "sig": Crypto.b64url(Crypto.sign(seed: seed, message: Crypto.utf8("wf-relay-v1|hello|" + n))),
                      "box": boxPub, "boxSig": Crypto.b64url(Crypto.sign(seed: seed, message: Crypto.utf8("wf-relay-v1|box|" + boxPub))),
                      "peers": pins.map { $0.0 } as [Any], "findable": false] as JSONObject)
        case "ready":
            if let online = frame["online"] as? [Any] { for entry in online { if let map = entry as? JSONObject { seen(map) } } }
            ready.complete(true)
        case "presence":
            if frame["online"] as? Bool == true { seen(frame) }
            else if let fp = frame["fp"] as? String {
                lock.lock(); let removed = boxes.removeValue(forKey: fp) != nil; lock.unlock()
                if removed { events?.presence(online: false) }
            }
        case "closed":
            lock.lock(); let tunnel = tunnels.removeValue(forKey: Json.num(frame, "tid", -1)); lock.unlock()
            tunnel?.ended()
        case "incoming": // this phone accepts no tunnels: only a pinned PC could open one, and it never does
            sendJson(["t": "close", "tid": Json.num(frame, "tid", -1)] as JSONObject)
        case "pair": // nobody pairs with a phone through the server
            sendJson(["t": "pairReply", "ref": frame["ref"] ?? NSNull(), "error": "failed"] as JSONObject)
        default:
            let ref = Json.num(frame, "ref", -1)
            if ref < 0 { return }
            lock.lock(); let future = pending[ref]; lock.unlock()
            future?.complete(frame)
        }
    }

    private func seen(_ entry: JSONObject) {
        guard let fp = Json.str(entry, "fp") else { return }
        guard let pub = pins.first(where: { $0.0 == fp })?.1 else { return }
        let box = Json.str(entry, "box")
        if !RelayLink.boxSigned(pub: pub, box: box, boxSig: Json.str(entry, "boxSig")) { return }
        lock.lock()
        let was = boxes.updateValue(box!, forKey: fp) != nil
        lock.unlock()
        if !was { events?.presence(online: true) }
    }

    static func boxSigned(pub: Bytes?, box: String?, boxSig: String?) -> Bool {
        guard let pub = pub, let box = box, let boxSig = boxSig, box.count <= 64, boxSig.count <= 128 else { return false }
        guard let raw = Crypto.fromB64url(box), raw.count == 32 else { return false }
        return Crypto.verify(publicKey: pub, message: Crypto.utf8("wf-relay-v1|box|" + box), signature: Crypto.fromB64url(boxSig))
    }

    public func binary(_ data: Bytes) {
        if data.count < Tunnel.header { return }
        let tid = (Int(data[0]) << 24) | (Int(data[1]) << 16) | (Int(data[2]) << 8) | Int(data[3])
        lock.lock(); let tunnel = tunnels[tid]; lock.unlock()
        tunnel?.receive(data)
    }

    public func closed(_ reason: String) {
        lock.lock()
        if downFlag { lock.unlock(); return }
        downFlag = true
        boxes.removeAll()
        let waiting = Array(pending.values)
        let open = Array(tunnels.values)
        tunnels.removeAll()
        lock.unlock()
        ready.fail(AutarkError(reason))
        for future in waiting { future.fail(AutarkError(reason)) }
        for tunnel in open { tunnel.ended() }
        events?.down(reason: reason)
    }

    /// For tests and the status line: this phone's fingerprint.
    public var fingerprint: String { Crypto.fingerprint(publicKey) }
}
