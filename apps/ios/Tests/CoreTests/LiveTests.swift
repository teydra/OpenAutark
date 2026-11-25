// Wave 2 (21.11.2026): the Live Activity's content (LiveState), Android's phone-use rules (UseState, SayChoices), the responder that
// answers say/done and turns the person's buttons into phoneUse.control, the app's own socket (UseLink) against a fake PC, the
// Live Activity token report (phone.liveToken), and the quick sends (chats.list, files.upload/uploadChunk, messages.send, the share
// inbox). Everything runs on Linux too.
import XCTest
@testable import AutarkCore

// MARK: fakes

/// A clock and a timer the test moves by hand.
final class ManualTime {
    var now: Int64 = 1_766_345_678_901
    private var timers = [(at: Int64, work: () -> Void)]()

    func after(_ ms: Int, _ work: @escaping () -> Void) { timers.append((now + Int64(ms), work)) }

    func advance(_ ms: Int64) {
        now += ms
        let due = timers.filter { $0.at <= now }
        timers.removeAll { $0.at <= now }
        for timer in due { timer.work() }
    }
}

/// The PC's end of the app's /ws socket: records every frame, answers by method.
final class FakeUsePc: WebSocketConnector {
    let lock = NSLock()
    var urls = [String]()
    var headers = [[String: String]]()
    var sockets = [FakeUseSocket]()
    var refuse = false
    var results = [String: Any]()
    var errors = [String: String]()
    var silent = Set<String>()
    let frames = BlockingQueue<JSONObject>()

    func connect(url: String, listener: WebSocketListener) throws -> WebSocketLink { try connect(url: url, listener: listener, options: .relay) }

    func connect(url: String, listener: WebSocketListener, options: WebSocketOptions) throws -> WebSocketLink {
        lock.lock(); defer { lock.unlock() }
        if refuse { throw AutarkError("refused") }
        urls.append(url)
        headers.append(options.headers)
        let socket = FakeUseSocket(pc: self, listener: listener)
        sockets.append(socket)
        return socket
    }

    var last: FakeUseSocket? { lock.lock(); defer { lock.unlock() }; return sockets.last }

    /// The next frame whose method is `method` (others are skipped), within 5 s.
    func next(_ method: String) -> JSONObject? {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            guard let frame = frames.poll(timeout: 0.5) else { continue }
            if Json.str(frame, "method") == method { return frame }
        }
        return nil
    }

    func reply(to frame: JSONObject) -> JSONObject? {
        guard let method = Json.str(frame, "method") else { return nil }
        let id = Json.num(frame, "id", -1)
        lock.lock(); defer { lock.unlock() }
        if silent.contains(method) { return nil }
        if let message = errors[method] { return ["id": id, "error": ["code": "bad_request", "message": message] as JSONObject] }
        if let result = results[method] { return ["id": id, "result": result] }
        switch method {
        case "phoneUse.attach": return ["id": id, "result": ["pcs": [] as [Any]] as JSONObject]
        default: return ["id": id, "result": ["ok": true] as JSONObject]
        }
    }
}

final class FakeUseSocket: WebSocketLink {
    private weak var pc: FakeUsePc?
    private let listener: WebSocketListener
    private let queue = DispatchQueue(label: "fake-use-socket")
    private let lock = NSLock()
    private var closedFlag = false
    private var count = 0

    init(pc: FakeUsePc, listener: WebSocketListener) { self.pc = pc; self.listener = listener }

    func start() {}
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closedFlag }
    var lastFrameAt: TimeInterval { Date().timeIntervalSince1970 }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return count }

    func sendText(_ text: String) throws {
        if isClosed { throw AutarkError("closed") }
        guard let frame = try? Json.object(text), let pc = pc else { return }
        pc.frames.offer(frame)
        if let answer = pc.reply(to: frame) { deliver(answer) }
    }

    func sendBinary(_ data: Bytes) throws {}
    func ping() throws {}

    func deliver(_ frame: JSONObject) {
        let text = Json.write(frame)
        queue.async { [self] in if !self.isClosed { self.listener.text(text) } }
    }

    func event(_ name: String, _ data: JSONObject) { deliver(["event": name, "data": data]) }

    func close() {
        lock.lock(); let was = closedFlag; closedFlag = true; lock.unlock()
        if !was { queue.async { [self] in self.listener.closed("closed") } }
    }

    func kill() { close() }
}

/// A RpcCaller that answers from a table and records the calls.
final class FakeCaller: RpcCaller {
    var calls = [(String, JSONObject)]()
    var answers = [String: Any]()
    var failOn: String?

    func request(_ method: String, _ params: JSONObject, timeoutMs: Int) throws -> Any? {
        calls.append((method, params))
        if method == failOn { throw AutarkError("refused") }
        if method == "files.upload" { return ["id": "f\(calls.count)", "name": Json.str(params, "name") ?? "", "mime": Json.str(params, "mime") ?? "", "size": 3, "width": 10, "height": 20] as JSONObject }
        if method == "files.uploadChunk" {
            return params["final"] as? Bool == true ? ["received": 1, "file": ["id": "big", "name": "big.png", "mime": "image/png", "size": 5_000_000] as JSONObject] as JSONObject : ["received": 1] as JSONObject
        }
        return answers[method] ?? ["id": "m1"] as JSONObject
    }
}

final class LiveTests: XCTestCase {
    // MARK: LiveState

    func testLiveStateWritesTheContractKeys() throws {
        let state = LiveState(job: "run_1", by: "Juri", line: "Opening Settings", ask: true, buttons: ["Ja", "Später"], state: .asking, at: 1_766_345_678_901)
        let data = try JSONEncoder().encode(state)
        let object = try Json.object(String(decoding: data, as: UTF8.self))
        XCTAssertEqual(Set(object.keys), ["job", "by", "line", "ask", "buttons", "state", "at"])
        XCTAssertEqual(Json.str(object, "state"), "asking")
        XCTAssertEqual(object["at"] as? Double, 1_766_345_678_901)
        XCTAssertEqual(try JSONDecoder().decode(LiveState.self, from: data), state)
        XCTAssertEqual(LiveState.from(state.json), state)
        XCTAssertEqual(Json.write(state.json), #"{"ask":true,"at":1766345678901,"buttons":["Ja","Später"],"by":"Juri","job":"run_1","line":"Opening Settings","state":"asking"}"#)
    }

    func testLiveStateReadsAPartialPushAndKeepsTheLimits() throws {
        let partial = try JSONDecoder().decode(LiveState.self, from: Data(#"{"line":"  hi\n there ","state":"weird","at":12.0}"#.utf8))
        XCTAssertEqual(partial.line, "hi there")
        XCTAssertEqual(partial.state, .working)
        XCTAssertEqual(partial.at, 12)
        XCTAssertEqual(partial.buttons, [])
        XCTAssertFalse(partial.ask)
        let long = LiveState(job: String(repeating: "j", count: 80), by: String(repeating: "b", count: 70), line: String(repeating: "x", count: 200),
                             buttons: (1...12).map { "button \($0) " + String(repeating: "y", count: 50) }, state: .working, at: 0)
        XCTAssertEqual(long.job.count, 64)
        XCTAssertEqual(long.by.count, 60)
        XCTAssertEqual(long.line.count, 120)
        XCTAssertTrue(long.line.hasSuffix("…"))
        XCTAssertEqual(long.buttons.count, 8)
        XCTAssertTrue(long.buttons.allSatisfy { $0.count == 40 && $0.hasSuffix("…") })
        XCTAssertEqual(long.headline, String(repeating: "b", count: 59) + "… is using this phone")
        XCTAssertEqual(LiveState(job: "", by: "", line: "", state: .paused, at: 0).headline, "Autark is using this phone")
        XCTAssertTrue(LiveState(job: "", by: "", line: "", state: .paused, at: 0).controls)
        XCTAssertFalse(LiveState(job: "", by: "", line: "", state: .asking, at: 0).controls)
    }

    // MARK: Android's rules

    func testSayChoicesAreAndroids() {
        XCTAssertEqual(SayChoices.of(nil, ask: true), ["✓"])
        XCTAssertEqual(SayChoices.of(nil, ask: false), [])
        XCTAssertEqual(SayChoices.of(["  Ja ", "✕", "Ja", "Nein  bitte", 3] as [Any], ask: false), ["Ja", "Nein bitte"])
        XCTAssertEqual(SayChoices.of(["✕"] as [Any], ask: true), [])
        XCTAssertTrue(SayChoices.asks(["✕"] as [Any], ask: false))
        XCTAssertFalse(SayChoices.asks([] as [Any], ask: false))
        XCTAssertEqual(SayChoices.of((1...10).map { "b\($0)" } as [Any], ask: false).count, 8)
        XCTAssertEqual(SayChoices.answer("✓"), "yes")
        XCTAssertEqual(SayChoices.answer("✕"), "no")
        XCTAssertEqual(SayChoices.answer("Später"), "Später")
    }

    func testUseStatePauseEndAndAgree() {
        let rules = UseState()
        XCTAssertNil(rules.step("a", now: 0))
        XCTAssertTrue(rules.pause())
        XCTAssertEqual(rules.step("a", now: 1)?.code, "paused")
        XCTAssertTrue(rules.resume())
        XCTAssertNil(rules.step("a", now: 2))
        XCTAssertTrue(rules.end())
        XCTAssertEqual(rules.step("a", now: 3)?.code, "ended")
        XCTAssertNil(rules.step("b", now: 4), "a new job runs after the Stop of the one before")
        XCTAssertEqual(rules.step("a", now: 5)?.code, "ended", "the ended job stays refused")
        rules.agreed("a", now: 6)
        XCTAssertNil(rules.step("a", now: 7), "✓ to its question gives the job back")
        XCTAssertEqual(UseState.ended, "The person ended my phone use for this task with ✕; this step did not run, and the phone stays theirs for this task. I finish it another way, or tell them in the chat what is left on the phone.")
    }

    // MARK: the responder

    private func responder(_ time: ManualTime) -> (PhoneUseResponder, Locked<[JSONObject]>, Locked<[JSONObject]>, Locked<[LiveState]>) {
        let replies = Locked<[JSONObject]>([])
        let controls = Locked<[JSONObject]>([])
        let shown = Locked<[LiveState]>([])
        let r = PhoneUseResponder(now: { time.now }, after: { ms, work in time.after(ms, work) })
        r.onReply = { reply in replies.with { $0.append(reply) } }
        r.onControl = { params in controls.with { $0.append(params) } }
        r.onShow = { state in shown.with { $0.append(state) } }
        return (r, replies, controls, shown)
    }

    private func say(_ id: String, _ text: String, job: String = "run_1", ask: Bool = false, buttons: [String]? = nil) -> PhoneUseResponder.Request {
        var args: JSONObject = ["text": text]
        if ask { args["ask"] = true }
        if let buttons = buttons { args["buttons"] = buttons as [Any] }
        return PhoneUseResponder.Request(id: id, op: "say", args: args, job: job, by: "Juri")
    }

    func testALineAnswersOkAndShowsWorking() {
        let time = ManualTime()
        let (r, replies, _, shown) = responder(time)
        r.handle(say("1", "Opening   Settings\n"))
        XCTAssertEqual(Json.write(replies.value.first), #"{"id":"1","result":{"ok":true}}"#)
        XCTAssertEqual(shown.value.last, LiveState(job: "run_1", by: "Juri", line: "Opening Settings", state: .working, at: time.now))
        XCTAssertEqual(r.current?.headline, "Juri is using this phone")
    }

    func testAQuestionWaitsForATapAndHoldsTheNextSteps() {
        let time = ManualTime()
        let (r, replies, _, shown) = responder(time)
        r.handle(say("1", "Darf ich die Mail senden?", ask: true))
        XCTAssertEqual(shown.value.last?.state, .asking)
        XCTAssertEqual(shown.value.last?.buttons, ["✓"])
        r.handle(say("2", "Sending"))
        r.handle(PhoneUseResponder.Request(id: "3", op: "tap", job: "run_1"))
        XCTAssertTrue(replies.value.isEmpty, "the question holds the steps after it")
        XCTAssertFalse(r.answer(job: "other", label: "✓"), "a tap on another job's activity does nothing")
        XCTAssertFalse(r.answer(job: "run_1", label: "Später"), "a label the question does not carry does nothing")
        XCTAssertTrue(r.answer(job: "run_1", label: "✓"))
        XCTAssertEqual(replies.value.map { Json.write($0) }, [
            #"{"id":"1","result":{"answer":"yes"}}"#,
            #"{"id":"2","result":{"ok":true}}"#,
            #"{"error":{"code":"bad_request","message":"Unknown step tap."},"id":"3"}"#,
        ])
        XCTAssertEqual(shown.value.last?.state, .working)
        XCTAssertEqual(shown.value.last?.line, "Sending")
        XCTAssertFalse(r.answer(job: "run_1", label: "✓"), "one answer per question")
    }

    func testOwnButtonsAndNoAndNone() {
        let time = ManualTime()
        let (r, replies, _, shown) = responder(time)
        r.handle(say("1", "Welche?", buttons: ["Morgen", "✕", "Heute"]))
        XCTAssertEqual(shown.value.last?.buttons, ["Morgen", "Heute"])
        XCTAssertTrue(r.answer(job: "run_1", label: "Heute"))
        r.handle(say("2", "Sicher?", ask: true))
        XCTAssertTrue(r.answer(job: "run_1", label: "✕"))
        r.handle(say("3", "Noch da?", ask: true))
        time.advance(59_999)
        XCTAssertEqual(replies.value.count, 2)
        time.advance(1)
        XCTAssertEqual(replies.value.map { Json.write($0) }, [
            #"{"id":"1","result":{"answer":"Heute"}}"#,
            #"{"id":"2","result":{"answer":"no"}}"#,
            #"{"id":"3","result":{"answer":"none"}}"#,
        ])
        XCTAssertEqual(shown.value.last?.state, .working)
        XCTAssertEqual(shown.value.last?.line, "Noch da?")
        XCTAssertFalse(shown.value.last?.ask ?? true)
    }

    func testPauseContinueAndStopGoToThePc() {
        let time = ManualTime()
        let (r, replies, controls, shown) = responder(time)
        XCTAssertFalse(r.pause(job: "run_1"), "no activity yet")
        r.handle(say("1", "Working"))
        XCTAssertTrue(r.pause(job: "run_1"))
        XCTAssertEqual(shown.value.last?.state, .paused)
        XCTAssertFalse(r.pause(job: "run_1"), "already paused")
        r.handle(say("2", "Still here"))
        XCTAssertEqual(Json.write(replies.value.last), #"{"id":"2","result":{"ok":true}}"#, "a plain line shows while paused (Android)")
        XCTAssertEqual(shown.value.last?.state, .paused)
        XCTAssertTrue(r.resume(job: "run_1"))
        XCTAssertEqual(shown.value.last?.state, .working)
        r.handle(say("3", "Darf ich?", ask: true))
        r.handle(say("4", "queued"))
        XCTAssertTrue(r.stop(job: "run_1"))
        XCTAssertEqual(controls.value.map { Json.write($0) }, [
            #"{"action":"pause","job":"run_1"}"#, #"{"action":"continue","job":"run_1"}"#, #"{"action":"stop","job":"run_1"}"#,
        ])
        XCTAssertEqual(replies.value.suffix(2).map { Json.str($0, "id") }, ["3", "4"])
        XCTAssertTrue(replies.value.suffix(2).allSatisfy { (($0["error"] as? JSONObject).flatMap { Json.str($0, "code") }) == "ended" })
        XCTAssertEqual(shown.value.last?.state, .ended)
        XCTAssertEqual(shown.value.last?.buttons, [])
        r.handle(say("5", "late line"))
        XCTAssertEqual((replies.value.last?["error"] as? JSONObject).flatMap { Json.str($0, "code") }, "ended", "a line of the ended job is refused")
        r.handle(say("6", "Neuer Lauf", job: "run_2"))
        XCTAssertEqual(Json.write(replies.value.last), #"{"id":"6","result":{"ok":true}}"#)
        XCTAssertEqual(shown.value.last?.job, "run_2")
        XCTAssertEqual(shown.value.last?.state, .working)
    }

    func testATapBeforeItsQuestionAnswersItWhenThePcSendsItAgain() {
        let time = ManualTime()
        let (r, replies, _, shown) = responder(time)
        XCTAssertFalse(r.answer(job: "run_7", label: "Di 14:30"), "no question yet: kept for the PC's resend")
        r.handle(say("q7", "Welcher Termin?", job: "run_7", buttons: ["Mo 9:00", "Di 14:30"]))
        XCTAssertEqual(Json.write(replies.value.last), #"{"id":"q7","result":{"answer":"Di 14:30"}}"#)
        XCTAssertEqual(shown.value.last?.state, .working)
        XCTAssertFalse(r.answer(job: "run_7", label: "✓"))
        time.advance(60_001)
        r.handle(say("q8", "Noch einmal?", job: "run_7", ask: true))
        XCTAssertEqual(shown.value.last?.state, .asking, "a tap older than 60 s answers nothing")
    }

    func testTheSameQuestionSentAgainIsAskedOnceAndAnsweredAgain() {
        let time = ManualTime()
        let (r, replies, _, shown) = responder(time)
        r.handle(say("q1", "Darf ich?", ask: true))
        let asked = shown.value.count
        r.handle(say("q1", "Darf ich?", ask: true)) // the PC sends it again: this phone attached anew
        XCTAssertEqual(shown.value.count, asked, "the waiting question is not shown again")
        XCTAssertTrue(r.answer(job: "run_1", label: "✓"))
        XCTAssertEqual(replies.value.map { Json.write($0) }, [#"{"id":"q1","result":{"answer":"yes"}}"#], "one question, one answer – no second ask after it")
        XCTAssertEqual(shown.value.last?.state, .working)
        r.handle(say("q1", "Darf ich?", ask: true)) // the answer went while the PC did not hear it: it asks once more
        XCTAssertEqual(replies.value.map { Json.write($0) }, [#"{"id":"q1","result":{"answer":"yes"}}"#, #"{"id":"q1","result":{"answer":"yes"}}"#])
        XCTAssertEqual(shown.value.last?.state, .working, "the person is not asked twice")
        r.handle(say("l1", "Sending"))
        r.handle(say("l1", "Sending"))
        XCTAssertEqual(replies.value.suffix(2).map { Json.write($0) }, [#"{"id":"l1","result":{"ok":true}}"#, #"{"id":"l1","result":{"ok":true}}"#])
    }

    func testDoneEndsTheActivityAndEmptySayIsRefused() {
        let time = ManualTime()
        let (r, replies, _, shown) = responder(time)
        r.handle(say("1", "   "))
        XCTAssertEqual((replies.value.last?["error"] as? JSONObject).flatMap { Json.str($0, "message") }, "phone.say needs a text.")
        r.handle(say("2", "Fertig gleich"))
        r.handle(PhoneUseResponder.Request(id: "3", op: "done", job: "run_1"))
        XCTAssertEqual(Json.write(replies.value.last), #"{"id":"3","result":{}}"#)
        XCTAssertEqual(shown.value.last?.state, .ended)
        XCTAssertEqual(shown.value.last?.line, "Fertig gleich")
        XCTAssertFalse(r.stop(job: "run_1"), "nothing left to stop")
        XCTAssertEqual(PhoneUseResponder.Request(["id": "x", "op": "say", "args": ["text": "a"] as JSONObject, "job": "j", "by": "b", "deviceId": "d"] as JSONObject)?.job, "j")
        XCTAssertNil(PhoneUseResponder.Request(["op": "say"] as JSONObject))
    }

    // MARK: UseLink against a fake PC

    private func link(_ pc: FakeUsePc, device: String = "dev_phone") -> UseLink {
        UseLink(origin: "http://127.0.0.1:47920", gate: "GATE", token: "TOKEN", deviceId: device, model: "iPhone 17 Pro", screen: (1206, 2622), connector: pc)
    }

    func testUseLinkSaysHelloSubscribesAndAttachesWithoutPhoneUse() throws {
        let pc = FakeUsePc()
        let use = link(pc)
        use.start()
        defer { use.stop() }
        XCTAssertTrue(use.waitLinked(timeoutMs: 5_000))
        let hello = try XCTUnwrap(pc.frames.poll(timeout: 2))
        XCTAssertEqual(Json.write(hello), #"{"client":"pwa","deviceName":"iPhone 17 Pro","protocol":1,"token":"TOKEN"}"#)
        let subscribe = try XCTUnwrap(pc.next("events.subscribe"))
        XCTAssertEqual(Json.write(subscribe["params"]), #"{"topics":["system"]}"#)
        let attach = try XCTUnwrap(pc.next("phoneUse.attach"))
        XCTAssertEqual(Json.write(attach["params"]), #"{"model":"iPhone 17 Pro","platform":"ios","ready":false,"screen":{"height":2622,"width":1206},"steps":["say","done"]}"#)
        XCTAssertEqual(pc.urls, ["ws://127.0.0.1:47920/ws"])
        XCTAssertEqual(pc.headers, [["Cookie": "autark_gate=GATE"]])
    }

    func testUseLinkHandsOnlyThisPhonesRequestsAndCarriesCalls() throws {
        let pc = FakeUsePc()
        pc.results["chats.list"] = [["id": "c1", "title": "Stanislaus"] as JSONObject] as [Any]
        pc.errors["messages.send"] = "No such chat."
        let use = link(pc)
        let got = BlockingQueue<PhoneUseResponder.Request>()
        use.onRequest = { got.offer($0) }
        use.start()
        defer { use.stop() }
        XCTAssertTrue(use.waitLinked(timeoutMs: 5_000))
        let socket = try XCTUnwrap(pc.last)
        socket.event("phoneUse.request", ["deviceId": "dev_other", "id": "r0", "op": "say", "args": ["text": "x"] as JSONObject])
        socket.event("phoneUse.request", ["deviceId": "dev_phone", "id": "r1", "op": "say", "args": ["text": "Hallo"] as JSONObject, "job": "run_9", "by": "Mika"])
        let request = try XCTUnwrap(got.poll(timeout: 3))
        XCTAssertEqual(request.id, "r1")
        XCTAssertEqual(request.by, "Mika")
        XCTAssertNil(got.poll(timeout: 0.3))
        XCTAssertEqual(QuickSend.chats(try use.request("chats.list", [:], timeoutMs: 3_000)), [ChatRef(id: "c1", title: "Stanislaus")])
        XCTAssertThrowsError(try use.request("messages.send", [:], timeoutMs: 3_000)) { XCTAssertEqual(($0 as? AutarkError)?.message, "No such chat.") }
    }

    func testUseLinkFailsWaitingCallsWhenTheSocketEndsAndComesBack() throws {
        let pc = FakeUsePc()
        pc.silent = ["chats.list"]
        let use = link(pc)
        let states = Locked<[Bool]>([])
        use.onLinked = { up in states.with { $0.append(up) } }
        use.start()
        defer { use.stop() }
        XCTAssertTrue(use.waitLinked(timeoutMs: 5_000))
        let failed = Future<String>()
        use.call("chats.list", [:]) { result in if case .failure(let error) = result { failed.complete(error.message) } }
        pc.last?.close()
        XCTAssertEqual(try failed.get(timeout: 3), UseLink.unlinked)
        XCTAssertThrowsError(try use.request("chats.list", [:], timeoutMs: 200))
        use.nudge()
        XCTAssertTrue(use.waitLinked(timeoutMs: 5_000))
        XCTAssertEqual(pc.sockets.count, 2, "a new socket after the nudge")
        XCTAssertEqual(states.value.prefix(2), [true, false])
    }

    func testRespondersRepliesGoBackOverTheLink() throws {
        let pc = FakeUsePc()
        let use = link(pc)
        let time = ManualTime()
        let r = PhoneUseResponder(now: { time.now }, after: { ms, work in time.after(ms, work) })
        r.onReply = { use.send("phoneUse.reply", $0) }
        r.onControl = { use.send("phoneUse.control", $0) }
        let shown = BlockingQueue<LiveState>()
        r.onShow = { shown.offer($0) }
        use.onRequest = { r.handle($0) }
        use.start()
        defer { use.stop() }
        XCTAssertTrue(use.waitLinked(timeoutMs: 5_000))
        pc.last?.event("phoneUse.request", ["deviceId": "dev_phone", "id": "q1", "op": "say", "args": ["text": "Weiter?", "ask": true] as JSONObject, "job": "run_3", "by": "Juri"])
        XCTAssertEqual(shown.poll(timeout: 3)?.state, .asking)
        XCTAssertTrue(r.answer(job: "run_3", label: "✓"))
        let reply = try XCTUnwrap(pc.next("phoneUse.reply"))
        XCTAssertEqual(Json.write(reply["params"]), #"{"id":"q1","result":{"answer":"yes"}}"#)
        XCTAssertTrue(r.stop(job: "run_3"))
        let control = try XCTUnwrap(pc.next("phoneUse.control"))
        XCTAssertEqual(Json.write(control["params"]), #"{"action":"stop","job":"run_3"}"#)
    }

    // MARK: phone.liveToken

    func testLiveTokensAreSentOnceUntilTakenAndClearedAtTheEnd() {
        var sent = [JSONObject]()
        var accept = false
        var waiting = [(Bool) -> Void]()
        let tokens = LiveTokens(bundle: "com.teydralab.autark", environment: .sandbox) { params, done in
            sent.append(params)
            if accept { done(true) } else { waiting.append(done) }
        }
        tokens.start(token: [0xab, 0x01])
        XCTAssertEqual(sent.map { Json.write($0) }, [#"{"bundle":"com.teydralab.autark","env":"sandbox","kind":"start","token":"ab01"}"#])
        waiting.removeFirst()(false)
        XCTAssertEqual(tokens.pending, ["start"])
        accept = true
        tokens.flush()
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(tokens.pending, [])
        tokens.start(token: [0xab, 0x01])
        tokens.flush()
        XCTAssertEqual(sent.count, 2, "the same token is not sent again")
        tokens.activity(job: "run_1", token: [0x0f])
        XCTAssertEqual(Json.write(sent.last), #"{"bundle":"com.teydralab.autark","env":"sandbox","job":"run_1","kind":"activity","token":"0f"}"#)
        tokens.activity(job: "run_1", token: nil)
        XCTAssertEqual(Json.write(sent.last), #"{"job":"run_1","kind":"activity","token":null}"#)
        XCTAssertEqual(tokens.pending, [])
        tokens.activity(job: "run_2", token: nil)
        XCTAssertEqual(sent.count, 4, "a null for a token the PC never had is not sent")
    }

    // MARK: quick sends

    func testChatsForThePick() {
        let rows: [Any] = [
            ["id": "c_old", "title": "Alt", "lastMessageAt": 10.0, "pinned": false] as JSONObject,
            ["id": "c_new", "title": "  Neu\nChat ", "lastMessageAt": 30.0] as JSONObject,
            ["id": "c_pin", "title": "Gepinnt", "lastMessageAt": 5.0, "pinned": true] as JSONObject,
            ["id": "c_arch", "title": "Archiv", "archivedAt": 3.0] as JSONObject,
            ["id": "c_thread", "title": "Faden", "settings": ["anchorId": "m_1"] as JSONObject] as JSONObject,
            ["title": "ohne id"] as JSONObject,
            ["id": "c_empty", "title": ""] as JSONObject,
        ]
        XCTAssertEqual(QuickSend.chats(rows).map { $0.id }, ["c_pin", "c_new", "c_old", "c_empty"])
        XCTAssertEqual(QuickSend.chats(rows)[1].title, "Neu Chat")
        XCTAssertEqual(QuickSend.chats(rows)[3].title, "Chat")
        XCTAssertEqual(QuickSend.chats(nil), [])
    }

    func testUploadPiecesAndMessage() throws {
        let small = OutFile(name: "shot.png", mime: "image/png", data: [1, 2, 3])
        XCTAssertEqual(Json.write(QuickSend.upload(small)), #"{"dataBase64":"AQID","mime":"image/png","name":"shot.png"}"#)
        let big = OutFile(name: "big.png", mime: "image/png", data: Bytes(repeating: 7, count: QuickSend.pieceBytes * 2 + 5))
        let pieces = QuickSend.pieces(big, uploadId: "up_abcdefgh12345678", chat: "c_1")
        XCTAssertEqual(pieces.count, 3)
        XCTAssertEqual(pieces.map { Json.num($0, "index", -1) }, [0, 1, 2])
        XCTAssertEqual(pieces.map { $0["final"] as? Bool ?? false }, [false, false, true])
        XCTAssertEqual(Crypto.fromB64Std(Json.str(pieces[2], "dataBase64") ?? "")?.count, 5)
        XCTAssertTrue(pieces.allSatisfy { Json.str($0, "conversationId") == "c_1" })
        XCTAssertNotNil(QuickSend.uploadId().range(of: "^up_[0-9a-z]{24}$", options: .regularExpression))
        let caller = FakeCaller()
        try QuickSend.send(caller, chat: "c_1", text: "  Schau mal  ", files: [small, big], clientId: "ios-1")
        XCTAssertEqual(caller.calls.map { $0.0 }, ["files.upload", "files.uploadChunk", "files.uploadChunk", "files.uploadChunk", "messages.send"])
        XCTAssertEqual(Json.write(caller.calls.last?.1), #"{"attachments":[{"fileId":"f1","height":20,"mime":"image/png","name":"shot.png","size":3,"width":10},{"fileId":"big","mime":"image/png","name":"big.png","size":5000000}],"body":"Schau mal","clientId":"ios-1","conversationId":"c_1"}"#)
        XCTAssertThrowsError(try QuickSend.send(FakeCaller(), chat: "c_1", text: "  ", files: [], clientId: "x"))
    }

    func testShareInboxKeepsPostsUntilTheyWent() throws {
        let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("autark-inbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let inbox = ShareInbox(folder: folder)
        inbox.saveChats([ChatRef(id: "c_1", title: "Stanislaus", pinned: true, lastAt: 9)])
        XCTAssertEqual(inbox.chats(), [ChatRef(id: "c_1", title: "Stanislaus", pinned: true, lastAt: 9)])
        let first = try inbox.put(chat: ChatRef(id: "c_1", title: "Stanislaus"), text: "Link: https://example.com", files: [], now: 1)
        _ = try inbox.put(chat: ChatRef(id: "c_2", title: "Konrad"), text: "", files: [OutFile(name: "Bild 1/../x.jpg", mime: "image/jpeg", data: [9, 9])], now: 2)
        XCTAssertEqual(inbox.posts().map { $0.chat.id }, ["c_1", "c_2"])
        XCTAssertEqual(inbox.files(of: inbox.posts()[1]), [OutFile(name: "Bild 1/../x.jpg", mime: "image/jpeg", data: [9, 9])])
        XCTAssertEqual(inbox.posts()[1].files.first?.stored, "0-Bild_1_.._x.jpg")
        let failing = FakeCaller()
        failing.failOn = "messages.send"
        XCTAssertEqual(inbox.sendAll(failing), 0)
        XCTAssertEqual(inbox.posts().count, 2, "a failed post stays, and the ones after it wait")
        let caller = FakeCaller()
        XCTAssertEqual(inbox.sendAll(caller), 2)
        XCTAssertEqual(inbox.posts(), [])
        XCTAssertEqual(Json.str(caller.calls[0].1, "clientId"), first.clientId, "the post's own client id: a retry makes no second message")
    }
}
