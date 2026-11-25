// Owns: the one Live Activity "<agent> is using this phone" on this iPhone (ActivityKit) – started at the first LiveState of a PC run,
// updated with every change of the same run, ended a few seconds after `ended` (or replaced when another run begins) – and its push
// tokens: the push-to-start token (iOS 17.2+) and each activity's token go to the PC as phone.liveToken through LiveTokens, but only
// when this build has push (Info.plist AutarkPushEnabled; it needs the paid Apple account and the aps-environment entitlement, so it is
// off and the activity is local only). Activities the PC starts by push (part D2) are adopted, so their buttons and tokens work too.
// An activity the PC started by push while the app was not running is found again by its run (`job`) – at launch, when a line or
// question of that run arrives, and when the person's Pause / Stop went straight to the PC (mark): it is updated, never doubled.
// The launch argument -AutarkLiveDemo working|asking|buttons|paused shows a sample (simulator screenshots, a first device check).
// Never: starts an activity the person switched off (ActivityAuthorizationInfo), or keeps one past its run.
import ActivityKit
import Foundation
import UIKit
import AutarkCore

@MainActor
final class LiveController {
    static let shared = LiveController()

    /// How long an ended activity stays on the Lock Screen.
    static let endedSeconds: TimeInterval = 8

    let pushEnabled = (Bundle.main.object(forInfoDictionaryKey: "AutarkPushEnabled") as? Bool) == true
    /// The PC's side of the tokens (AppModel sets it once its socket exists).
    var tokens: LiveTokens?
    /// The last ActivityKit failure (diagnostics, tests).
    private(set) var lastError: String?
    private var activity: Activity<AutarkAgentActivityAttributes>?
    private var watching = false
    /// The activities whose push token is watched already (one watch each).
    private var tokenWatched = Set<String>()

    /// Shows `state`: updates the run's activity, starts one for a new run, ends it after `ended`.
    func show(_ state: LiveState) {
        if state.state == .ended { end(state); return }
        if let current = running(job: state.job) {
            if let old = activity, old.id != current.id { Task { await old.end(nil, dismissalPolicy: .immediate) } }
            if activity?.id != current.id { activity = current; watchToken(current) } // started by push: adopted, not doubled
            Task { await current.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        if let old = activity {
            activity = nil
            Task { await old.end(nil, dismissalPolicy: .immediate) }
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { lastError = "Live Activities are off for Autark."; return }
        do {
            let next = try Activity.request(attributes: AutarkAgentActivityAttributes(device: UIDevice.current.name),
                                            content: ActivityContent(state: state, staleDate: nil),
                                            pushType: pushEnabled ? .token : nil)
            activity = next
            lastError = nil
            watchToken(next)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// The run is over: the activity shows `state` (ended) and goes a few seconds later; its token is withdrawn on the PC.
    func end(_ state: LiveState) {
        guard let current = running(job: state.job) ?? activity else { return }
        if activity?.id == current.id { activity = nil }
        let job = current.content.state.job
        Task { await current.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(LiveController.endedSeconds))) }
        if pushEnabled { tokens?.activity(job: job, token: nil) }
    }

    /// Pause / Continue / Stop that went straight to the PC (the responder did not know the run: the PC started this activity by push):
    /// the activity shows it – paused, working again, or ended and gone a few seconds later.
    func mark(job: String, action: String) {
        guard let current = running(job: job) else { return }
        var next = current.content.state
        next.at = Clock.nowMs()
        switch action {
        case "pause": next.state = .paused
        case "continue": next.state = .working
        default:
            next.state = .ended
            next.ask = false
            next.buttons = []
            end(next)
            return
        }
        if next.ask { return } // a question keeps its buttons; Pause and Continue are not on it
        Task { await current.update(ActivityContent(state: next, staleDate: nil)) }
    }

    /// The running activity of the PC's run `job`: the app's own, or one the PC started by push (not adopted yet after a relaunch).
    private func running(job: String) -> Activity<AutarkAgentActivityAttributes>? {
        if let current = activity, current.activityState == .active, current.content.state.job == job { return current }
        return Activity<AutarkAgentActivityAttributes>.activities.first { $0.activityState == .active && $0.content.state.job == job }
    }

    /// The push-to-start token and activities the PC started by push (once, at launch; only with push).
    func watchPush() {
        guard pushEnabled, !watching else { return }
        watching = true
        // A push started an activity while the app was not running (or iOS relaunched it for a button): it is adopted, its token goes to the PC.
        if activity == nil, let started = Activity<AutarkAgentActivityAttributes>.activities.first(where: { $0.activityState == .active }) {
            activity = started
            watchToken(started)
        }
        if #available(iOS 17.2, *) {
            Task { @MainActor in
                for await data in Activity<AutarkAgentActivityAttributes>.pushToStartTokenUpdates { self.tokens?.start(token: Bytes(data)) }
            }
        }
        Task { @MainActor in
            for await started in Activity<AutarkAgentActivityAttributes>.activityUpdates where self.activity?.id != started.id {
                self.activity = started // a push started it: its buttons act on its run, its token goes to the PC
                self.watchToken(started)
            }
        }
    }

    private func watchToken(_ running: Activity<AutarkAgentActivityAttributes>) {
        guard pushEnabled, tokenWatched.insert(running.id).inserted else { return }
        Task { @MainActor in
            for await data in running.pushTokenUpdates { self.tokens?.activity(job: running.content.state.job, token: Bytes(data)) }
        }
    }

    /// -AutarkLiveDemo: ends every activity of Autark, then shows the sample `kind`; "two" starts a second run beside it, so the
    /// Dynamic Island shows its minimal view (iOS shows one activity compact and the other minimal).
    func startDemo(_ kind: String) {
        Task { @MainActor in
            for old in Activity<AutarkAgentActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
            self.activity = nil
            if kind == "two" {
                self.show(LiveController.demo("working"))
                _ = try? Activity.request(attributes: AutarkAgentActivityAttributes(device: UIDevice.current.name),
                                          content: ActivityContent(state: LiveState(job: "run_demo_2", by: "Mika", line: "Prüft den Kalender", state: .working, at: Clock.nowMs()), staleDate: nil),
                                          pushType: nil)
            } else {
                self.show(LiveController.demo(kind))
            }
        }
    }

    /// The sample of -AutarkLiveDemo: what the AI's question, its line or a pause look like.
    static func demo(_ kind: String, now: Int64 = Clock.nowMs()) -> LiveState {
        switch kind {
        case "asking": return LiveState(job: "run_demo", by: "Juri", line: "Darf ich die Mail an Konrad jetzt senden?", ask: true, buttons: [SayChoices.yes], state: .asking, at: now)
        case "buttons": return LiveState(job: "run_demo", by: "Juri", line: "Welchen Termin soll ich nehmen?", ask: true, buttons: ["Mo 9:00", "Di 14:30", "Später"], state: .asking, at: now)
        case "paused": return LiveState(job: "run_demo", by: "Juri", line: "Öffne Einstellungen › WLAN", state: .paused, at: now)
        case "ended": return LiveState(job: "run_demo", by: "Juri", line: "Fertig – WLAN ist eingerichtet.", state: .ended, at: now)
        default: return LiveState(job: "run_demo", by: "Juri", line: "Öffne Einstellungen › WLAN", state: .working, at: now)
        }
    }
}
