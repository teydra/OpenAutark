// Owns: the notifications of the app on iOS – the scaffold that works without a paid Apple account: local notifications through
// UNUserNotificationCenter shaped like the PC's service worker shows them (Core/Notices.swift decides: one notice per tag, Due
// to-dos grouped under "due" and closed after 6 s, chat counts, quiet duplicates, `clear`), the delegate that shows a notice while the
// app is in front and hears a tap or a button ("KI fragt, Person tippt einmal": ✓ ✕ or the AI's own labels), the badge, and the
// system adapters of the push interface (PushPlatform: authorization and registerForRemoteNotifications; the token callbacks of
// the app delegate). A remote push (APNs) enters through `Notifier.receive` too, once an Apple account, the push entitlement and a
// server exist (Core/PushRegistration.swift).
// Never: asks for permission at launch, talks to a PC, keeps a secret, or is created in a unit-test process (UNUserNotificationCenter.current()
// crashes there – the app passes the system center in, tests pass a fake).
import SwiftUI
import UIKit
import UserNotifications
import AutarkCore

/// The part of the notification center the notifier needs (a fake in the tests).
protocol NoticeCenter: AnyObject {
    func openNotices(_ done: @escaping ([OpenNotice]) -> Void)
    func requestAuthorization(_ done: @escaping (Bool) -> Void)
    func show(_ content: NoticeContent)
    func close(tag: String)
}

/// Applies the plan of one push or local notice and reports taps and answers.
final class Notifier {
    private let center: NoticeCenter
    private let queue = DispatchQueue(label: "autark-notifier")
    /// The person tapped a notice: its `url` ("/#/chat/<id>").
    var onOpen: ((String) -> Void)?
    /// The person answered a question notice: the notice's id (may be nil) and the answer ('yes', 'no' or a label).
    var onAnswer: ((String?, String) -> Void)?

    init(center: NoticeCenter) { self.center = center }

    func requestAuthorization(_ done: @escaping (Bool) -> Void) { center.requestAuthorization(done) }

    /// One push (or a local source's notice): the open notices are read, the plan runs, its steps are applied in order.
    func receive(_ payload: PushPayload) {
        center.openNotices { [weak self] open in
            guard let self = self else { return }
            self.queue.async { self.apply(NoticePlan.plan(payload, open: open, now: Clock.nowMs())) }
        }
    }

    func apply(_ steps: [NoticeStep]) {
        for step in steps {
            switch step {
            case .close(let tag): center.close(tag: tag)
            case .show(let content): center.show(content)
            case .closeLater(let tag, let stamp, let afterMs):
                queue.asyncAfter(deadline: .now() + .milliseconds(afterMs)) { [weak self] in
                    self?.center.openNotices { open in
                        // a newer Due notice has its own timer: only the one this timer was made for closes
                        if open.contains(where: { $0.tag == tag && $0.due?.stamp == stamp }) { self?.center.close(tag: tag) }
                    }
                }
            }
        }
    }

    /// A tap or a button, from the delegate.
    func responded(action: String, userInfo: JSONObject) {
        if action == UNNotificationDefaultActionIdentifier {
            if let url = Json.str(userInfo, "url") { onOpen?(url) }
            return
        }
        let labels = (userInfo["buttons"] as? [Any] ?? []).compactMap { $0 as? String }
        if let answer = NoticeAsk.answer(action: action, buttons: labels) { onAnswer?(Json.str(userInfo, "id"), answer) }
    }
}

/// UNUserNotificationCenter as a NoticeCenter, and its delegate. Only the app creates it.
final class SystemNoticeCenter: NSObject, NoticeCenter, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    weak var notifier: Notifier?

    override init() {
        super.init()
        center.delegate = self
    }

    func requestAuthorization(_ done: @escaping (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in DispatchQueue.main.async { done(granted) } }
    }

    func openNotices(_ done: @escaping ([OpenNotice]) -> Void) {
        center.getDeliveredNotifications { delivered in
            done(delivered.map { note in
                let content = note.request.content
                let info = content.userInfo.reduce(into: JSONObject()) { out, pair in if let key = pair.key as? String { out[key] = pair.value } }
                return OpenNotice(tag: content.threadIdentifier.isEmpty ? nil : content.threadIdentifier, title: content.title, body: content.body, userInfo: info)
            })
        }
    }

    func show(_ content: NoticeContent) {
        let made = UNMutableNotificationContent()
        made.title = content.title
        made.body = content.body
        made.userInfo = content.userInfo
        if let tag = content.tag { made.threadIdentifier = tag }
        made.sound = content.silent ? nil : .default
        made.badge = NSNumber(value: content.badge)
        made.interruptionLevel = content.ring ? .timeSensitive : .active // a call: effective once the time-sensitive entitlement is signed in
        let identifier = content.tag ?? UUID().uuidString // the same identifier replaces the notice open under it
        if content.ask || !content.buttons.isEmpty {
            made.categoryIdentifier = NoticeAsk.category(buttons: content.buttons)
            register(buttons: content.buttons) { [center = self.center] in center.add(UNNotificationRequest(identifier: identifier, content: made, trigger: nil)) }
        } else {
            center.add(UNNotificationRequest(identifier: identifier, content: made, trigger: nil))
        }
    }

    /// iOS knows a category's actions before the notice arrives: this set's category is added to the ones registered.
    private func register(buttons: [String], then: @escaping () -> Void) {
        let identifier = NoticeAsk.category(buttons: buttons)
        center.getNotificationCategories { [center = self.center] known in
            if known.contains(where: { $0.identifier == identifier }) { then(); return }
            let actions = NoticeAsk.actions(buttons: buttons).map { UNNotificationAction(identifier: $0.id, title: $0.title, options: [.foreground]) }
            let category = UNNotificationCategory(identifier: identifier, actions: actions, intentIdentifiers: [], options: [])
            center.setNotificationCategories(known.union([category]))
            then()
        }
    }

    func close(tag: String) { center.removeDeliveredNotifications(withIdentifiers: [tag]) }

    // MARK: delegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound, .badge]) // in front too: the PC's worker shows every notice
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo.reduce(into: JSONObject()) { out, pair in if let key = pair.key as? String { out[key] = pair.value } }
        let action = response.actionIdentifier
        DispatchQueue.main.async { [weak self] in self?.notifier?.responded(action: action, userInfo: info); completionHandler() }
    }
}

/// UIApplication's push registration as a PushPlatform (authorization is asked through the notification center).
final class SystemPushPlatform: PushPlatform {
    func authorization(_ done: @escaping (PushAuthorization) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: PushAuthorization
            switch settings.authorizationStatus {
            case .notDetermined: status = .notDetermined
            case .denied: status = .denied
            default: status = .allowed
            }
            DispatchQueue.main.async { done(status) }
        }
    }

    func requestAuthorization(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in DispatchQueue.main.async { done(granted) } }
    }

    func registerForRemoteNotifications() {
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }
}

/// The token goes to the page through the native port (the bridge replays it to every new page); the page forwards it to the PC once the PC has a place for it – the server part is a placeholder.
final class PagePushSink: PushSink {
    private let send: ([String: Any]) -> Void
    init(send: @escaping ([String: Any]) -> Void) { self.send = send }
    func deliver(_ token: PushToken?) throws {
        send(PushToken.message(token)) // the bridge keeps it for the next page too: handed over, not yet taken by the PC
    }
}

/// The app delegate only carries the push token callbacks (SwiftUI has no scene-level twin).
final class AppDelegate: NSObject, UIApplicationDelegate {
    static var onToken: ((Bytes) -> Void)?
    static var onFailure: ((String) -> Void)?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { AppDelegate.onToken?(Bytes(deviceToken)) }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { AppDelegate.onFailure?(error.localizedDescription) }

    /// A remote push while the app runs (APNs, once it exists): `userInfo["autark"]` carries the PC's payload.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        let info = userInfo.reduce(into: JSONObject()) { out, pair in if let key = pair.key as? String { out[key] = pair.value } }
        if let payload = PushPayload(userInfo: info) { AppDelegate.onRemote?(payload) }
        completionHandler(.newData)
    }

    static var onRemote: ((PushPayload) -> Void)?
}
