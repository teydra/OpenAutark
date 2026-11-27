// The Simulator E2E test against the headless PC (real runtime and relay, deterministic fake engine).
// XCTest verifies native pairing. The app's Simulator-only WKWebView probe drives the rendered page:
// native XCTest keyboard synthesis does not reliably target the WebKit composer on this runtime.
// Each screenshot is gated on the app's UI state, and the PC must see a human message and its reply.
// The harness does not send any messages. This test does not verify the native keyboard.
import XCTest

final class AutarkE2EUITests: XCTestCase {
    private var out = ""   // the PC's folder: pc.json, pc.log
    private var shots = "" // where the screenshots go
    private var app: XCUIApplication!
    // MARK: the test

    @MainActor
    func testPairOpenChatSendAndEcho() throws {
        continueAfterFailure = false
        try readConfig()
        let pc = try readPcJson()
        let relay = try XCTUnwrap(pc["relay"] as? String, "pc.json has no relay")
        let remoteId = try XCTUnwrap(pc["remoteId"] as? String, "pc.json has no remoteId")
        let chatId = try XCTUnwrap(pc["chatId"] as? String, "pc.json has no chatId")
        print("AUTARK-E2E PC relay \(relay) remote id \(remoteId) chat \(chatId)")
        let statusFile = shots + "/app-status.json"
        try? FileManager.default.removeItem(atPath: statusFile)
        try? FileManager.default.removeItem(atPath: statusFile + ".go")
        try? FileManager.default.removeItem(atPath: statusFile + ".send")

        addUIInterruptionMonitor(withDescription: "system alerts") { alert in
            for name in ["Allow", "Allow While Using App", "OK"] where alert.buttons[name].exists { alert.buttons[name].tap(); return true }
            return false
        }

        app = XCUIApplication()
        app.launchArguments = ["-AutarkRelay", relay, "-AutarkConnect", remoteId, "-AutarkChat", chatId, "-AutarkE2EStatus", statusFile,
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // 1. pairing: the phone shows the 4-digit code, the PC logged the same one
        let pairCode = app.staticTexts["pair-code"]
        guard require(wait(60) { pairCode.exists && self.digits(pairCode.label).count == 4 }, "the wait screen never showed a 4-digit code") else { return }
        let shown = digits(pairCode.label)
        guard require(wait(60) { self.log().contains("\"event\":\"request\"") }, "no connect request reached the PC") else { return }
        let requested = logEvents("request").last?["code"] as? String
        XCTAssertEqual(requested, shown, "the phone shows code \(shown) but the PC logged \(requested ?? "none")")
        shot("01-koppeln-wartet.png")

        // 2. The PC accepts, and the native app displays the correct phone UI route and composer.
        guard require(wait(90) { !self.logEvents("phone-listed").isEmpty }, "the PC never listed the phone") else { return }
        guard require(wait(90) {
            guard let state = self.status() else { return false }
            return state["atChat"] as? Bool == true && state["composer"] as? Bool == true && state["connectCard"] as? Bool == false
        }, "phone chat not visible on the expected route: \(statusText())") else { return }
        shot("02-verbunden-chat-offen.png")

        // 3. Fill the actual textarea, check the page enabled Send, and capture it BEFORE sending.
        print("AUTARK-E2E input by Simulator WebView DOM, not XCTest keyboard synthesis")
        try Data().write(to: URL(fileURLWithPath: statusFile + ".go"), options: .atomic)
        guard require(wait(30) { self.status()?["sendReady"] as? Bool == true }, "the visible composer does not have Hallo ready to send: \(statusText())") else { return }
        shot("03-hallo-getippt.png")
        try Data().write(to: URL(fileURLWithPath: statusFile + ".send"), options: .atomic)
        guard require(wait(30) { self.status()?["sent"] as? Bool == true }, "the app did not activate Send: \(statusText())") else { return }

        // 4. Check provenance on the PC and that BOTH messages are visible in the phone UI.
        guard require(wait(60) {
            let messages = self.logEvents("message")
            let human = messages.contains { $0["author"] as? String == "human" && $0["body"] as? String == "Hallo" }
            let echo = messages.contains { entry in
                guard entry["author"] as? String == "agent", entry["state"] as? String == "final",
                      let body = entry["body"] as? String else { return false }
                return body.hasPrefix("Echo:") && body.hasSuffix("Hallo")
            }
            return human && echo
        }, "the PC did not receive a human Hallo and produce its Echo") else { return }
        XCTAssertTrue(logEvents("sent").isEmpty, "the PC harness injected a message")
        guard require(wait(60) {
            guard let state = self.status() else { return false }
            return state["atChat"] as? Bool == true && state["halloVisible"] as? Bool == true && state["echoVisible"] as? Bool == true
        }, "both messages must be visible together: \(statusText())") else { return }

        shot("04-chat-antwort.png")
        print("AUTARK-E2E verified both visible messages and PC provenance: \(statusText())")

        // 5. The interface is the app's own: the PC's copy of it was replaced by a marker before the app paired (pc-up.sh,
        //    AUTARK_POISON_UI=1), so a single interface request that had reached the PC would not have shown this chat. The app
        //    answered the page itself.
        let served = status()?["uiServed"] as? Int ?? 0
        XCTAssertGreaterThan(served, 0, "the app answered no interface request itself: \(statusText())")
        XCTAssertEqual(status()?["poisoned"] as? Bool, false, "the PC's marker page reached the phone: \(statusText())")

        // 6. The PC is gone (it and the meeting server stop), the app is quit and started cold: its own interface comes up at once,
        //    without any PC, and shows its connection state itself – no native screen, no "Try again".
        let firstPid = status()?["pid"] as? Int ?? 0
        try Data().write(to: URL(fileURLWithPath: out + "/stop"), options: .atomic)
        guard require(wait(60) { !self.logEvents("stopping").isEmpty }, "the PC did not stop") else { return }
        Thread.sleep(forTimeInterval: 4)
        app.terminate()
        try? FileManager.default.removeItem(atPath: statusFile)
        app.launch()
        guard require(wait(60) {
            guard let state = self.status() else { return false }
            return state["phase"] as? String == "page" && state["rendered"] as? Bool == true && (state["pid"] as? Int ?? 0) != firstPid
        }, "the app's own interface did not come up without a PC after a cold start: \(statusText())") else { return }
        XCTAssertGreaterThan(status()?["uiServed"] as? Int ?? 0, 0, "the cold-started page was not answered by the app: \(statusText())")
        XCTAssertEqual(status()?["poisoned"] as? Bool, false, "the PC's marker page reached the phone: \(statusText())")
        XCTAssertGreaterThan(status()?["textLength"] as? Int ?? 0, 0, "the page is empty: \(statusText())")
        XCTAssertFalse(app.staticTexts["Can't reach"].exists, "a native offline screen covers the page")
        XCTAssertFalse(app.buttons["Try again"].exists, "a native Try-again button covers the page")
        Thread.sleep(forTimeInterval: 3)
        shot("05-pc-weg-eigene-oberflaeche.png")
        print("AUTARK-E2E own interface after the PC was gone and a cold start: \(statusText())")
    }

    // MARK: helpers

    /// A finding that ends the test: recorded as a failure, the caller returns.
    @MainActor private func require(_ ok: Bool, _ message: String) -> Bool {
        if !ok {
            shot("98-fehler.png")
            XCTFail(message)
        }
        return ok
    }

    @MainActor private func readConfig() throws {
        let env = ProcessInfo.processInfo.environment
        var folder = env["AUTARK_E2E_OUT"]
        var target = env["AUTARK_E2E_SHOTS"]
        if folder == nil || target == nil,
           let data = FileManager.default.contents(atPath: "/tmp/autark-e2e-config.json"),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            folder = folder ?? json["out"]
            target = target ?? json["shots"]
        }
        out = try XCTUnwrap(folder, "AUTARK_E2E_OUT is not set (and /tmp/autark-e2e-config.json is missing)")
        shots = try XCTUnwrap(target, "AUTARK_E2E_SHOTS is not set")
        try FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
    }

    @MainActor private func readPcJson() throws -> [String: Any] {
        let data = try XCTUnwrap(FileManager.default.contents(atPath: out + "/pc.json"), "no pc.json in \(out)")
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor private func log() -> String { (try? String(contentsOfFile: out + "/pc.log", encoding: .utf8)) ?? "" }

    @MainActor private func logEvents(_ name: String) -> [[String: Any]] {
        log().split(separator: "\n").compactMap { line in
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], object["event"] as? String == name else { return nil }
            return object
        }
    }

    /// What the app's E2EDriver reported last (nil: no file yet).
    @MainActor private func status() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: shots + "/app-status.json") else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    @MainActor private func statusText() -> String {
        guard let data = FileManager.default.contents(atPath: shots + "/app-status.json"), let text = String(data: data, encoding: .utf8) else { return "no report file" }
        return text
    }

    @MainActor private func digits(_ text: String) -> String { text.filter { $0.isASCII && $0.isNumber } }

    /// Polls `check` twice a second until it is true or the seconds are over.
    @MainActor private func wait(_ seconds: TimeInterval, _ check: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if check() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return check()
    }

    @MainActor private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        do {
            try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: shots + "/" + name), options: .atomic)
        } catch {
            XCTFail("could not write screenshot \(name): \(error)")
        }
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        print("AUTARK-E2E screenshot \(name)")
    }
}
