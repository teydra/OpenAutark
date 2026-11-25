// Owns: the iPhone app's own second socket to the PC – the Android app's UseLink (phoneuse/UseLink.java) for iOS: `/ws` through the
// same local entrance as the web view (its gate cookie, this phone's token), so it reaches whichever PC the page uses now (direct or
// through the tunnel) and lives as long as the app's connection does (on iOS: while the app runs; in the background iOS ends it and
// the PC reaches the phone through Live Activity pushes instead – part D2). Hello and `events.subscribe ['system']` go out first, then
// `phoneUse.attach {model, screen, ready: false, platform: 'ios', steps: ['say', 'done']}` (no accessibility service on iOS: WebDriverAgent acts from the PC, part D1);
// `phoneUse.request` for this device only goes to onRequest (PhoneUseResponder), its answers go back as phoneUse.reply. The same
// socket carries the app's own calls (call / request: phone.liveToken, phoneUse.control, chats.list, files.upload, messages.send …):
// one frame {id, method, params}, its {id, result} / {id, error:{message}} to the caller; a socket that ends fails every waiting call.
// Reconnects with Android's backoff (2 s … 60 s; back to 2 s only after an attach answer); nudge() tries at once (foreground).
// Never: acts on a request for another device, keeps a call past its socket, or writes the token anywhere but the hello.
import Foundation

/// One request to the PC with this phone's rights, waited for on the caller's (non-main) thread.
public protocol RpcCaller: AnyObject {
    func request(_ method: String, _ params: JSONObject, timeoutMs: Int) throws -> Any?
}

public final class UseLink: WebSocketListener, RpcCaller {
    public static let backoffMs = [2_000, 5_000, 15_000, 30_000, 60_000]
    /// What a call hears when the phone has no socket to the PC right now, or the socket ended before the answer.
    public static let unlinked = "Not connected to your PC right now."

    /// A step for this phone (phoneUse.request's data, already filtered by device) – on the socket's reader thread.
    public var onRequest: (PhoneUseResponder.Request) -> Void = { _ in }
    /// The socket is usable (the PC answered attach: true) or ended (false) – on a background thread.
    public var onLinked: (Bool) -> Void = { _ in }
    /// Every other event frame (name, data), e.g. `notify` – on the reader thread.
    public var onEvent: (String, JSONObject) -> Void = { _, _ in }

    private let url: String
    private let gate: String
    private let token: String
    private let deviceId: String
    private let model: String
    private let screen: (width: Int, height: Int)
    private let connector: WebSocketConnector
    private let condition = NSCondition()
    private var socket: WebSocketLink?
    private var stopped = false
    private var wake = false
    private var closes = 0
    private var answered = false
    private var attachId = -1
    private var nextId = 1
    private var calls = [Int: (Result<Any?, AutarkError>) -> Void]()

    /// `origin`: the local entrance (http://127.0.0.1:<port>); `gate`: its cookie; `token`, `deviceId`: this phone's on the PC.
    public init(origin: String, gate: String, token: String, deviceId: String, model: String, screen: (width: Int, height: Int), connector: WebSocketConnector) {
        let base = origin.hasPrefix("https") ? "wss" + origin.dropFirst(5) : (origin.hasPrefix("http") ? "ws" + origin.dropFirst(4) : origin)
        self.url = base + "/ws"
        self.gate = gate
        self.token = token
        self.deviceId = deviceId
        self.model = String(model.prefix(60))
        self.screen = screen
        self.connector = connector
    }

    public func start() { spawn("autark-use-link") { [self] in self.run() } }

    public func stop() {
        condition.lock(); stopped = true; let current = socket; condition.broadcast(); condition.unlock()
        current?.close()
        failCalls()
    }

    /// Try now instead of after the pause (the app came forward, the page's PC changed).
    public func nudge() { condition.lock(); wake = true; condition.broadcast(); condition.unlock() }

    /// The socket is up and the PC answered attach.
    public var isLinked: Bool { condition.lock(); defer { condition.unlock() }; return socket != nil && answered }

    /// Waits (not on the main thread) until isLinked, at most `timeoutMs`.
    public func waitLinked(timeoutMs: Int) -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        condition.lock(); defer { condition.unlock() }
        while !(socket != nil && answered) {
            if stopped || !condition.wait(until: deadline) { return socket != nil && answered }
        }
        return true
    }

    /// One request; `done` hears its result or error once (on the reader thread, or the caller's when nothing went out).
    public func call(_ method: String, _ params: JSONObject, _ done: @escaping (Result<Any?, AutarkError>) -> Void) {
        condition.lock()
        guard let ws = socket, !stopped else { condition.unlock(); done(.failure(AutarkError(UseLink.unlinked))); return }
        let id = nextId
        nextId += 1
        calls[id] = done
        condition.unlock()
        do { try ws.sendText(Json.write(["id": id, "method": method, "params": params] as JSONObject)) } catch {
            ws.close()
            take(id)?(.failure(AutarkError(UseLink.unlinked)))
        }
    }

    /// call(), waited for at most `timeoutMs` on this (non-main) thread: the result, or AutarkError (the PC's message, or "timeout").
    public func request(_ method: String, _ params: JSONObject, timeoutMs: Int) throws -> Any? {
        let answer = Future<Any?>()
        call(method, params) { result in
            switch result {
            case .success(let value): answer.complete(value)
            case .failure(let error): answer.fail(error)
            }
        }
        return try answer.get(timeout: Double(timeoutMs) / 1000)
    }

    /// A call whose answer nobody waits for (phoneUse.reply, phoneUse.control); false without a socket.
    @discardableResult
    public func send(_ method: String, _ params: JSONObject) -> Bool {
        condition.lock(); let up = socket != nil && !stopped; condition.unlock()
        call(method, params) { _ in }
        return up
    }

    // MARK: the loop

    private func run() {
        var attempt = 0
        while !isStopped {
            do {
                condition.lock(); let seen = closes; answered = false; condition.unlock()
                let options = WebSocketOptions(connectTimeoutMs: 10_000, maxMessage: 16 * 1024 * 1024, headers: ["Cookie": "\(StreamProxy.gateCookie)=\(gate)"])
                let ws = try connector.connect(url: url, listener: self, options: options)
                try ws.sendText(Json.write(["protocol": 1, "token": token, "client": "pwa", "deviceName": model] as JSONObject))
                try ws.sendText(Json.write(["id": takeId(), "method": "events.subscribe", "params": ["topics": ["system"] as [Any]] as JSONObject] as JSONObject))
                condition.lock()
                if closes == seen && !stopped { socket = ws }
                let mine = socket === ws
                condition.unlock()
                ws.start()
                if mine { attach(ws) } else { ws.close() }
                condition.lock()
                while !stopped && closes == seen { _ = condition.wait(until: Date().addingTimeInterval(60)) }
                if socket === ws { socket = nil }
                let worked = answered
                condition.unlock()
                if worked { attempt = 0 } // only an attach answer counts as a working connection
            } catch {
                // out of reach: the backoff below
            }
            pause(UseLink.backoffMs[min(attempt, UseLink.backoffMs.count - 1)])
            attempt += 1
        }
    }

    private var isStopped: Bool { condition.lock(); defer { condition.unlock() }; return stopped }

    private func takeId() -> Int { condition.lock(); defer { condition.unlock() }; let id = nextId; nextId += 1; return id }

    private func attach(_ ws: WebSocketLink) {
        let id = takeId()
        condition.lock(); attachId = id; condition.unlock()
        let params: JSONObject = ["model": model, "ready": false, "platform": "ios", "steps": ["say", "done"] as [Any],
                                  "screen": ["width": screen.width, "height": screen.height] as JSONObject]
        do { try ws.sendText(Json.write(["id": id, "method": "phoneUse.attach", "params": params] as JSONObject)) } catch { ws.close() }
    }

    private func pause(_ ms: Int) {
        condition.lock()
        if !wake && !stopped { _ = condition.wait(until: Date().addingTimeInterval(Double(ms) / 1000)) }
        wake = false
        condition.unlock()
    }

    private func take(_ id: Int) -> ((Result<Any?, AutarkError>) -> Void)? {
        condition.lock(); defer { condition.unlock() }
        return calls.removeValue(forKey: id)
    }

    private func failCalls() {
        condition.lock(); let waiting = Array(calls.values); calls = [:]; condition.unlock()
        for done in waiting { done(.failure(AutarkError(UseLink.unlinked))) }
    }

    // MARK: WebSocketListener

    public func text(_ text: String) {
        guard let frame = try? Json.object(text) else { return }
        if let event = Json.str(frame, "event") {
            guard let data = frame["data"] as? JSONObject else { return }
            if event == "phoneUse.request" {
                guard Json.str(data, "deviceId") == deviceId, let request = PhoneUseResponder.Request(data) else { return }
                onRequest(request)
                return
            }
            onEvent(event, data)
            return
        }
        let id = Json.num(frame, "id", -1)
        if id < 0 { return }
        condition.lock()
        let isAttach = id == attachId
        if isAttach && frame["result"] is JSONObject { answered = true; condition.broadcast() }
        condition.unlock()
        if isAttach && frame["result"] is JSONObject { onLinked(true) }
        guard let done = take(id) else { return }
        if let error = frame["error"] {
            let message = (error as? JSONObject).flatMap { Json.str($0, "message") } ?? ""
            done(.failure(AutarkError(message.isEmpty ? "The PC refused it." : message)))
        } else {
            done(.success(frame["result"]))
        }
    }

    public func binary(_ data: Bytes) { /* the RPC socket sends text only */ }

    public func closed(_ reason: String) {
        condition.lock()
        closes += 1
        let wasLinked = socket != nil && answered
        socket = nil
        condition.broadcast()
        condition.unlock()
        failCalls()
        if wasLinked { onLinked(false) }
    }
}
