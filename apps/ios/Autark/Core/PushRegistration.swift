// Owns: the interface that APNs plugs into later – asking the person for notifications, registering with Apple for a device token,
// remembering the token and handing it to the server part (the PC or the meeting server) until that took it, and forgetting it when
// the phone is forgotten. Everything here works without a paid Apple account and is tested with fakes: the platform side
// (UNUserNotificationCenter, UIApplication.registerForRemoteNotifications) and the server side are protocols; the real APNs token only
// exists on a signed build with the push entitlement (aps-environment), and a PC cannot send APNs without a server that holds the
// APNs key – an open decision for Konrad and Felix (apps/ios/README.md, "Benachrichtigungen").
// The default sink in the app sends {t:'push.token', token, env, bundle, platform:'apns'} (or token:null) to the page through the
// existing native port; the page does not handle it yet – that, and `phone.pushToken` on the PC, are the server part still to build.
// Never: asks for permission by itself at launch, sends a token to anything but its sink, or registers while `enabled` is false.
import Foundation

public enum PushEnvironment: String { case sandbox, production }

/// The token APNs gave this app on this phone.
public struct PushToken: Equatable {
    public let token: String
    public let environment: PushEnvironment
    public let bundleId: String

    public init(token: String, environment: PushEnvironment, bundleId: String) { self.token = token; self.environment = environment; self.bundleId = bundleId }

    /// APNs' device token as the lowercase hex its HTTP/2 API takes.
    public static func hex(_ deviceToken: Bytes) -> String { Crypto.hex(deviceToken) }

    /// The message to the page (`nil`: this phone no longer takes pushes).
    public static func message(_ token: PushToken?) -> JSONObject {
        guard let token = token else { return ["t": "push.token", "token": NSNull(), "platform": "apns"] }
        return ["t": "push.token", "token": token.token, "env": token.environment.rawValue, "bundle": token.bundleId, "platform": "apns"]
    }
}

public enum PushAuthorization: Equatable { case notDetermined, denied, allowed }

/// The phone's side: what iOS must be asked (a real UIApplication and UNUserNotificationCenter in the app, a fake in tests).
public protocol PushPlatform: AnyObject {
    func authorization(_ done: @escaping (PushAuthorization) -> Void)
    func requestAuthorization(_ done: @escaping (Bool) -> Void)
    /// Starts the registration with Apple; the answer comes to `PushRegistration.didRegister` or `didFail`.
    func registerForRemoteNotifications()
}

/// The server part: hands the token on. Throws when it could not be delivered now (the registration tries again on `deliverPending`).
public protocol PushSink: AnyObject {
    func deliver(_ token: PushToken?) throws
}

public enum PushState: Equatable {
    /// Switched off in this build (no push entitlement, no server yet): nothing is asked or registered.
    case off
    case needsAuthorization
    case denied
    case waitingForToken
    case registered
    case failed(String)
}

public final class PushRegistration {
    private static let storeKey = "push.token"

    private let platform: PushPlatform
    private let sink: PushSink
    private let store: StringStore
    private let bundleId: String
    private let environment: PushEnvironment
    private let enabled: Bool
    private let lock = NSLock()
    private var stateValue: PushState
    private var delivered = false
    private var token: PushToken?

    public init(platform: PushPlatform, sink: PushSink, store: StringStore, bundleId: String, environment: PushEnvironment, enabled: Bool) {
        self.platform = platform; self.sink = sink; self.store = store; self.bundleId = bundleId; self.environment = environment; self.enabled = enabled
        self.stateValue = enabled ? .needsAuthorization : .off
        if let text = store.get(PushRegistration.storeKey), let row = try? Json.object(text), let value = Json.str(row, "token"), !value.isEmpty {
            token = PushToken(token: value, environment: Json.str(row, "env").flatMap { PushEnvironment(rawValue: $0) } ?? environment, bundleId: Json.str(row, "bundle") ?? bundleId)
            delivered = row["delivered"] as? Bool == true
        }
    }

    public var state: PushState { lock.lock(); defer { lock.unlock() }; return stateValue }

    /// The token kept (nil before the first registration).
    public var currentToken: PushToken? { lock.lock(); defer { lock.unlock() }; return token }

    /// True once the sink took the kept token.
    public var isDelivered: Bool { lock.lock(); defer { lock.unlock() }; return delivered }

    private func set(_ next: PushState) { lock.lock(); stateValue = next; lock.unlock() }

    /// The person agreed to notifications (a button, never the launch): asks iOS once, then registers with Apple.
    public func enable() {
        guard enabled else { set(.off); return }
        platform.authorization { [self] status in
            switch status {
            case .denied: set(.denied)
            case .allowed: set(.waitingForToken); platform.registerForRemoteNotifications()
            case .notDetermined:
                platform.requestAuthorization { [self] granted in
                    if granted { set(.waitingForToken); platform.registerForRemoteNotifications() } else { set(.denied) }
                }
            }
        }
    }

    /// Apple gave this app its device token (AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken).
    public func didRegister(deviceToken: Bytes) {
        guard enabled, !deviceToken.isEmpty, deviceToken.count <= 100 else { return }
        let next = PushToken(token: PushToken.hex(deviceToken), environment: environment, bundleId: bundleId)
        lock.lock()
        let same = token == next
        token = next
        if !same { delivered = false }
        stateValue = .registered
        lock.unlock()
        save()
        deliverPending()
    }

    /// Apple refused (no entitlement on an unsigned build, no network, a simulator without push).
    public func didFail(_ message: String) { if enabled { set(.failed(message)) } }

    /// Hands the kept token to the sink when it did not take it yet (called after a registration, when the app comes forward and when
    /// a company opens); a failing sink keeps the token for the next time. True when nothing is left to deliver.
    @discardableResult
    public func deliverPending() -> Bool {
        lock.lock(); let current = token; let done = delivered; lock.unlock()
        guard let value = current, !done else { return true }
        do { try sink.deliver(value) } catch { return false }
        lock.lock(); if token == value { delivered = true }; lock.unlock()
        save()
        return true
    }

    /// "Forget this phone": the sink hears that there is no token any more and the kept one goes.
    public func forget() {
        lock.lock(); let had = token != nil; token = nil; delivered = false; stateValue = enabled ? .needsAuthorization : .off; lock.unlock()
        store.put(PushRegistration.storeKey, nil)
        if had { try? sink.deliver(nil) }
    }

    private func save() {
        lock.lock(); let value = token; let done = delivered; lock.unlock()
        guard let kept = value else { return }
        store.put(PushRegistration.storeKey, Json.write(["token": kept.token, "env": kept.environment.rawValue, "bundle": kept.bundleId, "delivered": done] as JSONObject))
    }
}
