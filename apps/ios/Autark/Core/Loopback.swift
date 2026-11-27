// Owns: the few BSD-socket calls the local entrance needs – a TCP listener on 127.0.0.1 only, accept, timed and blocking
// reads, complete writes, shutdown. Blocking calls on threads of their own, exactly as the Java entrance's ServerSocket:
// the same code then runs on Apple platforms and on Linux, where the host tests exercise it. (Network.framework's
// NWListener would do the same job; plain sockets make the proxy testable without a Mac.)
// Never: listens beyond loopback, or keeps a socket after its owner is gone (the descriptor closes with its object).
import Foundation
#if canImport(Darwin)
import Darwin
private let sockStream = SOCK_STREAM
#else
import Glibc
private let sockStream = Int32(SOCK_STREAM.rawValue)
#endif

// The C functions under names no method of the classes below can shadow.
private func closeFd(_ fd: Int32) { _ = close(fd) }
private func readFd(_ fd: Int32, _ buffer: UnsafeMutableRawPointer?, _ count: Int) -> Int { read(fd, buffer, count) }
private func writeFd(_ fd: Int32, _ buffer: UnsafeRawPointer, _ count: Int) -> Int { write(fd, buffer, count) }
private func shutdownFd(_ fd: Int32, _ how: Int32) -> Int32 { shutdown(fd, how) }
private func connectFd(_ fd: Int32, _ address: UnsafePointer<sockaddr>, _ length: socklen_t) -> Int32 { connect(fd, address, length) }
private func acceptFd(_ fd: Int32) -> Int32 { accept(fd, nil, nil) }

/// One connected TCP socket. shutdown() wakes a thread blocked in read(); the descriptor closes when the object goes.
public final class TcpConnection {
    let fd: Int32
    private let lock = NSLock()
    private var down = false

    init(fd: Int32) {
        self.fd = fd
        var yes: Int32 = 1
        setsockopt(fd, Int32(IPPROTO_TCP), TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
        #if canImport(Darwin)
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        #endif
    }

    deinit { closeFd(fd) }

    /// The next bytes (1…max), nil at the end of the stream or on an error. `timeoutSeconds` 0: wait for ever.
    public func read(max: Int, timeoutSeconds: Int = 0) -> Bytes? {
        var tv = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var buffer = Bytes(repeating: 0, count: max)
        while true {
            let n = buffer.withUnsafeMutableBytes { readFd(fd, $0.baseAddress, max) }
            if n > 0 { return Bytes(buffer[0..<n]) }
            if n < 0 && errno == EINTR { continue }
            return nil
        }
    }

    /// Writes everything; false when the peer is gone.
    @discardableResult
    public func write(_ data: Bytes) -> Bool {
        var sent = 0
        while sent < data.count {
            let n = data.withUnsafeBytes { writeFd(fd, $0.baseAddress! + sent, data.count - sent) }
            if n > 0 { sent += n; continue }
            if n < 0 && errno == EINTR { continue }
            return false
        }
        return true
    }

    public func shutdown() {
        lock.lock()
        if down { lock.unlock(); return }
        down = true
        lock.unlock()
        _ = shutdownFd(fd, Int32(SHUT_RDWR))
    }

    public var isShutdown: Bool { lock.lock(); defer { lock.unlock() }; return down }

    /// A client connection to 127.0.0.1:`port` (tests and the page's own requests use real clients; this is for tests).
    public static func connect(port: Int) -> TcpConnection? {
        let fd = socket(AF_INET, sockStream, 0)
        if fd < 0 { return nil }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connectFd(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        if result != 0 { closeFd(fd); return nil }
        return TcpConnection(fd: fd)
    }
}

/// A listening socket on 127.0.0.1.
public final class LoopbackListener {
    private let fd: Int32
    public let port: Int
    private let lock = NSLock()
    private var closedFlag = false
    private var fdReleased = false

    /// Listens on 127.0.0.1:`port` (0: any free one; a taken port: any free one, or with `fallback` false an error – a port that must not change).
    public init(port wanted: Int, fallback: Bool = true) throws {
        signal(SIGPIPE, SIG_IGN)
        func bound(_ port: Int) -> Int32? {
            let fd = socket(AF_INET, sockStream, 0)
            if fd < 0 { return nil }
            var yes: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = UInt16(port).bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let result = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            if result != 0 || listen(fd, 32) != 0 { closeFd(fd); return nil }
            return fd
        }
        var first: Int32? = nil
        if wanted > 0 { // the port of a company just left may need a moment to come free
            for attempt in 0..<15 { first = bound(wanted); if first != nil { break }; if attempt < 14 { usleep(100_000) } }
        }
        guard let fd = first ?? (fallback || wanted == 0 ? bound(0) : nil) else { throw AutarkError("The app could not open its local entrance.") }
        var addr = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        self.fd = fd
        self.port = Int(UInt16(bigEndian: addr.sin_port))
    }

    deinit { releaseFd() }

    public var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }

    /// Ends accepting: the accept loop notices within 200 ms and gives the port back then (the loop owns the descriptor
    /// while it runs, so no other socket can ever take its number under a poll in progress).
    public func close() { lock.lock(); closedFlag = true; lock.unlock() }

    private func releaseFd() {
        lock.lock()
        if fdReleased { lock.unlock(); return }
        fdReleased = true
        lock.unlock()
        closeFd(fd)
    }

    /// The next connection, or nil after close(). Polls so close() is noticed on every platform.
    public func accept() -> TcpConnection? {
        defer { if isClosed { releaseFd() } }
        while !isClosed {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, 200)
            if ready < 0 && errno != EINTR { return nil }
            if ready <= 0 { continue }
            let client = acceptFd(fd)
            if client >= 0 { return TcpConnection(fd: client) }
            if errno != EINTR && errno != ECONNABORTED && errno != EAGAIN { return nil }
        }
        return nil
    }
}
