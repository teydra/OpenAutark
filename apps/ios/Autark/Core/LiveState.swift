// Owns: the content of the iPhone's "Autark is using this phone" Live Activity (ActivityKit's ContentState) in the JSON shape the
// shared contract fixes (workspace/apple-plattformen/IPHONE-WELLE2.md, "Zustand der Live Activity"): {job, by, line, ask, buttons,
// state, at} – the same keys whether the app sets it from a phoneUse.request in the foreground or the PC sends it in a Live Activity
// push through the meeting server (part D2) – and the limits Android's bubble keeps (line 120, 8 buttons of 40, agent name 60, job 64).
// Decoding is lenient (a push may leave keys out; an unknown state reads as working), encoding always writes every key.
// Never: imports ActivityKit (the app's AutarkAgentActivityAttributes wraps this type), so the Linux tests pin the encoding.
import Foundation

public struct LiveState: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Hashable, CaseIterable, Sendable { case working, asking, paused, ended }

    public static let jobMax = 64
    public static let byMax = 60
    public static let lineMax = 120
    public static let buttonsMax = 8
    public static let buttonMax = 40

    /// The PC's run this belongs to (phoneUse.request `job`; "" for an older PC without job ids).
    public var job: String
    /// The agent's name: "<by> is using this phone".
    public var by: String
    /// The AI's line, or its question while asking.
    public var line: String
    /// True while a question waits for ✓ / ✕ / one of `buttons`.
    public var ask: Bool
    /// The question's own labels (SayChoices: ✕ is the activity's own button; a plain ask carries ["✓"]).
    public var buttons: [String]
    public var state: Phase
    /// Milliseconds since 1970 of this change.
    public var at: Int64

    public init(job: String, by: String, line: String, ask: Bool = false, buttons: [String] = [], state: Phase, at: Int64) {
        self.job = LiveState.clip(job, LiveState.jobMax, ellipsis: false)
        self.by = LiveState.clip(LiveState.oneLine(by), LiveState.byMax)
        self.line = LiveState.clip(LiveState.oneLine(line), LiveState.lineMax)
        self.ask = ask
        self.buttons = Array(buttons.prefix(LiveState.buttonsMax)).map { LiveState.clip(LiveState.oneLine($0), LiveState.buttonMax) }
        self.state = state
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case job, by, line, ask, buttons, state, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let phase = Phase(rawValue: (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "working") ?? .working
        let at: Int64
        if let whole = try? c.decodeIfPresent(Int64.self, forKey: .at) { at = whole }
        else if let number = try? c.decodeIfPresent(Double.self, forKey: .at) { at = Int64(number) }
        else { at = 0 }
        self.init(job: (try? c.decodeIfPresent(String.self, forKey: .job)) ?? "",
                  by: (try? c.decodeIfPresent(String.self, forKey: .by)) ?? "",
                  line: (try? c.decodeIfPresent(String.self, forKey: .line)) ?? "",
                  ask: (try? c.decodeIfPresent(Bool.self, forKey: .ask)) ?? false,
                  buttons: (try? c.decodeIfPresent([String].self, forKey: .buttons)) ?? [],
                  state: phase, at: at)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(job, forKey: .job)
        try c.encode(by, forKey: .by)
        try c.encode(line, forKey: .line)
        try c.encode(ask, forKey: .ask)
        try c.encode(buttons, forKey: .buttons)
        try c.encode(state.rawValue, forKey: .state)
        try c.encode(at, forKey: .at)
    }

    /// The contract's JSON object (the PC's push payload `content-state` has exactly these keys).
    public var json: JSONObject {
        ["job": job, "by": by, "line": line, "ask": ask, "buttons": buttons as [Any], "state": state.rawValue, "at": at]
    }

    /// The state from a parsed JSON object (a push's content-state, a test); nil when it is not an object.
    public static func from(_ value: Any?) -> LiveState? {
        guard let object = value as? JSONObject else { return nil }
        let phase = Json.str(object, "state").flatMap { Phase(rawValue: $0) } ?? .working
        let at: Int64 = (object["at"] as? Double).map { Int64($0) } ?? (object["at"] as? Int).map { Int64($0) } ?? (object["at"] as? Int64) ?? 0
        return LiveState(job: Json.str(object, "job") ?? "", by: Json.str(object, "by") ?? "", line: Json.str(object, "line") ?? "",
                         ask: object["ask"] as? Bool ?? false, buttons: (object["buttons"] as? [Any])?.compactMap { $0 as? String } ?? [],
                         state: phase, at: at)
    }

    /// The headline the activity shows: "<by> is using this phone".
    public var headline: String { (by.isEmpty ? "Autark" : by) + " is using this phone" }

    /// True when Pause/Continue and Stop belong on the activity (working or paused); the question's buttons replace them while asking.
    public var controls: Bool { state == .working || state == .paused }

    /// Whitespace runs become one space, the ends are trimmed (Android's bubble does the same).
    public static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// At most `max` characters; a longer text keeps `max - 1` and ends with "…".
    public static func clip(_ text: String, _ max: Int, ellipsis: Bool = true) -> String {
        if text.count <= max { return text }
        return ellipsis ? String(text.prefix(max - 1)) + "…" : String(text.prefix(max))
    }
}
