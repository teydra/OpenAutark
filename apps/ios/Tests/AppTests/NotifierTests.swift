// Owns: the app's notification scaffold on a simulator with a fake notification center (the real UNUserNotificationCenter needs the
// app's own process and the person's permission, which a unit-test process has neither): the notifier reads the open notices, runs
// Core's plan and applies its steps – a notice per tag replaces the older one and bundles the chat count, a Due notice closes itself
// when its own timer ends and never because of an older timer, `clear` closes a tag – and turns a tap or a button into the page's
// route or the answer of a question. A real notice on a real phone, APNs and the lock screen are not involved.
import XCTest
import UserNotifications
@testable import Autark
@testable import AutarkCore

private final class FakeCenter: NoticeCenter {
    private let lock = NSLock()
    private var openList = [OpenNotice]()
    private var shownList = [NoticeContent]()
    private var closedList = [String]()
    private var asked = 0

    var shown: [NoticeContent] { lock.lock(); defer { lock.unlock() }; return shownList }
    var closed: [String] { lock.lock(); defer { lock.unlock() }; return closedList }
    var authorizations: Int { lock.lock(); defer { lock.unlock() }; return asked }

    func openNotices(_ done: @escaping ([OpenNotice]) -> Void) { lock.lock(); let current = openList; lock.unlock(); done(current) }

    func requestAuthorization(_ done: @escaping (Bool) -> Void) { lock.lock(); asked += 1; lock.unlock(); done(true) }

    func show(_ content: NoticeContent) {
        lock.lock()
        shownList.append(content)
        if let tag = content.tag { openList.removeAll { $0.tag == tag } } // the same identifier replaces the notice open under it
        openList.append(OpenNotice(tag: content.tag, title: content.title, body: content.body, userInfo: content.userInfo))
        lock.unlock()
    }

    func close(tag: String) { lock.lock(); closedList.append(tag); openList.removeAll { $0.tag == tag }; lock.unlock() }
}

final class NotifierTests: XCTestCase {
    private func wait(_ what: String, seconds: Double = 5, _ condition: () -> Bool) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { if condition() { return }; Thread.sleep(forTimeInterval: 0.02) }
        XCTFail("timed out waiting for \(what)")
    }

    func testANoticePerTagReplacesTheOlderAndChatsCount() {
        let center = FakeCenter()
        let notifier = Notifier(center: center)
        notifier.receive(PushPayload(title: "Anna", body: "one", url: "/#/chat/c1", tag: "chat:c1", id: "m1"))
        wait("first notice") { center.shown.count == 1 }
        notifier.receive(PushPayload(title: "Anna", body: "two", url: "/#/chat/c1", tag: "chat:c1", id: "m2"))
        wait("second notice") { center.shown.count == 2 }
        XCTAssertNil(center.shown[0].count)
        XCTAssertEqual(center.shown[1].count, 2, "the second message of a chat is counted with the first")
        XCTAssertEqual(center.shown[1].badge, 2)
        XCTAssertEqual(center.shown[1].url, "/#/chat/c1")
    }

    func testAClearClosesItsTag() {
        let center = FakeCenter()
        let notifier = Notifier(center: center)
        notifier.receive(PushPayload(title: "Anna", tag: "chat:c1", id: "m1"))
        wait("notice shown") { center.shown.count == 1 }
        notifier.receive(PushPayload(clear: "chat:c1"))
        wait("tag closed") { center.closed == ["chat:c1"] }
    }

    func testADueNoticeClosesWhenItsOwnTimerEndsAndNotWhenAnOlderOneDoes() {
        let center = FakeCenter()
        let notifier = Notifier(center: center)
        let due = NoticeContent(title: "Due: Call", body: "", tag: "due", url: "/#/day", id: nil, count: nil, ids: [], silent: false, ring: false,
                                due: DueData(items: ["Call"], stamp: 5), buttons: [], ask: false, badge: 1)
        notifier.apply([.show(due), .closeLater(tag: "due", stamp: 4, afterMs: 50)]) // the timer of an older Due notice
        Thread.sleep(forTimeInterval: 0.4)
        XCTAssertTrue(center.closed.isEmpty, "a newer Due notice has its own timer")
        notifier.apply([.closeLater(tag: "due", stamp: 5, afterMs: 50)])
        wait("closed by its own timer") { center.closed == ["due"] }
    }

    func testATapOpensTheRouteAndAButtonAnswersTheQuestion() {
        let notifier = Notifier(center: FakeCenter())
        var opened = [String](), answers = [String]()
        notifier.onOpen = { opened.append($0) }
        notifier.onAnswer = { id, answer in answers.append("\(id ?? "-")=\(answer)") }
        notifier.responded(action: UNNotificationDefaultActionIdentifier, userInfo: ["url": "/#/chat/c1"])
        notifier.responded(action: UNNotificationDismissActionIdentifier, userInfo: ["url": "/#/chat/c1"])
        XCTAssertEqual(opened, ["/#/chat/c1"], "a dismissal opens nothing")
        notifier.responded(action: "yes", userInfo: ["id": "q1", "ask": true])
        notifier.responded(action: "no", userInfo: ["id": "q1", "ask": true])
        notifier.responded(action: "b1", userInfo: ["id": "q2", "buttons": ["Now", "Later"]])
        notifier.responded(action: "b5", userInfo: ["id": "q2", "buttons": ["Now", "Later"]])
        notifier.responded(action: "yes", userInfo: ["id": "q3", "buttons": ["Now"]])
        XCTAssertEqual(answers, ["q1=yes", "q1=no", "q2=Later"], "only this question's own buttons answer it")
    }

    func testAskingForPermissionIsAnExplicitStep() {
        let center = FakeCenter()
        let notifier = Notifier(center: center)
        XCTAssertEqual(center.authorizations, 0, "nothing is asked until the person agrees")
        var granted: Bool?
        notifier.requestAuthorization { granted = $0 }
        XCTAssertEqual(granted, true)
        XCTAssertEqual(center.authorizations, 1)
    }
}
