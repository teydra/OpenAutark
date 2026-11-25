// Owns: the meeting-server WebSocket on Apple platforms – URLSessionWebSocketTask with the system's normal TLS checks (wss
// only in the app; ws works for the loopback tests). It fits the core's WebSocketLink: the upgrade is awaited in connect(),
// frames reach the listener after start(), every frame (a pong too) counts as traffic, kill() ends a stuck connection at
// once and the listener hears `closed` exactly once. URLSession answers the server's pings by itself and shows them to nobody,
// so the core's checkAlive() pings after a quiet spell instead of waiting for them.
// Never: skips certificate checks, reconnects by itself, or blocks the caller's thread on a send (sends queue in order).
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import AutarkCore

public struct URLSessionConnector: WebSocketConnector {
    public init() {}

    public func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink {
        try connect(url: url, listener: listener, options: .relay)
    }

    /// `options.connectTimeoutMs` bounds the connect and the upgrade together (a direct socket to a PC: 1.5 s), `maxMessage` the frames.
    public func connect(url: String, listener: WebSocketListener, options: WebSocketOptions) throws -> WebSocketLink {
        guard let address = URL(string: url), let scheme = address.scheme?.lowercased(), scheme == "wss" || scheme == "ws" else {
            throw AutarkError("Not a WebSocket address")
        }
        let socket = URLSessionSocket(url: address, listener: listener, options: options)
        try socket.open()
        return socket
    }
}

final class URLSessionSocket: NSObject, WebSocketLink, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
    private let url: URL
    private weak var listener: WebSocketListener?
    private let lock = NSLock()
    private let opened = Future<Bool>()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var closedFlag = false
    private var started = false
    private var last = Date().timeIntervalSince1970
    private var count = 0

    private let options: WebSocketOptions

    init(url: URL, listener: WebSocketListener, options: WebSocketOptions = .relay) {
        self.url = url
        self.listener = listener
        self.options = options
        super.init()
    }

    /// Starts the connection and waits (≤ options.connectTimeoutMs) until the WebSocket upgrade is done.
    func open() throws {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "autark-websocket"
        let seconds = Double(options.connectTimeoutMs) / 1000
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = seconds
        if options.headers["Cookie"] != nil { config.httpShouldSetCookies = false } // our own cookie goes as written (UseLink's gate)
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        var request = URLRequest(url: url)
        for (name, value) in options.headers { request.setValue(value, forHTTPHeaderField: name) }
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = options.maxMessage
        lock.lock(); self.session = session; self.task = task; lock.unlock()
        task.resume()
        do { _ = try opened.get(timeout: seconds) } catch {
            teardown()
            throw (error as? AutarkError) ?? AutarkError("The meeting server did not answer.")
        }
    }

    // MARK: WebSocketLink

    func start() {
        lock.lock()
        if started || closedFlag { lock.unlock(); return }
        started = true
        lock.unlock()
        receiveNext()
    }

    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var lastFrameAt: TimeInterval { lock.lock(); defer { lock.unlock() }; return last }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return count }

    private func touch() { lock.lock(); last = Date().timeIntervalSince1970; count += 1; lock.unlock() }

    private func currentTask() -> URLSessionWebSocketTask? { lock.lock(); defer { lock.unlock() }; return closedFlag ? nil : task }

    func sendText(_ text: String) throws {
        guard let task = currentTask() else { throw AutarkError("closed") }
        task.send(.string(text)) { [weak self] error in if error != nil { self?.kill() } }
    }

    func sendBinary(_ data: Bytes) throws {
        guard let task = currentTask() else { throw AutarkError("closed") }
        task.send(.data(Data(data))) { [weak self] error in if error != nil { self?.kill() } }
    }

    func ping() throws {
        guard let task = currentTask() else { throw AutarkError("closed") }
        task.sendPing { [weak self] error in if error == nil { self?.touch() } }
    }

    func close() { finish(reason: "closed", code: .normalClosure) }

    func kill() { finish(reason: "killed", code: .goingAway) }

    private func finish(reason: String, code: URLSessionWebSocketTask.CloseCode) {
        lock.lock()
        if closedFlag { lock.unlock(); return }
        closedFlag = true
        let task = self.task
        let session = self.session
        let target = listener
        lock.unlock()
        opened.fail(AutarkError("The meeting server did not answer."))
        task?.cancel(with: code, reason: nil)
        session?.finishTasksAndInvalidate()
        target?.closed(reason)
    }

    private func teardown() {
        lock.lock()
        closedFlag = true
        let task = self.task
        let session = self.session
        lock.unlock()
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    private func receiveNext() {
        guard let task = currentTask() else { return }
        task.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                self.touch()
                switch message {
                case .string(let text): self.listener?.text(text)
                case .data(let data): self.listener?.binary(Bytes(data))
                @unknown default: break
                }
                self.receiveNext()
            case .failure(let error):
                self.finish(reason: error.localizedDescription, code: .goingAway)
            }
        }
    }

    // MARK: delegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        opened.complete(true)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(reason: "closed by the server (\(closeCode.rawValue))", code: closeCode)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error { opened.fail(AutarkError("The meeting server did not answer: \(error.localizedDescription)")) }
        finish(reason: error?.localizedDescription ?? "closed", code: .goingAway)
    }
}
