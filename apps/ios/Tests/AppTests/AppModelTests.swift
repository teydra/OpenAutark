// Owns: the app's own logic on a simulator with the meeting server and the PC as in-process stand-ins (TestSupport) – the levels
// of the connect flow, the pairing from typing the nine digits to the PC's page in the web view, restarting with a stored pairing,
// pair links, a foreign QR code, forgetting a company – and the keychain store. A real PC, the real meeting server, the camera and
// a real phone are not involved.
import XCTest
import SwiftUI
@testable import Autark
@testable import AutarkCore

@MainActor
final class AppModelTests: XCTestCase {
    private func waitFor(_ what: String, seconds: Double = 20, _ condition: () -> Bool) async {
        await waitForDetailed(what, seconds: seconds, detail: nil, condition)
    }

    /// Like waitFor; a timeout says where things stood (the CI log is all there is to go by).
    private func waitForDetailed(_ what: String, seconds: Double, detail: (() -> String)?, _ condition: () -> Bool) async {
        let start = Date()
        let end = start.addingTimeInterval(seconds)
        while Date() < end {
            if condition() { NSLog("AUTARKTEST %@ after %.1f s", what, Date().timeIntervalSince(start)); return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("timed out waiting for \(what)" + (detail.map { " – " + $0() } ?? ""))
    }

    private func world() -> (relay: FakeRelay, pc: FakeRelay.Pc) {
        let relay = FakeRelay()
        let pc = FakeRelay.Pc(seed: Bytes(repeating: 0x22, count: 32))
        relay.addPc(pc)
        relay.streamVersion = "0.9.9"
        return (relay, pc)
    }

    func testStartsOnTheConnectLevelAndChecksTheDigits() {
        let model = AppModel(store: MemoryStore(), connector: FakeRelay())
        model.start(arguments: [])
        XCTAssertEqual(model.screen, .start)
        model.showCode()
        XCTAssertEqual(model.screen, .code)
        model.typed = "123"
        model.connectTyped()
        XCTAssertEqual(model.screen, .code)
        XCTAssertTrue(model.message.contains("nine digits"), model.message)
        model.backFromLevel()
        XCTAssertEqual(model.screen, .start)
        model.showScanner()
        XCTAssertEqual(model.screen, .scan)
        XCTAssertFalse(model.scanned("https://example.com/not-autark"))
        XCTAssertEqual(model.message, "That QR code is not from Autark.")
        model.backFromLevel()
        XCTAssertEqual(model.screen, .start)
    }

    func testPairLinksFillTheCodeLevel() {
        let model = AppModel(store: MemoryStore(), connector: FakeRelay())
        model.start(arguments: [])
        model.openLink(URL(string: "autark://pair/482913071")!)
        XCTAssertEqual(model.screen, .code)
        XCTAssertEqual(model.typed, "482913071")
        model.backFromLevel()
        model.openLink(URL(string: "https://openautark.com/pair/#552774309")!)
        XCTAssertEqual(model.typed, "552774309")
        model.backFromLevel()
        model.openLink(URL(string: "https://evil.example/pair/#552774309")!)
        XCTAssertEqual(model.screen, .start, "a foreign link does nothing")
    }

    func testAShotLinkAsksBeforeItSends() {
        let model = AppModel(store: MemoryStore(), connector: FakeRelay())
        model.start(arguments: [])
        XCTAssertFalse(model.confirmShot)
        model.openLink(URL(string: "autark://shot")!)
        XCTAssertTrue(model.confirmShot, "any app or page can open the link: it asks, it never sends a screenshot by itself")
    }

    func testLaunchArgumentsOpenAFixedLevelForTheScreenshots() {
        let model = AppModel(store: MemoryStore(), connector: FakeRelay())
        model.start(arguments: ["-AutarkScreen", "code", "-AutarkPrefill", "482913071"])
        XCTAssertEqual(model.screen, .code)
        XCTAssertEqual(model.typed, "482913071")
    }

    /// An interface of the app's own (a bundle folder with one page) – what the build's `ui` folder is in the app; no look for a newer one.
    private func ownUi() throws -> PhoneUi {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("autark-test-ui-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "<!doctype html><html><head><title>Autark</title></head><body>Autark phone UI from the app</body></html>"
            .write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        return PhoneUi(shipped: BundleUi(root: root), dir: root.appendingPathComponent("fetched"), keys: [])
    }

    func testTypingTheNineDigitsPairsAndOpensThePcsPageAndASecondLaunchGoesStraightThere() async throws {
        let w = world()
        let store = MemoryStore()
        let ui = try ownUi()
        let model = AppModel(store: store, connector: w.relay, ui: ui)
        model.start(arguments: [])
        model.showCode()
        model.typed = w.pc.remoteId
        model.connectTyped()
        XCTAssertEqual(model.screen, .waiting)
        await waitFor("the code to show") { model.waiting.code != nil }
        XCTAssertEqual(model.waiting.code, w.pc.remote.code, "the phone shows the code the PC shows")
        XCTAssertTrue(model.waiting.line.contains("Studio PC"), model.waiting.line)

        // the person accepts on the PC (which pins the phone at the meeting server); the page of the PC arrives through the entrance
        w.pc.remote.decision.complete(true)
        await waitFor("the page level") { model.screen == .page }
        XCTAssertNotNil(store.get("list"))
        XCTAssertFalse((store.get("gate") ?? "").isEmpty)
        await waitForDetailed("the PC's page in the web view", seconds: 30, detail: { "screen \(model.screen), connected \(model.connected), line '\(model.connectionLine)', offline \(model.offline ?? "-"), url \(model.bridge.webView.url?.absoluteString ?? "nil"), loading \(model.bridge.webView.isLoading)" }) { model.connected && model.bridge.webView.url?.absoluteString.hasPrefix("http://127.0.0.1:") == true && !model.bridge.webView.isLoading }
        let body = try await model.bridge.webView.evaluateJavaScript("document.body.innerText") as? String
        XCTAssertTrue(body?.contains("Autark phone UI from the app") == true, "the page is the app's own, not the PC's: " + (body ?? "nil"))
        XCTAssertGreaterThan(ui.files.served, 0)
        XCTAssertEqual(model.connectionLine, "Connected to Studio PC.")
        // the page was told whose offline data it may show: this company and this PC, no secret in it
        let ownerText = try XCTUnwrap(model.bridge.lastOwnerText)
        let owner = try XCTUnwrap(try Json.object(ownerText)["owner"] as? JSONObject)
        XCTAssertEqual(Json.str(owner, "companyId"), "c1")
        XCTAssertEqual(Json.str(owner, "pcFingerprint"), w.pc.fingerprint)
        XCTAssertNil(ownerText.range(of: "token"))
        XCTAssertNil(ownerText.range(of: "seed"))

        // a second launch with the stored pairing opens the page without asking again
        let again = AppModel(store: store, connector: w.relay, ui: ui)
        again.start(arguments: [])
        XCTAssertEqual(again.screen, .page)

        // forgetting the company ends it: its keys are gone and the connect level is back
        again.forgetCurrent()
        XCTAssertEqual(again.screen, .start)
        XCTAssertEqual(again.bridge.lastOwnerText, "{\"owner\":null,\"t\":\"offline.owner\"}", "forgetting leaves no owner")
        let third = AppModel(store: store, connector: w.relay, ui: ui)
        third.start(arguments: [])
        XCTAssertEqual(third.screen, .start)
        model.forgetCurrent()
    }

    func testCancellingTheWaitReturnsToTheLevelItCameFrom() async throws {
        let w = world()
        let model = AppModel(store: MemoryStore(), connector: w.relay)
        model.start(arguments: [])
        model.showCode()
        model.typed = w.pc.remoteId
        model.connectTyped()
        await waitFor("the code") { model.waiting.code != nil }
        model.backFromLevel()
        XCTAssertEqual(model.screen, .code)
    }

    func testAPcThatDeclinesLeavesTheReasonOnTheLevel() async throws {
        let w = world()
        let model = AppModel(store: MemoryStore(), connector: w.relay)
        model.start(arguments: [])
        model.showCode()
        model.typed = w.pc.remoteId
        model.connectTyped()
        await waitFor("the code") { model.waiting.code != nil }
        w.pc.remote.decision.complete(false)
        await waitFor("back on the code level") { model.screen == .code }
        XCTAssertEqual(model.message, "The person declined on the PC.")
    }
}

final class KeychainStoreTests: XCTestCase {
    func testPutGetAndRemove() {
        let store = KeychainStore(service: "com.teydralab.autark.tests.\(UUID().uuidString)")
        XCTAssertNil(store.get("k"))
        store.put("k", "one")
        XCTAssertEqual(store.get("k"), "one")
        store.put("k", "two ü 😀")
        XCTAssertEqual(store.get("k"), "two ü 😀")
        store.put("k", nil)
        XCTAssertNil(store.get("k"))
    }

    func testBigValuesLikeACompanyListWithPictures() {
        let store = KeychainStore(service: "com.teydralab.autark.tests.\(UUID().uuidString)")
        let big = String(repeating: "x", count: 60_000)
        store.put("list", big)
        XCTAssertEqual(store.get("list")?.count, 60_000)
        store.put("list", nil)
    }
}
