// Owns: the notification decisions of Core/Notices.swift and the push interface of Core/PushRegistration.swift, as the PC's service worker
// (ui/pwa/sw-notify.ts, due-notice.ts, badge.ts) shows them: the payload and its limits, one notice per tag, a duplicate shown quietly, a
// chat notice's count, the Due notices of to-dos falling together under one tag that closes after 6 s, `clear`, the ring of a call, the
// badge as the sum of open notices, the user info that survives a delivered notification, the buttons of a question and their answers,
// the route a tap takes; and the registration with fakes for Apple and for the server (permission, token, delivery, retry, forgetting).
// Never: a test of UNUserNotificationCenter, APNs or a real device – those need a signed build on a phone (apps/ios/README.md).
import XCTest
@testable import AutarkCore

final class NoticePlanTests: XCTestCase {
    private func shown(_ steps: [NoticeStep]) -> NoticeContent {
        for step in steps { if case .show(let content) = step { return content } }
        XCTFail("no notice shown in \(steps)")
        return NoticeContent(title: "", body: "", tag: nil, url: "/", id: nil, count: nil, ids: [], silent: false, ring: false, due: nil, buttons: [], ask: false, badge: 0)
    }

    private func open(_ content: NoticeContent) -> OpenNotice {
        OpenNotice(tag: content.tag, title: content.title, body: content.body, userInfo: content.userInfo)
    }

    func testThePayloadIsReadWithTheLimitsOfThePc() {
        let json: JSONObject = ["title": String(repeating: "t", count: 200), "body": String(repeating: "b", count: 400), "url": "/#/chat/c1", "tag": "chat:c1", "kind": "reply",
                                "silent": true, "id": "m1", "ring": false, "buttons": ["Yes", "", String(repeating: "x", count: 80), "3", "4", "5"] as [Any], "ask": true]
        let payload = PushPayload(json: json)
        XCTAssertEqual(payload?.title?.count, 120)
        XCTAssertEqual(payload?.body?.count, 240)
        XCTAssertEqual(payload?.url, "/#/chat/c1")
        XCTAssertEqual(payload?.silent, true)
        XCTAssertEqual(payload?.buttons.count, 4, "at most four buttons, empty ones dropped")
        XCTAssertEqual(payload?.buttons[1].count, 40)
        XCTAssertNil(PushPayload(json: [:]))
        XCTAssertEqual(PushPayload(userInfo: ["aps": ["alert": "x"] as JSONObject, "autark": ["title": "Hi", "tag": "t"] as JSONObject])?.title, "Hi", "the PC's payload sits beside Apple's aps")
        XCTAssertEqual(PushPayload(userInfo: ["title": "Flat", "aps": ["alert": "x"] as JSONObject])?.title, "Flat")
        XCTAssertNil(PushPayload(userInfo: ["aps": ["alert": "x"] as JSONObject]))
    }

    func testAPlainNoticeShowsItsTextAndBecomesTheBadge() {
        let content = shown(NoticePlan.plan(PushPayload(title: "Done", body: "Report ready", url: "/#/home", tag: "workforce:done", id: "n1"), open: [], now: 10))
        XCTAssertEqual(content.title, "Done")
        XCTAssertEqual(content.body, "Report ready")
        XCTAssertEqual(content.url, "/#/home")
        XCTAssertEqual(content.badge, 1)
        XCTAssertFalse(content.silent)
        XCTAssertNil(content.count)
        let bare = shown(NoticePlan.plan(PushPayload(), open: [], now: 10))
        XCTAssertEqual(bare.title, "Autark", "a push without a title is Autark's")
        XCTAssertEqual(bare.url, "/")
    }

    func testChatNoticesBundleAndCount() {
        let first = shown(NoticePlan.plan(PushPayload(title: "Anna", body: "one", tag: "chat:c1", id: "m1"), open: [], now: 1))
        XCTAssertNil(first.count)
        let second = shown(NoticePlan.plan(PushPayload(title: "Anna", body: "two", tag: "chat:c1", id: "m2"), open: [open(first)], now: 2))
        XCTAssertEqual(second.count, 2)
        XCTAssertEqual(second.ids, ["m1", "m2"])
        let third = shown(NoticePlan.plan(PushPayload(title: "Anna", body: "three", tag: "chat:c1", id: "m3"), open: [open(second)], now: 3))
        XCTAssertEqual(third.count, 3)
        XCTAssertEqual(third.badge, 3)
        // another chat's notice is another one; the badge counts both
        let other = shown(NoticePlan.plan(PushPayload(title: "Ben", body: "hi", tag: "chat:c2", id: "x1"), open: [open(third)], now: 4))
        XCTAssertNil(other.count)
        XCTAssertEqual(other.badge, 4)
    }

    func testTheSameNoticeAgainReplacesQuietlyAndKeepsTheNewestPreview() {
        let first = shown(NoticePlan.plan(PushPayload(title: "Anna", body: "newest text", url: "/#/chat/c1", tag: "chat:c1", id: "m1"), open: [], now: 1))
        let again = shown(NoticePlan.plan(PushPayload(title: "Anna", body: "an older event", tag: "chat:c1", id: "m1"), open: [open(first)], now: 2))
        XCTAssertTrue(again.silent, "iOS shows it again, without sound")
        XCTAssertEqual(again.body, "newest text")
        XCTAssertEqual(again.url, "/#/chat/c1")
        XCTAssertNil(again.count, "a duplicate does not count twice")
    }

    func testAClearClosesItsTag() {
        XCTAssertEqual(NoticePlan.plan(PushPayload(clear: "chat:c1"), open: [], now: 1), [.close(tag: "chat:c1")])
    }

    func testDueTodosFallTogetherUnderOneTagThatClosesAfterSixSeconds() {
        let due1 = PushPayload(title: "Due: Call the tax office", body: "10:00", tag: "todo:t1", kind: "todo")
        XCTAssertTrue(DueNotice.isDue(due1))
        XCTAssertFalse(DueNotice.isDue(PushPayload(title: "Due: x", kind: "reply")))
        XCTAssertFalse(DueNotice.isDue(PushPayload(title: "Due: x", kind: "todo", clear: "todo:t1")))
        let steps1 = NoticePlan.plan(due1, open: [], now: 100)
        let one = shown(steps1)
        XCTAssertEqual(one.tag, "due")
        XCTAssertEqual(one.title, "Due: Call the tax office", "one to-do keeps its own text")
        XCTAssertEqual(one.url, "/#/day")
        XCTAssertEqual(one.due, DueData(items: ["Call the tax office"], stamp: 100))
        XCTAssertEqual(steps1.last, .closeLater(tag: "due", stamp: 100, afterMs: 6_000))
        let two = shown(NoticePlan.plan(PushPayload(title: "Due: Recording", tag: "todo:t2", kind: "todo"), open: [open(one)], now: 200))
        XCTAssertEqual(two.title, "2 to-dos due")
        XCTAssertEqual(two.body, "Call the tax office · Recording")
        XCTAssertEqual(two.due?.stamp, 200, "each push has its own stamp: the older timer must not close the newer notice")
        let again = shown(NoticePlan.plan(PushPayload(title: "Due: Recording", tag: "todo:t2", kind: "todo"), open: [open(two)], now: 300))
        XCTAssertEqual(again.due?.items, ["Call the tax office", "Recording"], "each title once")
        var current = two
        for n in 3...8 { current = shown(NoticePlan.plan(PushPayload(title: "Due: Task \(n)", kind: "todo"), open: [open(current)], now: Int64(n * 100))) }
        XCTAssertEqual(current.due?.items.count, 5, "the newest five")
        XCTAssertEqual(current.due?.items.last, "Task 8")
        XCTAssertEqual(current.title, "5 to-dos due")
    }

    func testACallRingsUntilTouchedAndIsNotBundled() {
        let ring = shown(NoticePlan.plan(PushPayload(title: "Anna is calling", tag: "chat:c1", id: "call1", ring: true), open: [], now: 1))
        XCTAssertTrue(ring.ring)
        XCTAssertNil(ring.count)
        let duplicate = shown(NoticePlan.plan(PushPayload(title: "Anna is calling", tag: "chat:c1", id: "call1", ring: true), open: [open(ring)], now: 2))
        XCTAssertFalse(duplicate.ring, "a quiet duplicate does not ring again")
    }

    func testTheUserInfoSurvivesADeliveredNotification() {
        let content = shown(NoticePlan.plan(PushPayload(title: "Due: Call", body: "b", kind: "todo", id: "d1", buttons: ["Now", "Later"], ask: true), open: [], now: 42))
        let back = OpenNotice(tag: content.tag, title: content.title, body: content.body, userInfo: content.userInfo)
        XCTAssertEqual(back.tag, "due")
        XCTAssertEqual(back.due, DueData(items: ["Call"], stamp: 42))
        XCTAssertEqual(back.id, "d1")
        XCTAssertEqual(back.url, "/#/day")
        XCTAssertEqual(content.userInfo["buttons"] as? [String], ["Now", "Later"])
        let chat = shown(NoticePlan.plan(PushPayload(title: "A", tag: "chat:c1", id: "m2"), open: [OpenNotice(tag: "chat:c1", title: "A", body: "", id: "m1", count: 3)], now: 1))
        let chatBack = OpenNotice(tag: "chat:c1", title: "A", body: "", userInfo: chat.userInfo)
        XCTAssertEqual(chatBack.count, 4)
        XCTAssertEqual(chatBack.ids, ["m1", "m2"])
        XCTAssertEqual(NoticePlan.badge([chatBack, back]), 5)
    }

    func testTheButtonsOfAQuestionAndTheirAnswers() {
        XCTAssertEqual(NoticeAsk.actions(buttons: []).map { $0.id }, ["yes", "no"])
        XCTAssertEqual(NoticeAsk.actions(buttons: []).map { $0.title }, ["✓", "✕"])
        XCTAssertEqual(NoticeAsk.answer(action: "yes", buttons: []), "yes")
        XCTAssertEqual(NoticeAsk.answer(action: "no", buttons: []), "no")
        XCTAssertNil(NoticeAsk.answer(action: "b0", buttons: []))
        XCTAssertEqual(NoticeAsk.answer(action: "b1", buttons: ["Now", "Later"]), "Later", "the label is the answer")
        XCTAssertNil(NoticeAsk.answer(action: "b2", buttons: ["Now", "Later"]))
        XCTAssertNil(NoticeAsk.answer(action: "yes", buttons: ["Now"]))
        XCTAssertNil(NoticeAsk.answer(action: "bx", buttons: ["Now"]))
        XCTAssertEqual(NoticeAsk.category(buttons: []), "autark.ask")
        XCTAssertEqual(NoticeAsk.category(buttons: ["Now", "Later"]), NoticeAsk.category(buttons: ["Now", "Later"]))
        XCTAssertNotEqual(NoticeAsk.category(buttons: ["Now", "Later"]), NoticeAsk.category(buttons: ["Later", "Now"]))
        XCTAssertTrue(NoticeAsk.category(buttons: ["Now"]).hasPrefix("autark.ask."))
    }

    func testARouteIsOnlyEverAHashRouteOfThePage() {
        XCTAssertEqual(NoticeRoute.hash(of: "/#/chat/c1"), "#/chat/c1")
        XCTAssertEqual(NoticeRoute.hash(of: "/#/day"), "#/day")
        XCTAssertNil(NoticeRoute.hash(of: "/"))
        XCTAssertNil(NoticeRoute.hash(of: nil))
        XCTAssertNil(NoticeRoute.hash(of: "https://evil.example/#javascript:alert(1)"))
        XCTAssertNil(NoticeRoute.hash(of: "/#/chat/\"; alert(1); \""))
        XCTAssertNil(NoticeRoute.hash(of: "/#/../x"))
        XCTAssertNil(NoticeRoute.hash(of: "/#/" + String(repeating: "a", count: 300)))
    }
}

private final class FakePlatform: PushPlatform {
    var status: PushAuthorization = .notDetermined
    var grants = true
    private(set) var requests = 0
    private(set) var registrations = 0
    func authorization(_ done: @escaping (PushAuthorization) -> Void) { done(status) }
    func requestAuthorization(_ done: @escaping (Bool) -> Void) { requests += 1; done(grants); if grants { status = .allowed } else { status = .denied } }
    func registerForRemoteNotifications() { registrations += 1 }
}

private final class FakeSink: PushSink {
    var failing = false
    private(set) var delivered = [PushToken?]()
    func deliver(_ token: PushToken?) throws {
        if failing { throw AutarkError("The page is not ready.") }
        delivered.append(token)
    }
}

final class PushRegistrationTests: XCTestCase {
    private func registration(_ platform: FakePlatform, _ sink: FakeSink, store: StringStore = MemoryStore(), enabled: Bool = true) -> PushRegistration {
        PushRegistration(platform: platform, sink: sink, store: store, bundleId: "com.teydralab.autark", environment: .sandbox, enabled: enabled)
    }

    func testABuildWithoutPushAsksNothingAndRegistersNothing() {
        let platform = FakePlatform(), sink = FakeSink()
        let push = registration(platform, sink, enabled: false)
        XCTAssertEqual(push.state, .off)
        push.enable()
        XCTAssertEqual(push.state, .off)
        XCTAssertEqual(platform.requests, 0)
        XCTAssertEqual(platform.registrations, 0)
        push.didRegister(deviceToken: [1, 2, 3])
        XCTAssertNil(push.currentToken, "a token nobody asked for is not kept")
        XCTAssertTrue(sink.delivered.isEmpty)
    }

    func testPermissionThenTokenThenDelivery() {
        let platform = FakePlatform(), sink = FakeSink(), store = MemoryStore()
        let push = registration(platform, sink, store: store)
        XCTAssertEqual(push.state, .needsAuthorization)
        push.enable()
        XCTAssertEqual(platform.requests, 1)
        XCTAssertEqual(platform.registrations, 1)
        XCTAssertEqual(push.state, .waitingForToken)
        push.didRegister(deviceToken: [0xAB, 0xCD, 0x01])
        XCTAssertEqual(push.state, .registered)
        XCTAssertEqual(sink.delivered, [PushToken(token: "abcd01", environment: .sandbox, bundleId: "com.teydralab.autark")])
        XCTAssertTrue(push.isDelivered)
        XCTAssertTrue(store.get("push.token")?.contains("abcd01") == true)
        push.didRegister(deviceToken: [0xAB, 0xCD, 0x01]) // the same token again (iOS repeats it at every launch)
        XCTAssertEqual(sink.delivered.count, 1, "a token the sink took is not sent twice")
        push.didRegister(deviceToken: [0xAB, 0xCD, 0x02])
        XCTAssertEqual(sink.delivered.count, 2, "a new token goes out again")
        // asking again once allowed does not ask the person again
        push.enable()
        XCTAssertEqual(platform.requests, 1)
        XCTAssertEqual(platform.registrations, 2)
    }

    func testRefusedPermissionRegistersNothing() {
        let platform = FakePlatform(), sink = FakeSink()
        platform.grants = false
        let push = registration(platform, sink)
        push.enable()
        XCTAssertEqual(push.state, .denied)
        XCTAssertEqual(platform.registrations, 0)
        let blocked = FakePlatform()
        blocked.status = .denied
        let again = registration(blocked, sink)
        again.enable()
        XCTAssertEqual(again.state, .denied)
        XCTAssertEqual(blocked.requests, 0, "the person said no in Settings: no second prompt")
    }

    func testAServerThatCannotTakeTheTokenYetGetsItLater() {
        let platform = FakePlatform(), sink = FakeSink(), store = MemoryStore()
        sink.failing = true
        let push = registration(platform, sink, store: store)
        push.enable()
        push.didRegister(deviceToken: [9, 9])
        XCTAssertEqual(push.state, .registered)
        XCTAssertFalse(push.isDelivered)
        XCTAssertFalse(push.deliverPending())
        // the app is restarted: the kept token is still waiting to be delivered
        sink.failing = false
        let restarted = registration(platform, sink, store: store)
        XCTAssertEqual(restarted.currentToken?.token, "0909")
        XCTAssertFalse(restarted.isDelivered)
        XCTAssertTrue(restarted.deliverPending())
        XCTAssertEqual(sink.delivered.count, 1)
        XCTAssertTrue(restarted.isDelivered)
        XCTAssertTrue(restarted.deliverPending(), "nothing left to deliver")
        XCTAssertEqual(sink.delivered.count, 1)
    }

    func testForgettingThePhoneTellsTheSinkAndClearsTheToken() {
        let platform = FakePlatform(), sink = FakeSink(), store = MemoryStore()
        let push = registration(platform, sink, store: store)
        push.enable()
        push.didRegister(deviceToken: [1])
        push.forget()
        XCTAssertNil(push.currentToken)
        XCTAssertNil(store.get("push.token"))
        XCTAssertEqual(sink.delivered.count, 2)
        XCTAssertNil(sink.delivered[1] ?? nil, "the sink heard there is no token any more")
        XCTAssertEqual(push.state, .needsAuthorization)
    }

    func testAFailedRegistrationIsShown() {
        let platform = FakePlatform(), sink = FakeSink()
        let push = registration(platform, sink)
        push.enable()
        push.didFail("no valid 'aps-environment' entitlement")
        XCTAssertEqual(push.state, .failed("no valid 'aps-environment' entitlement"))
    }

    func testTheMessageToThePage() {
        let token = PushToken(token: "abcd01", environment: .production, bundleId: "com.teydralab.autark")
        XCTAssertEqual(Json.write(PushToken.message(token)), "{\"bundle\":\"com.teydralab.autark\",\"env\":\"production\",\"platform\":\"apns\",\"t\":\"push.token\",\"token\":\"abcd01\"}")
        XCTAssertEqual(Json.write(PushToken.message(nil)), "{\"platform\":\"apns\",\"t\":\"push.token\",\"token\":null}")
        XCTAssertEqual(PushToken.hex([0, 255, 16]), "00ff10")
    }
}
