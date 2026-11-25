// Owns: the iPhone's side of phone use as a state machine – a phoneUse.request in (from UseLink, only this phone's), its
// phoneUse.reply out, and the Live Activity's content (LiveState) after every change. The iPhone answers only two steps (contract,
// IPHONE-WELLE2.md): `say` (the AI's line, or its question with ✓ / ✕ / its own labels, answered "yes" / "no" / the label, "none"
// after 60 s without a tap – Android's UseService.say) and `done` (the PC's run is over: state ended, the activity closes); every
// other step is refused with bad_request "Unknown step <op>." like an older Android app, because on iOS WebDriverAgent acts from the
// PC (part D1), not the app. The person's buttons on the activity: Pause / Continue / Stop go to the PC as phoneUse.control
// {job, action: pause | continue | stop}; Stop answers a waiting question and every queued step with the error `ended`, a step of
// an ended job is refused (UseState). Steps run one at a time in arrival order: a question holds the steps after it until it is
// answered (Android's step thread waits the same way). Time comes from `now` and `after` (tests drive both).
// The PC sends a question again with the same id when this phone attaches anew (part D2: the app was suspended, the socket came back):
// a request that already waits here is not queued twice, and one answered lately gets the same answer again (the PC may have missed it).
// Never: blocks the caller's thread, acts on the screen, or answers one request two different ways.
import Foundation

public final class PhoneUseResponder {
    /// How long a question waits for a tap before it answers "none".
    public static let askMs = 60_000

    /// One step of the PC (phoneUse.request's data).
    public struct Request {
        public let id: String
        public let op: String
        public let args: JSONObject
        public let job: String?
        public let by: String?

        public init(id: String, op: String, args: JSONObject = [:], job: String? = nil, by: String? = nil) {
            self.id = id; self.op = op; self.args = args; self.job = job; self.by = by
        }

        /// The request in an event's data (nil without id or op).
        public init?(_ data: JSONObject) {
            guard let id = Json.str(data, "id"), !id.isEmpty, let op = Json.str(data, "op"), !op.isEmpty else { return nil }
            self.init(id: id, op: op, args: data["args"] as? JSONObject ?? [:], job: Json.str(data, "job"), by: Json.str(data, "by"))
        }
    }

    /// phoneUse.reply's params: {id, result} or {id, error: {code, message}}.
    public var onReply: (JSONObject) -> Void = { _ in }
    /// phoneUse.control's params {job, action}.
    public var onControl: (JSONObject) -> Void = { _ in }
    /// The activity's content after a change; nil before the first step.
    public var onShow: (LiveState) -> Void = { _ in }

    /// How many answered requests are remembered for the PC's resend.
    public static let answeredKept = 32

    private let now: () -> Int64
    private let after: (Int, @escaping () -> Void) -> Void
    private let rules = UseState()
    private let lock = NSLock()
    private var queue = [Request]()
    private var question: (request: Request, labels: [String], serial: Int)?
    private var serial = 0
    private var draining = false
    /// A tap that came before its question (job, label, when).
    private var early: (job: String, label: String, at: Int64)?
    private var shown: LiveState?
    private var who = ""
    /// The step being run now (between the queue and its reply).
    private var running: String?
    /// The latest replies by request id, oldest first.
    private var answered = [(id: String, reply: JSONObject)]()

    /// `now`: milliseconds since 1970; `after`: runs the closure once after that many milliseconds (any thread).
    public init(now: @escaping () -> Int64 = Clock.nowMs, after: @escaping (Int, @escaping () -> Void) -> Void = { ms, work in later(milliseconds: ms, work) }) {
        self.now = now
        self.after = after
    }

    /// What the activity shows now (nil before the first step).
    public var current: LiveState? { lock.lock(); defer { lock.unlock() }; return shown }

    public var mode: UseState.Mode { rules.mode }

    // MARK: in

    /// A step for this phone (UseLink filtered the device); its answer goes to onReply now or once its question is answered.
    public func handle(_ request: Request) {
        lock.lock()
        if question?.request.id == request.id || running == request.id || queue.contains(where: { $0.id == request.id }) {
            lock.unlock() // the PC sent it again (this phone attached anew): it already waits here
            return
        }
        if let done = answered.first(where: { $0.id == request.id }) {
            lock.unlock()
            onReply(done.reply) // answered while the PC did not hear it: the same answer again
            return
        }
        queue.append(request)
        lock.unlock()
        drain()
    }

    /// The person tapped a label of the question (✓, ✕ or one of the AI's); `job` is the activity's (a tap on an old activity
    /// does nothing). True when it answered the waiting question.
    @discardableResult
    public func answer(job: String?, label: String) -> Bool {
        lock.lock()
        guard let open = question, PhoneUseResponder.same(open.request.job, job) else {
            // No question waits here (the app was launched for this tap of a question that came as a push): the PC sends that question
            // again with the same id once this phone attaches (part D2), and this tap answers it then (within askMs).
            if question == nil { early = (job ?? "", label, now()) }
            lock.unlock()
            return false
        }
        if label != SayChoices.no && label != SayChoices.yes && !open.labels.contains(label) { lock.unlock(); return false }
        question = nil
        lock.unlock()
        let answer = SayChoices.answer(label)
        if answer == "yes" { rules.agreed(open.request.job, now: now()) }
        reply(["id": open.request.id, "result": ["answer": answer] as JSONObject])
        show(open.request, line: nil, ask: false, labels: [])
        drain()
        return true
    }

    /// The person's Pause (the activity's button): the PC hears pause, the activity shows paused.
    @discardableResult
    public func pause(job: String?) -> Bool {
        guard isLive(job), rules.pause() else { return false }
        control("pause")
        restate()
        return true
    }

    /// The person's Continue.
    @discardableResult
    public func resume(job: String?) -> Bool {
        guard isLive(job), rules.resume() else { return false }
        control("continue")
        restate()
        return true
    }

    /// The person's Stop: the PC's run ends for good; a waiting question and every queued step hear `ended`.
    @discardableResult
    public func stop(job: String?) -> Bool {
        guard isLive(job), rules.end() else { return false }
        control("stop")
        lock.lock()
        let open = question
        question = nil
        let waiting = queue
        queue = []
        lock.unlock()
        if let open = open { reply(PhoneUseResponder.refusal(open.request.id, UseState.Refusal(code: "ended", message: UseState.ended))) }
        for request in waiting { reply(PhoneUseResponder.refusal(request.id, UseState.Refusal(code: "ended", message: UseState.ended))) }
        end()
        return true
    }

    // MARK: steps

    /// Runs queued steps until one asks (its answer releases the rest) or none is left.
    private func drain() {
        lock.lock()
        if draining { lock.unlock(); return } // the running drainer picks up what came meanwhile: one step at a time
        draining = true
        lock.unlock()
        while true {
            lock.lock()
            if question != nil || queue.isEmpty { draining = false; lock.unlock(); return }
            let request = queue.removeFirst()
            running = request.id
            lock.unlock()
            run(request)
            lock.lock()
            running = nil
            lock.unlock()
        }
    }

    private func run(_ request: Request) {
        switch request.op {
        case "done":
            rules.finished(request.job)
            reply(["id": request.id, "result": [:] as JSONObject])
            if isCurrent(request.job) { end() }
        case "say":
            say(request)
        default:
            reply(PhoneUseResponder.refusal(request.id, UseState.Refusal(code: "bad_request", message: "Unknown step \(request.op).")))
        }
    }

    /// phone.say: a line answers {ok: true} at once; a question waits for a tap (or "none" after askMs).
    private func say(_ request: Request) {
        let text = LiveState.oneLine(Json.str(request.args, "text") ?? "")
        if text.isEmpty {
            reply(PhoneUseResponder.refusal(request.id, UseState.Refusal(code: "bad_request", message: "phone.say needs a text.")))
            return
        }
        let wantsAnswer = request.args["ask"] as? Bool == true
        let asks = SayChoices.asks(request.args["buttons"], ask: wantsAnswer)
        let refused = rules.step(request.job, now: now())
        if !asks, let refused = refused, refused.code == "ended" {
            reply(PhoneUseResponder.refusal(request.id, refused))
            return
        }
        if !asks {
            show(request, line: text, ask: false, labels: [])
            reply(["id": request.id, "result": ["ok": true] as JSONObject])
            return
        }
        let labels = SayChoices.of(request.args["buttons"], ask: wantsAnswer)
        lock.lock()
        if let tap = early, tap.job == (request.job ?? ""), now() - tap.at <= Int64(PhoneUseResponder.askMs),
           tap.label == SayChoices.yes || tap.label == SayChoices.no || labels.contains(tap.label) {
            early = nil
            lock.unlock()
            let answer = SayChoices.answer(tap.label)
            if answer == "yes" { rules.agreed(request.job, now: now()) }
            reply(["id": request.id, "result": ["answer": answer] as JSONObject])
            show(request, line: text, ask: false, labels: [])
            return
        }
        early = nil
        serial += 1
        let mine = serial
        question = (request, labels, mine)
        lock.unlock()
        show(request, line: text, ask: true, labels: labels)
        after(PhoneUseResponder.askMs) { [weak self] in self?.timeout(mine) }
    }

    /// No tap within askMs: the question answers "none" and the steps after it run.
    private func timeout(_ mine: Int) {
        lock.lock()
        guard let open = question, open.serial == mine else { lock.unlock(); return }
        question = nil
        lock.unlock()
        reply(["id": open.request.id, "result": ["answer": "none"] as JSONObject])
        show(open.request, line: nil, ask: false, labels: [])
        drain()
    }

    // MARK: the activity

    /// The activity after a step of `request`: its job and agent, the new line (nil keeps the last one), asking or not.
    private func show(_ request: Request, line: String?, ask: Bool, labels: [String]) {
        lock.lock()
        if let by = request.by, !by.isEmpty { who = by }
        let previous = shown
        let job = request.job ?? ""
        let keep = previous.flatMap { $0.job == job ? $0.line : nil } ?? ""
        let phase: LiveState.Phase = ask ? .asking : (rules.mode == .paused ? .paused : .working)
        let next = LiveState(job: job, by: who, line: line ?? keep, ask: ask, buttons: labels, state: phase, at: now())
        shown = next
        lock.unlock()
        onShow(next)
    }

    /// The same content with the mode the person's button set (paused / working).
    private func restate() {
        lock.lock()
        guard var next = shown, next.state != .ended else { lock.unlock(); return }
        if next.state != .asking { next.state = rules.mode == .paused ? .paused : .working }
        next.at = now()
        shown = next
        lock.unlock()
        onShow(next)
    }

    /// The run is over (done or Stop): state ended, no question, no buttons – the app closes the activity a few seconds later.
    private func end() {
        lock.lock()
        guard var next = shown, next.state != .ended else { lock.unlock(); return }
        next.state = .ended
        next.ask = false
        next.buttons = []
        next.at = now()
        shown = next
        lock.unlock()
        onShow(next)
    }

    /// A reply to the PC, remembered by its request id for the PC's resend.
    private func reply(_ value: JSONObject) {
        if let id = Json.str(value, "id") {
            lock.lock()
            answered.removeAll { $0.id == id }
            answered.append((id, value))
            if answered.count > PhoneUseResponder.answeredKept { answered.removeFirst() }
            lock.unlock()
        }
        onReply(value)
    }

    private func control(_ action: String) {
        lock.lock()
        let job = shown?.job ?? rules.currentJob ?? ""
        lock.unlock()
        onControl(["job": job, "action": action])
    }

    /// True when `job` is the activity's (an older activity's button acts on nothing).
    private func isCurrent(_ job: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let shown = shown else { return false }
        return PhoneUseResponder.same(shown.job, job)
    }

    /// True when `job` is the activity's and it has not ended (Pause / Continue / Stop act on nothing else).
    private func isLive(_ job: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let shown = shown, shown.state != .ended else { return false }
        return PhoneUseResponder.same(shown.job, job)
    }

    private static func same(_ a: String?, _ b: String?) -> Bool { (a ?? "") == (b ?? "") }

    static func refusal(_ id: String, _ refusal: UseState.Refusal) -> JSONObject {
        ["id": id, "error": ["code": refusal.code, "message": refusal.message] as JSONObject]
    }
}
