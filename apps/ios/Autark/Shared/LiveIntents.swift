// Owns: what the app and its widget extension share for the Live Activity and the Control Center / Lock Screen buttons – the
// ActivityKit attributes (the content is the core's LiveState, the contract's JSON), the activity's buttons as LiveActivityIntents
// (✓ / ✕ / the AI's labels, Pause / Continue / Stop: iOS runs them in the app's process, launched in the background when needed),
// the three button intents of the controls and the Lock Screen widget (open Autark, send the newest screenshot, dictate: they open
// the app), and the one seam both processes see: QuickBridge, which only the app fills (AppDelegate) – in the extension it stays
// empty, so a button never acts there.
// Never: talks to the PC itself (the app does, AppModel / LiveCenter), or keeps state.
import ActivityKit
import AppIntents
import Foundation
import AutarkCore

/// The Live Activity "<agent> is using this phone": fixed attributes (this iPhone's name), the content changes (LiveState).
struct AutarkAgentActivityAttributes: ActivityAttributes {
    typealias ContentState = LiveState
    var device: String
}

/// What a button of the activity or a control asks the app to do.
enum QuickCommand: Equatable {
    case answer(job: String, label: String)
    case control(job: String, action: String)
    case open(chat: String?)
    case screenshot
    case dictate
}

/// The app's handler for QuickCommand (set in the app process at launch; nil in the widget extension).
enum QuickBridge {
    static var handler: ((QuickCommand) async -> Void)?

    static func run(_ command: QuickCommand) async {
        guard let handler = handler else { return }
        await handler(command)
    }
}

/// ✓ / ✕ / one of the AI's labels on the activity: the answer to the waiting question (phoneUse.reply on the PC).
struct LiveAnswerIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Answer the AI"
    static let isDiscoverable = false

    @Parameter(title: "Run") var job: String
    @Parameter(title: "Answer") var label: String

    init() {}
    init(job: String, label: String) { self.job = job; self.label = label }

    func perform() async throws -> some IntentResult {
        await QuickBridge.run(.answer(job: job, label: label))
        return .result()
    }
}

/// Pause / Continue / Stop on the activity: phoneUse.control {job, action} on the PC.
struct LiveControlIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Pause or stop the AI"
    static let isDiscoverable = false

    @Parameter(title: "Run") var job: String
    @Parameter(title: "Action") var action: String

    init() {}
    init(job: String, action: String) { self.job = job; self.action = action }

    func perform() async throws -> some IntentResult {
        await QuickBridge.run(.control(job: job, action: action))
        return .result()
    }
}

/// "Autark öffnen" – the Control Center button and the Lock Screen widget.
struct OpenAutarkIntent: AppIntent {
    static let title: LocalizedStringResource = "Autark öffnen"
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult {
        await QuickBridge.run(.open(chat: nil))
        return .result()
    }
}

/// "Screenshot senden" – the Control Center button: opens Autark, which sends the newest screenshot of the photo library to the
/// last chat (a control cannot take a screenshot itself; the Shortcuts way with "Take Screenshot" sends without opening the app).
struct ScreenshotControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Letzten Screenshot an Autark senden"
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult {
        await QuickBridge.run(.screenshot)
        return .result()
    }
}

/// "Diktat" – the Control Center button: opens Autark's dictation (record, the PC transcribes, the text goes to the last chat).
struct DictateControlIntent: AppIntent {
    static let title: LocalizedStringResource = "Diktat an Autark"
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult {
        await QuickBridge.run(.dictate)
        return .result()
    }
}
