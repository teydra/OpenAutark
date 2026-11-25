// The runner's listener: a TCP socket bound to the iPhone's loopback address only (127.0.0.1, and ::1 when it can), only on the
// port the PC chose, never another. BSD sockets with dispatch sources: the first CI run (44950636780) showed an NWListener with
// requiredInterfaceType .loopback and acceptLocalOnly resetting every connection in the Simulator; a socket bound to 127.0.0.1 is
// unreachable from outside by construction and needs no network policy. Each connection is a RunnerSession (the protocol's state
// machine in AutarkCore); this file only moves bytes, keeps the clock, hands operations to the main thread with their time limit,
// and ends the runner (end, idle, five wrong proofs, a main thread stuck for 60 s). Logs carry operation names, durations and error
// codes – never text, trees or pictures.
import Darwin
import Foundation

/// What the server and the main thread share, under a lock.
final class RunnerShared {
    private let lock = NSLock()
    private var _welcome: JSONObject
    private var _caps: Set<String>
    private var _apps = [String]()

    init(welcome: JSONObject, caps: Set<String>) {
        _welcome = welcome
        _caps = caps
    }

    var caps: Set<String> { lock.lock(); defer { lock.unlock() }; return _caps }
    var apps: [String] { lock.lock(); defer { lock.unlock() }; return _apps }

    func welcome() -> JSONObject { lock.lock(); defer { lock.unlock() }; return _welcome }

    func setScreen(_ screen: RunnerScreen) { lock.lock(); _welcome["screen"] = screen.json; lock.unlock() }

    func setApps(_ apps: [String]) { lock.lock(); _apps = apps; lock.unlock() }
}

final class RunnerServer {
    private final class Link {
        let id: Int
        let fd: Int32
        let session: RunnerSession
        var source: DispatchSourceRead?
        var closing = false
        var closed = false

        init(id: Int, fd: Int32, session: RunnerSession) {
            self.id = id
            self.fd = fd
            self.session = session
        }
    }

    private final class Once { var done = false }

    private let queue = DispatchQueue(label: "com.teydralab.autark.runner.server")
    private let token: Bytes
    private let port: UInt16
    private let hub: RunnerHub
    private let ops: RunnerOps
    private let shared: RunnerShared
    private let diag: Bool
    private var acceptors = [DispatchSourceRead]()
    private var links = [Int: Link]()
    private var nextId = 1
    private var timer: DispatchSourceTimer?
    private let startedNs = DispatchTime.now().uptimeNanoseconds
    private var mainBusySince: UInt64?
    private var ending = false

    private let stateLock = NSLock()
    private var _finished = false
    private var _failure: String?
    private var _reason = ""

    var finished: Bool { stateLock.lock(); defer { stateLock.unlock() }; return _finished }
    var failure: String? { stateLock.lock(); defer { stateLock.unlock() }; return _failure }
    var reason: String { stateLock.lock(); defer { stateLock.unlock() }; return _reason }

    init(token: Bytes, port: UInt16, idleSeconds: Int, ops: RunnerOps, shared: RunnerShared, diag: Bool) {
        self.token = token
        self.port = port
        self.ops = ops
        self.shared = shared
        self.diag = diag
        self.hub = RunnerHub(idleSeconds: idleSeconds, now: Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000))
    }

    private func nowMs() -> Int64 { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }

    private func log(_ line: String) { print("AUTARK-RUNNER \(line)") }

    // MARK: start and end

    func start() {
        queue.async {
            switch Self.listenSocket(port: self.port, ipv6: false) {
            case .failure(let error):
                return self.finish(failure: "The runner could not listen on 127.0.0.1 at its port (errno \(error.code)); it never takes another one.")
            case .success(let fd):
                self.acceptOn(fd)
                self.log("listening on 127.0.0.1")
            }
            switch Self.listenSocket(port: self.port, ipv6: true) {
            case .failure(let error): self.log("no listener on ::1 (errno \(error.code))")
            case .success(let fd):
                self.acceptOn(fd)
                self.log("listening on ::1")
            }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 1, repeating: 1.0)
            timer.setEventHandler { [weak self] in self?.tick() }
            timer.resume()
            self.timer = timer
        }
    }

    private struct Errno: Error { let code: Int32 }

    /// A listening socket on the loopback address (IPv4 127.0.0.1 or IPv6 ::1) and `port`, non-blocking; the errno on failure.
    private static func listenSocket(port: UInt16, ipv6: Bool) -> Result<Int32, Errno> {
        let fd = socket(ipv6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return .failure(Errno(code: errno)) }
        var one: Int32 = 1
        let size = socklen_t(MemoryLayout<Int32>.size)
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, size) // a port in TIME_WAIT only; a second listener still fails
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, size)
        var result: Int32
        if ipv6 {
            setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &one, size)
            var address = sockaddr_in6()
            address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            address.sin6_family = sa_family_t(AF_INET6)
            address.sin6_port = port.bigEndian
            address.sin6_addr = in6addr_loopback
            result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
        } else {
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = port.bigEndian
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
            result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        }
        if result == 0 { result = listen(fd, 8) }
        if result == 0 { result = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == -1 ? -1 : 0 }
        guard result == 0 else {
            let code = errno
            Darwin.close(fd)
            return .failure(Errno(code: code))
        }
        return .success(fd)
    }

    private func acceptOn(_ fd: Int32) {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 { break }
                self?.accept(client)
            }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
        acceptors.append(source)
    }

    private func finish(reason: String = "", failure: String? = nil) {
        guard !ending || failure != nil else { return }
        ending = true
        timer?.cancel()
        timer = nil
        for source in acceptors { source.cancel() }
        acceptors = []
        for link in Array(links.values) { closeNow(link) }
        links = [:]
        stateLock.lock()
        _finished = true
        _failure = _failure ?? failure
        _reason = failure == nil ? reason : "failure"
        stateLock.unlock()
    }

    // MARK: connections

    private func accept(_ fd: Int32) {
        guard !ending else { Darwin.close(fd); return }
        let id = nextId
        nextId += 1
        guard hub.accept(id) else {
            log("connection refused: two others are still authenticating")
            Darwin.close(fd)
            return
        }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
        var sendLimit = timeval(tv_sec: 30, tv_usec: 0) // a PC that stops reading cannot hold the runner longer
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sendLimit, socklen_t(MemoryLayout<timeval>.size))
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK) // blocking: reads only when readable, writes complete or time out
        let started = startedNs
        let session = RunnerSession(token: token, caps: shared.caps, now: nowMs(), welcome: { [shared] in shared.welcome() },
                                    uptimeMs: { Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000) })
        let link = Link(id: id, fd: fd, session: session)
        links[id] = link
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.readable(link) }
        source.setCancelHandler { Darwin.close(fd) }
        link.source = source
        source.resume()
    }

    private func readable(_ link: Link) {
        guard !link.closed else { return }
        var buffer = [UInt8](repeating: 0, count: 65_536)
        let count = Darwin.read(link.fd, &buffer, buffer.count)
        if count > 0 {
            if link.closing { return } // draining after our FIN
            apply(link, link.session.receive(Array(buffer[0..<count]), now: nowMs()))
        } else if count == 0 || (errno != EINTR && errno != EAGAIN) {
            closeNow(link)
        }
    }

    private func write(_ link: Link, _ bytes: Bytes) {
        guard !link.closed, !link.closing else { return }
        var failed = false
        bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let sent = Darwin.write(link.fd, raw.baseAddress! + offset, raw.count - offset)
                if sent > 0 {
                    offset += sent
                } else if sent < 0 && errno == EINTR {
                    continue
                } else {
                    failed = true
                    break
                }
            }
        }
        if failed { closeNow(link) }
    }

    private func drop(_ id: Int) {
        guard links.removeValue(forKey: id) != nil else { return }
        hub.closed(id, now: nowMs())
    }

    /// Our FIN after everything written, then the socket closes a moment later (so the PC reads the last answer).
    private func close(_ link: Link) {
        guard !link.closing, !link.closed else { return }
        link.closing = true
        Darwin.shutdown(link.fd, SHUT_WR)
        drop(link.id)
        queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.closeNow(link) }
    }

    private func closeNow(_ link: Link) {
        guard !link.closed else { return }
        link.closed = true
        link.source?.cancel() // the cancel handler closes the descriptor
        link.source = nil
        drop(link.id)
    }

    private func apply(_ link: Link, _ actions: [RunnerSession.Action]) {
        for action in actions {
            switch action {
            case .send(let bytes):
                write(link, bytes)
            case .close:
                close(link)
            case .perform(let id, let op):
                perform(link, id: id, op: op)
            case .authed(let apps):
                if let older = hub.authenticated(link.id), let old = links[older] {
                    log("a newer connection authenticated: the older one is closed")
                    _ = old.session.close()
                    close(old)
                }
                shared.setApps(apps)
                log("authenticated")
            case .authFailed:
                log("auth_failed")
                if hub.failedProof() {
                    log("five wrong proofs: the runner ends")
                    queue.asyncAfter(deadline: .now() + 0.3) { self.finish(reason: "five wrong proofs") }
                }
            case .end:
                log("end")
                queue.asyncAfter(deadline: .now() + 0.6) { self.finish(reason: "end") }
            }
        }
    }

    // MARK: operations

    private func perform(_ link: Link, id: Int, op: RunnerOp) {
        if mainBusySince != nil {
            apply(link, link.session.complete(id: id, answer: .fail(.notReady, "The previous operation is still running on the iPhone.")))
            return
        }
        mainBusySince = DispatchTime.now().uptimeNanoseconds
        let once = Once()
        let limit = RunnerWire.limitMs(op)
        let apps = shared.apps
        let started = DispatchTime.now().uptimeNanoseconds
        let ops = self.ops
        DispatchQueue.main.async {
            var answer = RunnerAnswer.fail(.internal, "The operation did not run.")
            MainActor.assumeIsolated { answer = ops.run(op, apps: apps) }
            let result = answer
            self.queue.async {
                self.mainBusySince = nil
                let ms = (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
                self.log("op=\(op.name) ms=\(ms) \(result.ok ? "ok" : (result.code?.rawValue ?? "error"))\(once.done ? " (late, dropped)" : "")")
                if !once.done {
                    once.done = true
                    self.apply(link, link.session.complete(id: id, answer: result))
                }
            }
        }
        queue.asyncAfter(deadline: .now() + .milliseconds(limit)) {
            guard !once.done else { return }
            once.done = true
            self.log("op=\(op.name) timeout after \(limit) ms")
            self.apply(link, link.session.timedOut(id: id))
        }
    }

    private func tick() {
        let now = nowMs()
        for link in Array(links.values) { apply(link, link.session.tick(now: now)) }
        if hub.idleEnd(now: now) {
            log("no authenticated connection for \(hub.idleMs / 1000) s: the runner ends")
            finish(reason: "idle")
        }
        if let since = mainBusySince, DispatchTime.now().uptimeNanoseconds - since > 60_000_000_000 {
            log("the main thread is stuck for 60 s: exit")
            exit(1)
        }
    }
}
