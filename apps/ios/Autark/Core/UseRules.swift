// Owns: the person's say over phone use on the iPhone, ported rule for rule from Android (phoneuse/UseState.java and
// SayChoices.java): who has the phone – active, paused (the person's Pause holds until their Continue) or ended (their Stop ends the
// PC's run `job` for good, a late step of it is refused too) – and which of the AI's labels a question keeps (at most 8 of 40
// characters, ✕ is the activity's own button, a plain ask carries ✓) and what a tap answers (✓ "yes", ✕ "no", any other label itself).
// On the iPhone the steps that act (tap, type …) run on the PC through WebDriverAgent (part D1); the app only shows and answers
// `say`, and tells the PC Pause/Continue/Stop with phoneUse.control. The refusal texts are Android's, word for word, because the AI
// reads them. Pure Foundation (Linux tests).
// Never: lifts the person's Pause or Stop by itself, or invents a label.
import Foundation

public final class UseState {
    public enum Mode: Equatable { case active, paused, ended }

    /// A refused step: its code and the words the AI reads (phoneUse.reply's error).
    public struct Refusal: Equatable {
        public let code: String
        public let message: String
    }

    /// Without a job id, a pause in steps this long starts a new job (ended no longer applies).
    public static let sessionMs: Int64 = 5 * 60_000
    /// How many ended jobs are remembered.
    public static let endedKept = 64

    public static let pausedPerson = "The person paused my phone use with Pause and has the phone; this step did not run. "
        + "My task stays: phone use goes on when they tap Continue in the bubble, or when they answer ✓ to my question "
        + "(phone.say with ask: true). Meanwhile I go on with other work."
    public static let ended = "The person ended my phone use for this task with ✕; this step did not run, and the phone "
        + "stays theirs for this task. I finish it another way, or tell them in the chat what is left on the phone."

    private let lock = NSLock()
    private var modeValue = Mode.active
    private var job: String?
    private var endedJobs = [String]()
    private var endedWithoutJob = false
    private var lastStep = Int64.min / 2

    public init() {}

    public var mode: Mode { lock.lock(); defer { lock.unlock() }; return modeValue }

    /// The job the person's buttons act on now (nil: an older PC without job ids, or none yet).
    public var currentJob: String? { lock.lock(); defer { lock.unlock() }; return job }

    private static func key(_ job: String?) -> String? { (job?.isEmpty ?? true) ? nil : job }

    /// Before each step: nil lets it run; else why not.
    public func step(_ job: String?, now: Int64) -> Refusal? {
        lock.lock(); defer { lock.unlock() }
        let key = UseState.key(job)
        let sameSession = now - lastStep <= UseState.sessionMs
        if key == nil && !sameSession { endedWithoutJob = false }
        let isEnded = key.map { endedJobs.contains($0) } ?? endedWithoutJob
        if isEnded { lastStep = now; return Refusal(code: "ended", message: UseState.ended) }
        if modeValue == .ended { modeValue = .active } // a new job: the Stop was for the one before
        self.job = key
        lastStep = now
        if modeValue == .paused { return Refusal(code: "paused", message: UseState.pausedPerson) }
        return nil
    }

    /// The person's Pause: it holds until Continue.
    @discardableResult
    public func pause() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if modeValue != .active { return false }
        modeValue = .paused
        return true
    }

    /// The person's ✓ to the AI's question for `job`: phone use is active for that job, after a Pause or Stop too.
    public func agreed(_ job: String?, now: Int64) {
        lock.lock(); defer { lock.unlock() }
        let key = UseState.key(job)
        if let key = key { endedJobs.removeAll { $0 == key } } else { endedWithoutJob = false }
        self.job = key
        modeValue = .active
        lastStep = now
    }

    /// The PC's run `job` is over: its session ends; the person's own Pause and Stop stay as they are.
    public func finished(_ job: String?) {
        lock.lock(); defer { lock.unlock() }
        let key = UseState.key(job)
        if let key = key, let current = self.job, key != current { return }
        lastStep = Int64.min / 2
    }

    /// The person's Continue.
    @discardableResult
    public func resume() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if modeValue != .paused { return false }
        modeValue = .active
        return true
    }

    /// The person's Stop: the current job ends for good (from active or paused).
    @discardableResult
    public func end() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if modeValue == .ended { return false }
        modeValue = .ended
        if let job = job {
            endedJobs.append(job)
            if endedJobs.count > UseState.endedKept { endedJobs.removeFirst() }
        } else {
            endedWithoutJob = true
        }
        return true
    }
}

public enum SayChoices {
    public static let max = LiveState.buttonsMax
    public static let labelMax = LiveState.buttonMax
    public static let yes = "✓"
    public static let no = "✕"

    /// The labels of a say: its `buttons` (a JSON array of strings), else ✓ for `ask`; empty for a plain line. ✕ is left out (the
    /// activity's ✕ answers it).
    public static func of(_ buttons: Any?, ask: Bool) -> [String] {
        var out = [String]()
        if let list = buttons as? [Any] {
            for item in list {
                guard let text = item as? String, out.count < max else { continue }
                let label = cut(LiveState.oneLine(text))
                if !label.isEmpty && label != no && !out.contains(label) { out.append(label) }
            }
            if out.isEmpty && !list.isEmpty { return out } // only ✕: a question with the ✕ alone
        }
        if out.isEmpty && ask { out.append(yes) }
        return out
    }

    /// True when the say asks a question (ask, or any buttons – even only ✕).
    public static func asks(_ buttons: Any?, ask: Bool) -> Bool {
        ask || ((buttons as? [Any])?.isEmpty == false)
    }

    /// What a tap on `label` answers: ✓ "yes", ✕ "no", any other label itself.
    public static func answer(_ label: String) -> String {
        if label == yes { return "yes" }
        if label == no { return "no" }
        return label
    }

    private static func cut(_ label: String) -> String { LiveState.clip(label, labelMax) }
}
