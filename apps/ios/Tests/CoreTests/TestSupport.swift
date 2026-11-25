// Test stand-ins for the other end: an in-memory pipe pair, the PC's side of the peer handshake and its stream server
// (devices/handshake.ts serverWelcome, rendezvous/phone.ts serveStreams), the PC's side of the connect request
// (remote/sas.ts, target A) and a meeting server (services/remote-relay protocol v1) running in this process. They are
// written from the desktop sources, not from the Swift code under test.
import Foundation
import XCTest
@testable import AutarkCore
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

func hexBytes(_ text: String) -> Bytes { Crypto.fromHex(text) }

func vectors() -> JSONObject { (try? Json.object(DesktopVectors.json)) ?? [:] }

func section(_ name: String) -> JSONObject { (vectors()[name] as? JSONObject) ?? [:] }

/// Waits until `condition` holds (polling), failing the test after `seconds`.
@discardableResult
func eventually(_ seconds: Double = 5, _ message: String = "condition", file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.01)
    }
    XCTFail("timed out waiting for \(message)", file: file, line: line)
    return false
}

// MARK: in-memory pipe

final class MemoryPipe: LinkPipe {
    private let queue = DispatchQueue(label: "memory-pipe")
    private let lock = NSLock()
    fileprivate weak var peer: MemoryPipe?
    private var listener: PipeListener?
    private var closedFlag = false
    var received = [(Bytes, Bool)]()

    static func pair() -> (MemoryPipe, MemoryPipe) {
        let a = MemoryPipe(), b = MemoryPipe()
        a.peer = b
        b.peer = a
        return (a, b)
    }

    func listen(_ listener: PipeListener) { lock.lock(); self.listener = listener; lock.unlock() }
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var direct: Bool { false }
    func sendText(_ text: String) { deliver(Crypto.utf8(text), text: true) }
    func sendBinary(_ data: Bytes) { deliver(data, text: false) }

    private func deliver(_ data: Bytes, text: Bool) {
        if isClosed { return }
        guard let target = peer else { return }
        target.queue.async { [weak target] in
            guard let target = target else { return }
            target.lock.lock(); let l = target.listener; let closed = target.closedFlag; target.lock.unlock()
            if !closed { l?.message(data, text: text) }
        }
    }

    func close() {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let l = listener
        lock.unlock()
        l?.closed()
        peer?.queue.async { [weak peer] in peer?.remoteClosed() }
    }

    fileprivate func remoteClosed() {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let l = listener
        lock.unlock()
        l?.closed()
    }
}

// MARK: the PC's side of the peer handshake and channel

final class FakePcPeer: PipeListener {
    let pipe: LinkPipe
    private let seed: Bytes
    let publicKey: Bytes
    private let trustedPhone: Bytes?
    private let lock = NSLock()
    private var hash = Bytes()
    private var phonePub = Bytes()
    private var sendKey = Bytes(), receiveKey = Bytes()
    private var sendCounter: UInt64 = 0
    private var receiveCounter: Int64 = -1
    private var ready = false
    private var welcomed = false
    let authenticated = Future<Bool>()
    var onMessage: ((JSONObject) -> Void)?
    private(set) var helloPhone: String?
    private var lastFrameStore = Bytes()
    /// The newest frame this PC sent (for replay tests).
    var lastFrame: Bytes { lock.lock(); defer { lock.unlock() }; return lastFrameStore }

    init(pipe: LinkPipe, seed: Bytes, trustedPhone: Bytes?) {
        self.pipe = pipe
        self.seed = seed
        self.publicKey = Crypto.ed25519Public(seed: seed)
        self.trustedPhone = trustedPhone
        pipe.listen(self)
    }

    func message(_ data: Bytes, text: Bool) {
        lock.lock(); let isReady = ready; let isWelcomed = welcomed; lock.unlock()
        if !isReady && text {
            guard let object = try? Json.object(Crypto.string(data)) else { pipe.close(); return }
            if object["t"] as? String == "hello", !isWelcomed { hello(object) }
            else if object["t"] as? String == "auth" { auth(object) }
            return
        }
        if !isReady || text { pipe.close(); return }
        // a frame: counter, ciphertext, tag
        var counter: UInt64 = 0
        for i in 0..<8 { counter = (counter << 8) | UInt64(data[i]) }
        lock.lock(); let last = receiveCounter; let key = receiveKey; lock.unlock()
        if last >= 0 && counter <= UInt64(last) { pipe.close(); return }
        guard let plain = Crypto.open(key: key, counter: counter, sealed: data, offset: 8, length: data.count - 8) else { pipe.close(); return }
        lock.lock(); receiveCounter = Int64(counter); lock.unlock()
        if let object = try? Json.object(Crypto.string(plain)) { onMessage?(object) }
    }

    private func hello(_ hello: JSONObject) {
        guard let pubC = Crypto.fromB64url(Json.str(hello, "pub") ?? ""), let ephC = Crypto.fromB64url(Json.str(hello, "eph") ?? ""),
              let nonce = Crypto.fromB64url(Json.str(hello, "n") ?? ""), pubC.count == 32, ephC.count == 32, nonce.count == 16 else { pipe.close(); return }
        if let trusted = trustedPhone, trusted != pubC { pipe.close(); return }
        let eph = Crypto.x25519Pair()
        let h = Crypto.sha256(Crypto.concat(Crypto.utf8("wf-peer-v1"), pubC, ephC, nonce, publicKey, eph.pub))
        let sig = Crypto.sign(seed: seed, message: Crypto.concat(Crypto.utf8("server"), h))
        guard let shared = try? Crypto.x25519(secret: eph.secret, peerPublic: ephC) else { pipe.close(); return }
        let okm = Crypto.hkdf(ikm: shared, salt: h, info: "wf-peer-v1 keys", length: 64)
        lock.lock()
        hash = h; phonePub = pubC; welcomed = true
        receiveKey = Bytes(okm[0..<32]); sendKey = Bytes(okm[32..<64])
        helloPhone = Json.str(hello, "id")
        lock.unlock()
        pipe.sendText(Json.write(["t": "welcome", "id": "dev_fakepc0000000001", "pub": Crypto.b64url(publicKey), "eph": Crypto.b64url(eph.pub), "sig": Crypto.b64url(sig)] as JSONObject))
    }

    private func auth(_ auth: JSONObject) {
        lock.lock(); let h = hash; let pub = phonePub; lock.unlock()
        let ok = Crypto.verify(publicKey: pub, message: Crypto.concat(Crypto.utf8("client"), h), signature: Crypto.fromB64url(Json.str(auth, "sig") ?? ""))
        if !ok { pipe.close(); authenticated.complete(false); return }
        lock.lock(); ready = true; lock.unlock()
        authenticated.complete(true)
    }

    func send(_ message: JSONObject) {
        lock.lock()
        let counter = sendCounter
        guard let body = try? Crypto.seal(key: sendKey, counter: counter, plain: Crypto.utf8(Json.write(message))) else { lock.unlock(); return }
        sendCounter += 1
        var frame = Bytes()
        for i in 0..<8 { frame.append(UInt8((counter >> UInt64(56 - 8 * i)) & 0xff)) }
        frame.append(contentsOf: body)
        lastFrameStore = frame
        pipe.sendBinary(frame)
        lock.unlock()
    }

    func close() { pipe.close() }

    func closed() {}
}

// MARK: the PC's stream server (phone.ts serveStreams) answering a few canned requests

final class FakePcStreams {
    let peer: FakePcPeer
    var version = "0.9.9"
    private let lock = NSLock()
    private var requests = [Int: Bytes]()
    private var answered = Set<Int>()
    private(set) var bytesUploaded = 0
    private(set) var requestHeads = [String]()
    private(set) var requestTimes = [Date]()
    /// Streams the PC left unanswered on purpose (a hanging request).
    var holdPaths = Set<String>()
    /// What GET / answers (the PC's phone UI in the tests).
    var pageHTML = "<html><body>Autark phone UI</body></html>"
    /// What phone.pcs answers (rows as the PC's myPcs lists them); nil: this PC has no phone.pcs (an older one answers an error).
    var phonePcs: [JSONObject]?
    private(set) var phonePcsAsked = 0

    init(peer: FakePcPeer) {
        self.peer = peer
        peer.onMessage = { [weak self] message in self?.handle(message) }
    }

    private func handle(_ message: JSONObject) {
        let s = Json.num(message, "s", -1)
        guard s >= 0 else { return }
        switch Json.str(message, "t") {
        case "o":
            lock.lock(); requests[s] = Bytes(); lock.unlock()
        case "d":
            guard let b = Json.str(message, "b"), let data = Crypto.fromB64Std(b) else { return }
            lock.lock(); requests[s, default: Bytes()].append(contentsOf: data); bytesUploaded += data.count; let whole = requests[s]!; lock.unlock()
            peer.send(["t": "a", "s": s, "n": data.count] as JSONObject)
            respondIfComplete(s, whole)
        case "e":
            lock.lock(); requests[s] = nil; lock.unlock()
        default: break
        }
    }

    private func respondIfComplete(_ s: Int, _ whole: Bytes) {
        let text = String(decoding: whole, as: UTF8.self)
        guard let split = text.range(of: "\r\n\r\n") else { return }
        let head = String(text[..<split.lowerBound])
        var length = 0
        for line in head.components(separatedBy: "\r\n") where line.lowercased().hasPrefix("content-length:") {
            length = Int(line.dropFirst(15).trimmingCharacters(in: .whitespaces)) ?? 0
        }
        let bodyBytes = whole.count - head.utf8.count - 4
        if bodyBytes < length { return }
        lock.lock()
        if answered.contains(s) { lock.unlock(); return }
        answered.insert(s)
        requestHeads.append(head)
        requestTimes.append(Date())
        lock.unlock()
        let line = head.components(separatedBy: "\r\n")[0]
        let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        if holdPaths.contains(path) { return }
        var status = "200 OK"
        var contentType = "text/plain; charset=utf-8"
        var body = Bytes()
        if line.hasPrefix("POST /rpc"), head.contains("X-Workforce-Protocol"), text.contains("phone.pcs") {
            contentType = "application/json"
            lock.lock(); phonePcsAsked += 1; lock.unlock()
            if let rows = phonePcs { body = Crypto.utf8(Json.write(["id": 1, "result": ["pcs": rows as [Any]] as JSONObject] as JSONObject)) }
            else { status = "400 Bad Request"; body = Crypto.utf8("{\"id\":1,\"error\":{\"code\":\"bad_request\",\"message\":\"Unknown method.\"}}") }
        }
        else if line.hasPrefix("POST /rpc") { contentType = "application/json"; body = Crypto.utf8("{\"id\":1,\"result\":{\"version\":\"\(version)\"}}") }
        else if path == "/big" { body = Bytes((0..<600_000).map { UInt8(truncatingIfNeeded: $0 % 251) }) }
        else if line.hasPrefix("POST ") { body = Crypto.utf8("got \(bodyBytes) bytes") }
        else if path == "/" || path.hasPrefix("/#") { contentType = "text/html; charset=utf-8"; body = Crypto.utf8(pageHTML) }
        else { status = "404 Not Found"; body = Crypto.utf8("no") }
        let reply = Crypto.utf8("HTTP/1.1 \(status)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n") + body
        var offset = 0
        while offset < reply.count {
            let end = min(reply.count, offset + 32 * 1024)
            peer.send(["t": "d", "s": s, "b": Crypto.b64Std(Bytes(reply[offset..<end]))] as JSONObject)
            offset = end
        }
        peer.send(["t": "e", "s": s] as JSONObject)
    }
}

// MARK: the PC's side of the connect request (remote/sas.ts, requests.ts: target A, role phone)

final class FakePcRemote {
    let seed: Bytes
    let publicKey: Bytes
    let deviceId = "dev_fakepc0000000001"
    let name = "Studio PC"
    var decision = Future<Bool>()
    let token = "tok_" + Crypto.b64url(Crypto.random(12))
    let phoneDeviceIdSeen = Locked<String?>(nil)
    private var session = ""
    private var ephA = Crypto.x25519Pair()
    private var na = Bytes()
    private var commit = ""
    private var transcript = Bytes()
    private var key = Bytes()
    private var phoneInfo = JSONObject()
    private(set) var code = ""
    private var cancelled = false
    /// Called once with the phone's key when the person accepted (the PC pins the phone at the meeting server then).
    var onAccepted: ((Bytes) -> Void)?
    private var acceptedTold = false

    init(seed: Bytes) {
        self.seed = seed
        self.publicKey = Crypto.ed25519Public(seed: seed)
    }

    var info: JSONObject {
        ["id": deviceId, "name": name, "role": "home", "pub": Crypto.b64url(publicKey), "addresses": [Any]()]
    }

    func fail(_ message: String) -> JSONObject { ["ok": false, "error": ["code": "bad_request", "message": message] as JSONObject] }

    func handle(_ body: JSONObject) -> JSONObject {
        switch Json.str(body, "kind") {
        case "remote1":
            guard body["role"] as? String == "phone", let device = body["device"] as? JSONObject, let ephB = Crypto.fromB64url(Json.str(body, "eph") ?? "") else { return fail("bad remote1") }
            phoneInfo = device
            phoneDeviceIdSeen.value = Json.str(device, "id")
            session = Crypto.b64url(Crypto.random(12))
            na = Crypto.random(16)
            commit = RemotePair.commitment(ephA: ephA.pub, ephB: ephB, na: na)
            transcript = RemotePair.transcript(a: info, b: device, ephA: ephA.pub, ephB: ephB, commit: commit, role: "phone")
            guard let shared = try? Crypto.x25519(secret: ephA.secret, peerPublic: ephB) else { return fail("weak") }
            key = Crypto.hkdf(ikm: shared, salt: transcript, info: "wf-remote-v1 key", length: 32)
            phoneEph = ephB
            return ["ok": true, "session": session, "commit": commit, "eph": Crypto.b64url(ephA.pub), "device": info]
        case "remote2":
            guard Json.str(body, "session") == session, let nb = Crypto.fromB64url(Json.str(body, "nb") ?? ""),
                  let pubB = Crypto.fromB64url(Json.str(phoneInfo, "pub") ?? ""),
                  Crypto.verify(publicKey: pubB, message: RemotePair.signed("B", transcript), signature: Crypto.fromB64url(Json.str(body, "sig") ?? "")) else { return fail("bad remote2") }
            code = RemotePair.code(t: transcript, na: na, nb: nb)
            return ["ok": true, "na": Crypto.b64url(na), "sig": Crypto.b64url(Crypto.sign(seed: seed, message: RemotePair.signed("A", transcript)))]
        case "remote3":
            guard Json.str(body, "session") == session, Json.str(body, "mac") == RemotePair.mac(key: key, label: "remote-wait", parts: [session]) else { return fail("bad mac") }
            guard let accepted = try? decision.get(timeout: 0.4) else { return ["ok": true, "status": "pending"] }
            if !accepted { return ["ok": true, "status": "declined", "reason": "The person declined on the PC."] }
            let device: JSONObject = ["id": deviceId, "name": name]
            if !acceptedTold, let pub = Crypto.fromB64url(Json.str(phoneInfo, "pub") ?? "") { acceptedTold = true; onAccepted?(pub) }
            return ["ok": true, "status": "accepted", "token": token, "deviceId": "dev_phoneaccepted0001", "device": device,
                    "mac": RemotePair.mac(key: key, label: "remote-accept", parts: [device, Crypto.b64url(transcript)])]
        case "remoteCancel":
            cancelled = true
            return ["ok": true]
        default:
            return fail("unknown step")
        }
    }
    private var phoneEph = Bytes()
    var wasCancelled: Bool { cancelled }
}

// MARK: a meeting server in this process (services/remote-relay protocol v1)

final class FakeRelay: WebSocketConnector {
    final class Device {
        let fp: String
        let pub: Bytes
        let box: String
        let boxSig: String
        var peers: Set<String>
        var findable: Bool
        weak var socket: FakeSocket?
        init(fp: String, pub: Bytes, box: String, boxSig: String, peers: Set<String>, findable: Bool) {
            self.fp = fp; self.pub = pub; self.box = box; self.boxSig = boxSig; self.peers = peers; self.findable = findable
        }
    }

    /// What a PC registers: its key, a box key, and what it does with pair requests and tunnels.
    final class Pc {
        let seed: Bytes
        let publicKey: Bytes
        let fingerprint: String
        let box = Crypto.x25519Pair()
        var peers = Set<String>()
        var remote: FakePcRemote
        var phoneKey: Bytes?
        var peerSeed: Bytes { seed }
        var onPeer: ((FakePcPeer) -> Void)?
        /// The wake helper's side (sleeper.ts): the sealed wake request and the key of the phone that sent it; its answer.
        var wakeHandler: ((JSONObject, Bytes) -> JSONObject)?
        init(seed: Bytes) {
            self.seed = seed
            self.publicKey = Crypto.ed25519Public(seed: seed)
            self.fingerprint = Crypto.fingerprint(publicKey)
            self.remote = FakePcRemote(seed: seed)
        }
        var remoteId: String { Crypto.remoteId(fingerprint) }
        var boxPub: String { Crypto.b64url(box.pub) }
        var boxSig: String { Crypto.b64url(Crypto.sign(seed: seed, message: Crypto.utf8("wf-relay-v1|box|" + boxPub))) }
    }

    private let lock = NSRecursiveLock()
    private var devices = [String: Device]()
    private var sockets = [FakeSocket]()
    var pcs = [String: Pc]()
    private var tunnels = [Int: (phone: FakeSocket, pcEnd: Tunnel, tid: Int)]()
    private var nextTunnel = 1
    private(set) var connects = 0
    private(set) var lastSocket: FakeSocket?
    private(set) var helloCount = 0
    /// While true, `connect` fails (the meeting server is down).
    var down = false
    private(set) var peers = [FakePcPeer]()
    var streams = [FakePcStreams]()
    var streamVersion = "0.9.9"
    /// What every new tunnel's PC answers to phone.pcs (nil: no such method).
    var phonePcs: [JSONObject]?

    func addPc(_ pc: Pc, findable: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        pc.remote.onAccepted = { [weak pc] phonePub in pc?.peers.insert(Crypto.fingerprint(phonePub)) }
        pcs[pc.fingerprint] = pc
        devices[pc.fingerprint] = Device(fp: pc.fingerprint, pub: pc.publicKey, box: pc.boxPub, boxSig: pc.boxSig, peers: pc.peers, findable: findable)
    }

    func removePcOnline(_ pc: Pc) {
        lock.lock()
        devices[pc.fingerprint] = nil
        let phones = devices.values.filter { $0.peers.contains(pc.fingerprint) }
        lock.unlock()
        for phone in phones { phone.socket?.deliver(["t": "presence", "fp": pc.fingerprint, "online": false] as JSONObject) }
    }

    func pcCameOnline(_ pc: Pc) {
        addPc(pc)
        lock.lock(); let phones = devices.values.filter { $0.peers.contains(pc.fingerprint) && pc.peers.contains($0.fp) }; lock.unlock()
        for phone in phones { phone.socket?.deliver(["t": "presence", "fp": pc.fingerprint, "box": pc.boxPub, "boxSig": pc.boxSig, "online": true] as JSONObject) }
    }

    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink {
        lock.lock(); connects += 1; let isDown = down; lock.unlock()
        if isDown { throw AutarkError("refused") }
        let socket = FakeSocket(relay: self, listener: listener)
        lock.lock(); sockets.append(socket); lastSocket = socket; lock.unlock()
        return socket
    }

    func killAllSockets() {
        lock.lock(); let all = sockets; lock.unlock()
        for socket in all { socket.kill() }
    }

    // frames from a phone
    fileprivate func control(_ socket: FakeSocket, _ frame: JSONObject) {
        let type = Json.str(frame, "t") ?? ""
        if socket.device == nil {
            guard type == "hello", let pub = Crypto.fromB64url(Json.str(frame, "pub") ?? ""), pub.count == 32,
                  Crypto.verify(publicKey: pub, message: Crypto.utf8("wf-relay-v1|hello|" + socket.challenge), signature: Crypto.fromB64url(Json.str(frame, "sig") ?? "")),
                  let box = Json.str(frame, "box"), let boxSig = Json.str(frame, "boxSig"),
                  Crypto.verify(publicKey: pub, message: Crypto.utf8("wf-relay-v1|box|" + box), signature: Crypto.fromB64url(boxSig)) else {
                socket.kill(); return
            }
            let peers = Set((frame["peers"] as? [Any] ?? []).compactMap { $0 as? String })
            let device = Device(fp: Crypto.fingerprint(pub), pub: pub, box: box, boxSig: boxSig, peers: peers, findable: frame["findable"] as? Bool == true)
            device.socket = socket
            lock.lock(); helloCount += 1; devices[device.fp] = device; socket.device = device
            let online: [Any] = peers.compactMap { fp -> Any? in
                guard let pc = pcs[fp], let d = devices[fp], d.pub == pc.publicKey, pc.peers.contains(device.fp) else { return nil }
                return ["fp": fp, "box": pc.boxPub, "boxSig": pc.boxSig] as JSONObject
            }
            lock.unlock()
            socket.deliver(["t": "ready", "fp": device.fp, "online": online] as JSONObject)
            return
        }
        let ref = frame["ref"]
        func error(_ code: String) { var f: JSONObject = ["t": "error", "code": code]; if let r = ref { f["ref"] = r }; socket.deliver(f) }
        switch type {
        case "find":
            guard let id = Json.str(frame, "id") else { return error("bad_request") }
            lock.lock(); let found = pcs.values.filter { $0.remoteId == id && devices[$0.fingerprint]?.findable == true }; lock.unlock()
            socket.deliver(["t": "found", "ref": ref ?? NSNull(), "entries": found.map { ["pub": Crypto.b64url($0.publicKey), "box": $0.boxPub, "boxSig": $0.boxSig] as JSONObject } as [Any]] as JSONObject)
        case "pair":
            guard let to = Json.str(frame, "to"), let pc = pcs[to], let e = Json.str(frame, "e"), let c = Json.str(frame, "c"),
                  let eRaw = Crypto.fromB64url(e), let sealed = Crypto.fromB64url(c) else { return error("unavailable") }
            // the PC opens the request with its box key: HKDF(X25519(box, e), salt e‖box, info) – toOwner is the first half
            guard let shared = try? Crypto.x25519(secret: pc.box.secret, peerPublic: eRaw) else { return error("bad_request") }
            let okm = Crypto.hkdf(ikm: shared, salt: Crypto.concat(eRaw, pc.box.pub), info: RelayLink.pairInfo, length: 64)
            guard let plain = Crypto.open(key: Bytes(okm[0..<32]), counter: 0, sealed: sealed), let request = try? Json.object(Crypto.string(plain)) else { return error("failed") }
            let key = Bytes(okm[32..<64])
            if request["op"] as? String == "wake" { // the wake helper's request: the body itself, signed by the phone's device key
                let phonePub = socket.device?.pub ?? Bytes()
                spawn("fake-relay-wake") {
                    let reply = pc.wakeHandler?(request, phonePub) ?? ["ok": false, "error": ["code": "forbidden"] as JSONObject] as JSONObject
                    guard let out = try? Crypto.seal(key: key, counter: 0, plain: Crypto.utf8(Json.write(reply))) else { return }
                    socket.deliver(["t": "pairReply", "ref": ref ?? NSNull(), "c": Crypto.b64url(out)] as JSONObject)
                }
                return
            }
            guard request["op"] as? String == "pair", let body = request["body"] as? JSONObject else { return error("failed") }
            // the real server holds the request open until the PC answers: do the same, off this thread
            spawn("fake-relay-pair") {
                let reply = pc.remote.handle(body)
                guard let out = try? Crypto.seal(key: key, counter: 0, plain: Crypto.utf8(Json.write(reply))) else { return }
                socket.deliver(["t": "pairReply", "ref": ref ?? NSNull(), "c": Crypto.b64url(out)] as JSONObject)
            }
        case "open":
            guard let to = Json.str(frame, "to"), let pc = pcs[to], let device = socket.device, pc.peers.contains(device.fp), device.peers.contains(to), devices[to] != nil,
                  let e = Json.str(frame, "e"), let es = Json.str(frame, "es"), let eRaw = Crypto.fromB64url(e),
                  Crypto.verify(publicKey: device.pub, message: Crypto.utf8("wf-relay-v1|tunnel|\(e)|\(pc.boxPub)"), signature: Crypto.fromB64url(es)) else { return error("unavailable") }
            guard let shared = try? Crypto.x25519(secret: pc.box.secret, peerPublic: eRaw) else { return error("bad_request") }
            let okm = Crypto.hkdf(ikm: shared, salt: Crypto.concat(eRaw, pc.box.pub), info: RelayLink.tunnelInfo, length: 64)
            lock.lock(); let tid = nextTunnel; nextTunnel += 1; lock.unlock()
            let end = Tunnel(tid: tid, peer: device.fp, link: PcEndLink(relay: self, phone: socket, tid: tid), sendKey: Bytes(okm[32..<64]), receiveKey: Bytes(okm[0..<32]))
            let peer = FakePcPeer(pipe: end, seed: pc.peerSeed, trustedPhone: device.pub)
            let streams = FakePcStreams(peer: peer)
            streams.version = streamVersion
            streams.phonePcs = phonePcs
            lock.lock(); tunnels[tid] = (socket, end, tid); self.peers.append(peer); self.streams.append(streams); lock.unlock()
            pc.onPeer?(peer)
            socket.deliver(["t": "opened", "ref": ref ?? NSNull(), "tid": tid] as JSONObject)
        case "close":
            let tid = Json.num(frame, "tid", -1)
            lock.lock(); let t = tunnels.removeValue(forKey: tid); lock.unlock()
            t?.pcEnd.ended()
        default:
            error("bad_request")
        }
    }

    fileprivate func binary(_ socket: FakeSocket, _ data: Bytes) {
        guard data.count >= 5 else { return }
        let tid = (Int(data[0]) << 24) | (Int(data[1]) << 16) | (Int(data[2]) << 8) | Int(data[3])
        lock.lock(); let t = tunnels[tid]; lock.unlock()
        t?.pcEnd.receive(data)
    }

    fileprivate func socketClosed(_ socket: FakeSocket) {
        lock.lock()
        let mine = tunnels.filter { $0.value.phone === socket }
        for key in mine.keys { tunnels[key] = nil }
        if let device = socket.device, devices[device.fp]?.socket === socket { devices[device.fp] = nil }
        lock.unlock()
        for t in mine.values { t.pcEnd.ended() }
    }

    /// The PC's end of a tunnel sends its frames to the phone's socket.
    private final class PcEndLink: TunnelLink {
        weak var relay: FakeRelay?
        let phone: FakeSocket
        let tid: Int
        init(relay: FakeRelay, phone: FakeSocket, tid: Int) { self.relay = relay; self.phone = phone; self.tid = tid }
        func send(_ frame: Bytes) { phone.deliverBinary(frame) }
        func close(_ tid: Int) {
            relay?.lock.lock(); relay?.tunnels[tid] = nil; relay?.lock.unlock()
            phone.deliver(["t": "closed", "tid": tid, "code": "closed"] as JSONObject)
        }
    }

    /// The relay ends one tunnel towards the phone (the PC went away).
    func closeTunnels() {
        lock.lock(); let all = tunnels; tunnels.removeAll(); lock.unlock()
        for (tid, t) in all {
            t.phone.deliver(["t": "closed", "tid": tid, "code": "closed"] as JSONObject)
            t.pcEnd.ended()
        }
    }
}

final class FakeSocket: WebSocketLink {
    private let relay: FakeRelay
    private weak var listener: WebSocketListener?
    private let queue = DispatchQueue(label: "fake-socket")
    private let lock = NSLock()
    private var started = false
    private var closedFlag = false
    private var last = Date().timeIntervalSince1970
    private var count = 0
    let challenge = Crypto.b64url(Crypto.random(32))
    var device: FakeRelay.Device?
    var pingsSeen = 0
    var answerPings = true

    init(relay: FakeRelay, listener: WebSocketListener) { self.relay = relay; self.listener = listener }

    func start() {
        lock.lock(); started = true; lock.unlock()
        deliver(["t": "challenge", "v": 1, "n": challenge] as JSONObject)
    }

    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var lastFrameAt: TimeInterval { lock.lock(); defer { lock.unlock() }; return last }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return count }

    private func touch() { lock.lock(); last = Date().timeIntervalSince1970; count += 1; lock.unlock() }

    func sendText(_ text: String) throws {
        if isClosed { throw AutarkError("closed") }
        queue.async { [self] in
            guard let frame = try? Json.object(text) else { return }
            relay.control(self, frame)
        }
    }

    func sendBinary(_ data: Bytes) throws {
        if isClosed { throw AutarkError("closed") }
        queue.async { [self] in relay.binary(self, data) }
    }

    func ping() throws {
        if isClosed { throw AutarkError("closed") }
        lock.lock(); pingsSeen += 1; let answer = answerPings; lock.unlock()
        if answer { queue.async { [self] in touch() } }
    }

    func deliver(_ frame: JSONObject) {
        queue.async { [self] in
            if isClosed { return }
            touch()
            listener?.text(Json.write(frame))
        }
    }

    func deliverBinary(_ data: Bytes) {
        queue.async { [self] in
            if isClosed { return }
            touch()
            listener?.binary(data)
        }
    }

    func close() { kill() }

    func kill() {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let l = listener
        lock.unlock()
        relay.socketClosed(self)
        queue.async { l?.closed("closed") }
    }
}


// MARK: the local entrance wired to one fake PC (shared by the proxy tests and the web view tests)

final class FixedChannels: Channels {
    var channel: PeerChannel?
    var probes = 0
    func waitChannel(timeoutMs: Int) -> PeerChannel? { channel }
    func usedChannel() -> PeerChannel? { channel }
    func probe() { probes += 1 }
}

/// Hands the PC's messages to the proxy, like PhoneConnection's channel listener.
final class ProxyListener: PeerListener {
    var proxy: StreamProxy?
    var channel: PeerChannel?
    func message(_ message: JSONObject) { if let c = channel { proxy?.deliver(c, message) } }
    func closed() { if let c = channel { proxy?.channelClosed(c) } }
}

struct ProxyRig {
    let proxy: StreamProxy
    let channels: FixedChannels
    let pc: FakePcPeer
    let streams: FakePcStreams
    let channel: PeerChannel
}

func makeProxyRig(gate: String = "gate-secret") throws -> ProxyRig {
    let (phonePipe, pcPipe) = MemoryPipe.pair()
    let pcSeed = Bytes(repeating: 0x22, count: 32)
    let phoneSeed = Bytes(repeating: 0x11, count: 32)
    let pc = FakePcPeer(pipe: pcPipe, seed: pcSeed, trustedPhone: nil)
    let streams = FakePcStreams(peer: pc)
    let listener = ProxyListener()
    let channel = try PeerChannel.connect(tunnel: phonePipe, seed: phoneSeed, deviceId: "dev_x", pcPublicKey: pc.publicKey, listener: listener)
    XCTAssertEqual(try pc.authenticated.get(timeout: 5), true)
    let channels = FixedChannels()
    channels.channel = channel
    let proxy = try StreamProxy(port: 0, gate: gate, channels: channels)
    listener.proxy = proxy
    listener.channel = channel
    return ProxyRig(proxy: proxy, channels: channels, pc: pc, streams: streams, channel: channel)
}
