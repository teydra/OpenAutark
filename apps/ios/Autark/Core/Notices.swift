// Owns: what a notification of Autark says and how a new one joins the ones already open – the decisions of the PC's service worker
// (ui/pwa/sw-notify.ts, due-notice.ts, badge.ts) as pure functions, so the app can show the same notices as local notifications
// (UNUserNotificationCenter) and, later, for a remote push (APNs): the payload (title, body, url, tag, kind, silent, id, clear,
// ring), one notice per tag that a newer one replaces, a notice already open with the same id is not shown twice (iOS shows it again
// quietly), a chat notice counts its bundled messages, the Due notices of to-dos fall together into ONE notice under the tag "due"
// that closes by itself after 6 s, `clear` closes a tag, `ring` marks an agent's call. The badge is the sum of the open notices.
// Beyond the PC's payload (a proposal, see apps/ios/README.md): `buttons` – the labels of a question the AI asks ("KI fragt, Person
// tippt einmal"; the PC's phoneUse op 'say' with ask/buttons has no iOS twin, so the notice carries them), answered with the label,
// or 'yes'/'no' for ✓/✕ (PhoneSayAnswer).
// Never: shows, closes or sends anything itself (the app's Notifier does), keeps state, or reads a secret.
import Foundation

/// One push as the PC sends it (runtime/pwa/push.ts payload; PushPayload in sw-notify.ts) – or what a local source makes of it.
public struct PushPayload: Equatable {
    public var title: String?
    public var body: String?
    public var url: String?
    public var tag: String?
    public var kind: String?
    public var silent: Bool
    public var id: String?
    public var clear: String?
    public var ring: Bool
    /// A question's answer buttons (at most `maxButtons`); empty: no question. Proposal, not in the PC's payload yet.
    public var buttons: [String]
    /// A question with the default ✓ and ✕ (no labels). Proposal, not in the PC's payload yet.
    public var ask: Bool

    public static let maxButtons = 4
    public static let maxButtonLength = 40

    public init(title: String? = nil, body: String? = nil, url: String? = nil, tag: String? = nil, kind: String? = nil, silent: Bool = false,
                id: String? = nil, clear: String? = nil, ring: Bool = false, buttons: [String] = [], ask: Bool = false) {
        self.title = title; self.body = body; self.url = url; self.tag = tag; self.kind = kind; self.silent = silent
        self.id = id; self.clear = clear; self.ring = ring; self.buttons = buttons; self.ask = ask
    }

    /// The payload in a JSON object (the PC's own keys); nil when it is not one. Text is clipped like the PC clips it (title 120, body 240).
    public init?(json: JSONObject) {
        func text(_ key: String, _ max: Int) -> String? { (json[key] as? String).map { String($0.prefix(max)) } }
        let labels = (json["buttons"] as? [Any] ?? []).compactMap { $0 as? String }.map { String($0.prefix(PushPayload.maxButtonLength)) }.filter { !$0.isEmpty }
        self.init(title: text("title", 120), body: text("body", 240), url: text("url", 300), tag: text("tag", 100), kind: text("kind", 20),
                  silent: json["silent"] as? Bool == true, id: text("id", 100), clear: text("clear", 100), ring: json["ring"] as? Bool == true,
                  buttons: Array(labels.prefix(PushPayload.maxButtons)), ask: json["ask"] as? Bool == true)
        if json.isEmpty { return nil }
    }

    /// From a remote notification's user info: the payload sits under "autark" (our key beside Apple's "aps"), else at the top.
    public init?(userInfo: JSONObject) {
        if let inner = userInfo["autark"] as? JSONObject { self.init(json: inner) } else { self.init(json: userInfo.filter { $0.key != "aps" }) }
    }
}

/// Facts of a Due notice kept in its data (due-notice.ts DueData).
public struct DueData: Equatable {
    public let items: [String]
    public let stamp: Int64
}

public enum DueNotice {
    /// How long a Due notice stays before the app closes it.
    public static let showMs = 6_000
    /// The one tag every Due notice shares.
    public static let tag = "due"
    private static let maxItems = 5
    private static let prefix = "Due: "

    /// True for the push of a to-do that fell due (kind 'todo', "Due: …").
    public static func isDue(_ payload: PushPayload) -> Bool {
        payload.clear == nil && payload.kind == "todo" && (payload.title?.hasPrefix(prefix) ?? false)
    }

    /// The grouped notice: this push joins the titles already open (each once, the newest five); one title keeps its own text, more say how many.
    public static func group(_ payload: PushPayload, open: [String], now: Int64) -> (payload: PushPayload, data: DueData) {
        let title = (payload.title ?? "").replacingOccurrences(of: prefix, with: "", options: [.anchored]).trimmingCharacters(in: .whitespaces)
        let items = Array((open.filter { $0 != title } + (title.isEmpty ? [] : [title])).suffix(maxItems))
        let many = items.count > 1
        var out = payload
        out.tag = tag
        if many { out.title = "\(items.count) to-dos due"; out.body = items.joined(separator: " · ") }
        else { out.body = payload.body ?? "" }
        return (out, DueData(items: items, stamp: now))
    }
}

/// A notice open now (a delivered notification), as far as the plan needs it.
public struct OpenNotice: Equatable {
    public var tag: String?
    public var title: String
    public var body: String
    public var id: String?
    public var ids: [String]
    public var count: Int?
    public var url: String?
    public var due: DueData?

    public init(tag: String?, title: String, body: String, id: String? = nil, ids: [String] = [], count: Int? = nil, url: String? = nil, due: DueData? = nil) {
        self.tag = tag; self.title = title; self.body = body; self.id = id; self.ids = ids; self.count = count; self.url = url; self.due = due
    }

    /// From a delivered notification's user info (what `NoticeContent.userInfo` wrote).
    public init(tag: String?, title: String, body: String, userInfo: JSONObject) {
        let due: DueData? = (userInfo["due"] as? Bool == true) ? DueData(items: (userInfo["items"] as? [Any] ?? []).compactMap { $0 as? String }, stamp: Int64(Json.num(userInfo, "stamp", 0))) : nil
        self.init(tag: tag, title: title, body: body, id: Json.str(userInfo, "id"), ids: (userInfo["ids"] as? [Any] ?? []).compactMap { $0 as? String },
                  count: userInfo["count"] == nil ? nil : Json.num(userInfo, "count", 1), url: Json.str(userInfo, "url"), due: due)
    }
}

/// One notice to show: it replaces an open one with the same tag (iOS: the same request identifier).
public struct NoticeContent: Equatable {
    public var title: String
    public var body: String
    public var tag: String?
    public var url: String
    public var id: String?
    /// Bundled messages (chat notices); nil: one.
    public var count: Int?
    public var ids: [String]
    public var silent: Bool
    public var ring: Bool
    public var due: DueData?
    public var buttons: [String]
    public var ask: Bool
    /// The app icon's badge after this notice.
    public var badge: Int

    /// What the app keeps in the notification's user info (it reads it back for the next plan and for a tap).
    public var userInfo: JSONObject {
        var out: JSONObject = ["url": url]
        if let id = id { out["id"] = id }
        if let count = count { out["count"] = count }
        if !ids.isEmpty { out["ids"] = ids as [Any] }
        if let due = due { out["due"] = true; out["items"] = due.items as [Any]; out["stamp"] = Int(due.stamp) } // an Int: a property list keeps it as a number
        if ask || !buttons.isEmpty { out["ask"] = true; out["buttons"] = buttons as [Any] }
        return out
    }
}

public enum NoticeStep: Equatable {
    /// Closes the open notices of this tag (a read chat or to-do; the PC's `clear`).
    case close(tag: String)
    case show(NoticeContent)
    /// Closes the notice of this tag whose Due stamp is `stamp` after `afterMs` (a newer Due notice has its own timer).
    case closeLater(tag: String, stamp: Int64, afterMs: Int)
}

public enum NoticePlan {
    /// The steps for one push (or one local notice) given the notices open now; iOS always shows a notice (a duplicate replaces quietly).
    public static func plan(_ payload: PushPayload, open: [OpenNotice], now: Int64) -> [NoticeStep] {
        if let clear = payload.clear, !clear.isEmpty { return [.close(tag: clear)] }
        if DueNotice.isDue(payload) {
            var due = payload
            if due.url == nil { due.url = "/#/day" }
            let grouped = DueNotice.group(due, open: open.filter { $0.tag == DueNotice.tag }.flatMap { $0.due?.items ?? [] }, now: now)
            return [.show(content(grouped.payload, open: open, due: grouped.data)), .closeLater(tag: DueNotice.tag, stamp: grouped.data.stamp, afterMs: DueNotice.showMs)]
        }
        return [.show(content(payload, open: open, due: nil))]
    }

    /// The sum the badge shows: every open notice counts its bundled messages, else once (badge.ts noticeCount).
    public static func badge(_ open: [OpenNotice]) -> Int {
        var total = 0
        for notice in open { total += max(0, notice.count ?? 1) }
        return total
    }

    private static func content(_ payload: PushPayload, open all: [OpenNotice], due: DueData?) -> NoticeContent {
        let tag = payload.tag.flatMap { $0.isEmpty ? nil : $0 }
        let same = tag == nil ? [] : all.filter { $0.tag == tag }
        var ids = Set(same.flatMap { $0.ids + ($0.id.map { [$0] } ?? []) })
        let duplicate = payload.id.map { ids.contains($0) } ?? false
        var shown = payload
        if duplicate, let latest = same.last { // keep the newest preview when an older event arrives late
            shown.title = latest.title
            shown.body = latest.body
            if let id = latest.id { shown.id = id }
            if let url = latest.url { shown.url = url }
        }
        let chat = tag?.hasPrefix("chat:") == true && !payload.ring
        let count = chat ? badge(same) + (duplicate ? 0 : 1) : 1
        if let id = shown.id { ids.insert(id) }
        let silent = duplicate || payload.silent
        let others = all.filter { $0.tag == nil || $0.tag != tag }
        let buttons = Array(payload.buttons.prefix(PushPayload.maxButtons))
        return NoticeContent(title: shown.title ?? "Autark", body: shown.body ?? "", tag: tag, url: shown.url ?? "/", id: shown.id, count: count != 1 ? count : nil,
                             ids: chat && ids.count > 1 ? ids.sorted() : [], silent: silent, ring: payload.ring && !silent, due: due,
                             buttons: buttons, ask: payload.ask, badge: badge(others) + count)
    }
}

/// The buttons of a question and how a tap becomes an answer (the PC's PhoneSayAnswer: 'yes' for ✓, 'no' for ✕, else the label).
public enum NoticeAsk {
    public static let yes = "yes"
    public static let no = "no"
    /// One category per set of labels (iOS registers categories ahead of the notice; the identifier carries a hash of the labels).
    public static func category(buttons: [String]) -> String {
        if buttons.isEmpty { return "autark.ask" }
        let digest = Crypto.hex(Crypto.sha256(Crypto.utf8(buttons.joined(separator: "\u{1f}"))))
        return "autark.ask." + String(digest.prefix(16))
    }

    /// The actions of that category: (identifier, title) – ✓ and ✕ without labels, else the labels.
    public static func actions(buttons: [String]) -> [(id: String, title: String)] {
        if buttons.isEmpty { return [(yes, "✓"), (no, "✕")] }
        return buttons.prefix(PushPayload.maxButtons).enumerated().map { ("b\($0.offset)", $0.element) }
    }

    /// The answer a tapped action stands for; nil for an identifier that is none of this question's.
    public static func answer(action: String, buttons: [String]) -> String? {
        if buttons.isEmpty { return action == yes || action == no ? action : nil }
        guard action.hasPrefix("b"), let index = Int(action.dropFirst()), index >= 0, index < buttons.count, index < PushPayload.maxButtons else { return nil }
        return buttons[index]
    }
}

/// A route of a notice's `url` ("/#/chat/<id>") as the hash the page routes to – the same step the PC's worker takes on a tap
/// (`new URL(hash, home).hash`); nil when the url has no hash route or anything that could leave the page.
public enum NoticeRoute {
    public static func hash(of url: String?) -> String? {
        guard let url = url, let at = url.firstIndex(of: "#") else { return nil }
        let hash = String(url[at...])
        guard hash.count >= 2, hash.count <= 200, hash.hasPrefix("#/") else { return nil }
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-_.~:@%=&?")
        return hash.dropFirst().allSatisfy { allowed.contains($0) } && !hash.contains("..") ? hash : nil
    }
}
