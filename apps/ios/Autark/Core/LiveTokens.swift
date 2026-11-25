// Owns: telling the PC this phone's Live Activity push tokens with the RPC `phone.liveToken` (contract IPHONE-WELLE2.md, part D2
// builds it on the PC): {kind: 'start', token, env, bundle} for the push-to-start token (ActivityKit's pushToStartTokenUpdates, iOS
// 17.2+) and {kind: 'activity', token, env, bundle, job} for the token of the running activity of the PC's run `job`
// (activity.pushTokenUpdates); a token that is gone goes as {kind, token: null} (with its job). Each token is sent until the PC took
// it (an answer without error), again only when it changes; flush() retries what is still owed (the link came back). Tokens are hex,
// like APNs device tokens (PushRegistration). Pure Foundation (Linux tests with a fake sender).
// Never: sends the same token twice in a row, or keeps an activity's entry after its null went through.
import Foundation

public final class LiveTokens {
    public enum Kind: String { case start, activity }

    /// Sends one phone.liveToken's params; `done(true)` when the PC took it.
    public typealias Sender = (_ params: JSONObject, _ done: @escaping (Bool) -> Void) -> Void

    private let bundle: String
    private let environment: PushEnvironment
    private let sender: Sender
    private let lock = NSLock()
    /// What the PC should know, by key ("start", "activity:<job>").
    private var wanted = [String: JSONObject]()
    /// What it took last, by key (the params as JSON text).
    private var taken = [String: String]()
    private var sending = Set<String>()

    public init(bundle: String, environment: PushEnvironment, sender: @escaping Sender) {
        self.bundle = bundle
        self.environment = environment
        self.sender = sender
    }

    /// The push-to-start token changed (nil: there is none any more).
    public func start(token: Bytes?) { set(key: "start", params(.start, token, job: nil)) }

    /// The running activity of `job` has this token (nil: the activity ended).
    public func activity(job: String, token: Bytes?) { set(key: "activity:" + job, params(.activity, token, job: job)) }

    /// Sends everything the PC has not taken yet (after the link came back).
    public func flush() {
        lock.lock()
        let owed = wanted.filter { taken[$0.key] != Json.write($0.value) && !sending.contains($0.key) }
        for key in owed.keys { sending.insert(key) }
        lock.unlock()
        for (key, value) in owed.sorted(by: { $0.key < $1.key }) { send(key, value) }
    }

    /// The keys still owed to the PC (tests, diagnostics).
    public var pending: [String] {
        lock.lock(); defer { lock.unlock() }
        return wanted.keys.filter { taken[$0] != Json.write(wanted[$0]) }.sorted()
    }

    private func params(_ kind: Kind, _ token: Bytes?, job: String?) -> JSONObject {
        var out: JSONObject = ["kind": kind.rawValue]
        if let token = token, !token.isEmpty {
            out["token"] = Crypto.hex(token)
            out["env"] = environment.rawValue
            out["bundle"] = bundle
        } else {
            out["token"] = NSNull()
        }
        if let job = job { out["job"] = job }
        return out
    }

    private func set(key: String, _ value: JSONObject) {
        lock.lock()
        let text = Json.write(value)
        if taken[key] == nil && value["token"] is NSNull && wanted[key] == nil { lock.unlock(); return } // nothing the PC knew: nothing to clear
        wanted[key] = value
        let owed = taken[key] != text && !sending.contains(key)
        if owed { sending.insert(key) }
        lock.unlock()
        if owed { send(key, value) }
    }

    private func send(_ key: String, _ value: JSONObject) {
        let text = Json.write(value)
        sender(value) { [weak self] ok in
            guard let self = self else { return }
            self.lock.lock()
            self.sending.remove(key)
            if ok {
                self.taken[key] = text
                if value["token"] is NSNull && key != "start" && Json.write(self.wanted[key]) == text { self.wanted[key] = nil; self.taken[key] = nil } // the ended activity is forgotten
            }
            let again = ok ? self.wanted[key].flatMap { Json.write($0) != text ? $0 : nil } : nil // it changed while this one was on its way
            if again != nil { self.sending.insert(key) }
            self.lock.unlock()
            if let again = again { self.send(key, again) }
        }
    }
}
