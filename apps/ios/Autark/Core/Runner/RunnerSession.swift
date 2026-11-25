// Owns: what one connection of the Autark runner protocol v1 may do, and when (PROTOKOLL-RUNNER.md 1–3, 7, 8): the preamble, hello
// and auth with the two-sided proof, nothing before auth but hello/auth, strictly one request at a time (`busy`), `not_ready` while
// the iOS automation is not there, ping and end, the 5 s to authenticate and the 60 s of silence – as a state machine fed with bytes
// and a clock, so the same logic runs in the tests on Linux and behind Network.framework on the iPhone. `RunnerHub` holds the rules
// across connections: one authenticated connection, at most two unauthenticated, five failed proofs end the runner, the idle end.
import Foundation

public final class RunnerSession {
    public enum Phase: Equatable { case preamble, hello, auth, ready, closed }

    public enum Action {
        /// Bytes to write.
        case send(Bytes)
        /// Close the connection (after the sends before it).
        case close
        /// Carry out an operation on the device; answer with `complete(id:answer:)`.
        case perform(id: Int, op: RunnerOp)
        /// The proof was right: the hub closes older authenticated connections; `apps` is the PC's list of installed apps.
        case authed(apps: [String])
        /// A wrong proof (counted by the hub).
        case authFailed
        /// `end` was answered: the runner stops serving and the test ends.
        case end
    }

    public static let authWindowMs: Int64 = 5000
    public static let silenceMs: Int64 = 60_000

    private let token: Bytes
    private let caps: Set<String>
    private let welcome: () -> JSONObject
    private let uptimeMs: () -> Int
    private let makeNonce: () -> Bytes
    private var reader = RunnerFrameReader(jsonMax: RunnerWire.requestJsonMax, binMax: 0)
    private var pcNonce = Bytes()
    private var runnerNonce = Bytes()
    private let openedAt: Int64
    private var lastHeard: Int64

    public private(set) var phase = Phase.preamble
    /// The id of the operation the device is carrying out for this connection.
    public private(set) var inFlight: Int?
    /// Set by the runner while the iOS automation cannot serve (start, or a stuck operation): device operations answer not_ready.
    public var notReady = false

    public init(token: Bytes, caps: Set<String>, now: Int64, welcome: @escaping () -> JSONObject, uptimeMs: @escaping () -> Int,
                nonce: @escaping () -> Bytes = { Crypto.random(16) }) {
        self.token = token
        self.caps = caps
        self.welcome = welcome
        self.uptimeMs = uptimeMs
        self.makeNonce = nonce
        self.openedAt = now
        self.lastHeard = now
    }

    public var isAuthed: Bool { phase == .ready }

    /// Bytes from the PC.
    public func receive(_ bytes: Bytes, now: Int64) -> [Action] {
        guard phase != .closed else { return [] }
        reader.push(bytes)
        var actions = [Action]()
        if phase == .preamble {
            guard let head = reader.take(RunnerWire.preamble.count) else {
                // A stray client (an HTTP GET …) is closed as soon as its first bytes differ.
                let got = reader.take(reader.buffered) ?? []
                if !RunnerWire.preamble.starts(with: got) { return close() }
                reader.push(got)
                return []
            }
            guard head == RunnerWire.preamble else { return close() }
            phase = .hello
            actions.append(.send(RunnerWire.preamble))
        }
        while phase != .closed {
            let frame: (json: JSONObject, binary: Bytes)?
            do { frame = try reader.next() } catch { return actions + close() }
            guard let whole = frame else { break }
            lastHeard = now
            actions += handle(whole.json)
        }
        return actions
    }

    /// The device finished operation `id`. An answer for an id that is no longer running (timed out) is dropped.
    public func complete(id: Int, answer: RunnerAnswer) -> [Action] {
        guard phase == .ready, inFlight == id else { return [] }
        inFlight = nil
        return [.send(answer.frame(id: id))]
    }

    /// The operation took longer than its limit: answer `timeout` now; the late result is dropped by `complete`.
    public func timedOut(id: Int) -> [Action] {
        complete(id: id, answer: .fail(.timeout, "The operation took longer than its time limit."))
    }

    /// Called about once a second: 5 s to authenticate, 60 s of silence on an authenticated connection.
    public func tick(now: Int64) -> [Action] {
        switch phase {
        case .closed: return []
        case .ready:
            if inFlight == nil && now - lastHeard > Self.silenceMs { return close() }
            return []
        default:
            return now - openedAt > Self.authWindowMs ? close() : []
        }
    }

    public func close() -> [Action] {
        guard phase != .closed else { return [] }
        phase = .closed
        inFlight = nil
        return [.close]
    }

    // MARK: requests

    private func handle(_ json: JSONObject) -> [Action] {
        guard let id = RunnerRequest.id(json) else {
            return [.send(RunnerAnswer.fail(.badRequest, "The request needs an id from 1 to 2147483647.").frame(id: 0))]
        }
        if phase == .ready && inFlight != nil {
            return [.send(RunnerAnswer.fail(.busy, "Another request is still running.").frame(id: id))]
        }
        let request: RunnerRequest
        switch RunnerRequest.parse(json, caps: caps) {
        case .failure(let failure):
            if phase != .ready && failure.code != .unsupportedVersion && json["op"] as? String != "hello" && json["op"] as? String != "auth" {
                return refuse(id, .unauthorized, "Authenticate first.")
            }
            var out: [Action] = [.send(failure.answer.frame(id: id))]
            if failure.code.closes || phase != .ready { out += close() }
            return out
        case .success(let parsed):
            request = parsed
        }
        switch request {
        case .hello(let v, let nonce):
            guard phase == .hello || phase == .auth else { return [.send(RunnerAnswer.fail(.badRequest, "hello comes once, first.").frame(id: id))] }
            pcNonce = nonce
            runnerNonce = makeNonce()
            phase = .auth
            let proof = RunnerWire.proof(token: token, label: RunnerWire.runnerLabel, pcNonce: pcNonce, runnerNonce: runnerNonce)
            return [.send(RunnerAnswer.done(["v": v, "nonce": Crypto.hex(runnerNonce), "proof": proof]).frame(id: id))]
        case .auth(let proof, let apps):
            guard phase == .auth else {
                if phase == .ready { return [.send(RunnerAnswer.fail(.badRequest, "Already authenticated.").frame(id: id))] }
                return refuse(id, .unauthorized, "Say hello first.")
            }
            let expected = Crypto.hmacSHA256(key: token, data: Bytes(RunnerWire.pcLabel.utf8) + pcNonce + runnerNonce)
            guard Crypto.constantEquals(expected, proof) else {
                return [.authFailed] + refuse(id, .authFailed, "Wrong proof.")
            }
            phase = .ready
            return [.authed(apps: apps), .send(RunnerAnswer.done(welcome()).frame(id: id))]
        case .ping:
            guard phase == .ready else { return refuse(id, .unauthorized, "Authenticate first.") }
            return [.send(RunnerAnswer.done(["uptimeMs": uptimeMs()]).frame(id: id))]
        case .end:
            guard phase == .ready else { return refuse(id, .unauthorized, "Authenticate first.") }
            return [.send(RunnerAnswer.done().frame(id: id)), .end] + close()
        case .op(let op):
            guard phase == .ready else { return refuse(id, .unauthorized, "Authenticate first.") }
            if notReady { return [.send(RunnerAnswer.fail(.notReady, "The iOS automation is not ready yet.").frame(id: id))] }
            inFlight = id
            return [.perform(id: id, op: op)]
        }
    }

    private func refuse(_ id: Int, _ code: RunnerCode, _ message: String) -> [Action] {
        [.send(RunnerAnswer.fail(code, message).frame(id: id))] + close()
    }
}

/// The rules across connections.
public final class RunnerHub {
    public static let unauthenticatedMax = 2
    public static let failedProofsMax = 5

    public let idleMs: Int64
    private var pending = Set<Int>()
    private var authed: Int?
    private var failures = 0
    private var idleSince: Int64

    public init(idleSeconds: Int, now: Int64) {
        idleMs = Int64(idleSeconds) * 1000
        idleSince = now
    }

    public var failedProofs: Int { failures }
    public var current: Int? { authed }

    /// A new connection: false = close it at once (two others are still authenticating).
    public func accept(_ connection: Int) -> Bool {
        guard pending.count < Self.unauthenticatedMax else { return false }
        pending.insert(connection)
        return true
    }

    /// `connection` authenticated: the older authenticated connection to close, if any.
    public func authenticated(_ connection: Int) -> Int? {
        pending.remove(connection)
        let older = authed
        authed = connection
        return older == connection ? nil : older
    }

    /// A wrong proof: true = the fifth in the runner's life, it ends.
    public func failedProof() -> Bool {
        failures += 1
        return failures >= Self.failedProofsMax
    }

    public func closed(_ connection: Int, now: Int64) {
        pending.remove(connection)
        if authed == connection {
            authed = nil
            idleSince = now
        }
    }

    /// True when the runner has had no authenticated connection for the idle time: it ends itself.
    public func idleEnd(now: Int64) -> Bool { authed == nil && now - idleSince >= idleMs }
}
