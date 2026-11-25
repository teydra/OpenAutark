// Owns: Autark's App Intents for the Shortcuts app, the Action button, Back Tap (Settings › Accessibility › Touch › Back Tap runs a
// shortcut), Spotlight and Siri – "Screenshot an Autark senden" (an image in, e.g. from "Take Screenshot"; without one the newest
// screenshot of the photo library), "Antwort an Autark senden" (text), "Diktat an Autark" (opens the dictation) and "Autark öffnen"
// (a chat or home) – each with the chat as a parameter (ChatEntity: the PC's chats.list, kept in the App Group folder), and the
// AppShortcutsProvider that lists them under "Autark" without any setup. The sending ones run in the app's process without opening
// it: QuickCenter starts the connection, waits for the PC and sends (QuickSend).
// Never: sends to a chat the person did not pick or use last.
import AppIntents
import Foundation
import UniformTypeIdentifiers
import AutarkCore

struct ChatEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Chat"
    static let defaultQuery = ChatQuery()

    let id: String
    let title: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }

    init(_ chat: ChatRef) { id = chat.id; title = chat.title }

    var ref: ChatRef { ChatRef(id: id, title: title) }
}

struct ChatQuery: EntityQuery {
    func entities(for identifiers: [ChatEntity.ID]) async throws -> [ChatEntity] {
        let known = QuickCenter.inbox.chats()
        return identifiers.map { id in known.first(where: { $0.id == id }).map(ChatEntity.init) ?? ChatEntity(ChatRef(id: id, title: "Chat")) }
    }

    func suggestedEntities() async throws -> [ChatEntity] {
        await QuickCenter.chats().map(ChatEntity.init)
    }
}

struct SendScreenshotIntent: AppIntent {
    static let title: LocalizedStringResource = "Screenshot an Autark senden"
    static let openAppWhenRun = false

    @Parameter(title: "Bild")
    var image: IntentFile?

    @Parameter(title: "Chat")
    var chat: ChatEntity?

    @Parameter(title: "Text")
    var text: String?

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$image) an \(\.$chat) senden") { \.$text }
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let file: OutFile
        if let image = image {
            let type = image.type ?? UTType(filenameExtension: (image.filename as NSString).pathExtension) ?? .png
            let ext = type.preferredFilenameExtension ?? "png"
            file = OutFile(name: image.filename.isEmpty ? "screenshot." + ext : image.filename, mime: type.preferredMIMEType ?? "image/png", data: Bytes(image.data))
        } else {
            file = try await QuickCenter.newestScreenshot()
        }
        let target = try await QuickCenter.sendTarget(chat?.id)
        try await QuickCenter.send(chat: target, text: text ?? "", files: [file])
        return .result(dialog: "An \(target.title) gesendet.")
    }
}

struct QuickReplyIntent: AppIntent {
    static let title: LocalizedStringResource = "Antwort an Autark senden"
    static let openAppWhenRun = false

    @Parameter(title: "Text")
    var text: String

    @Parameter(title: "Chat")
    var chat: ChatEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$text) an \(\.$chat) senden")
    }

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let target = try await QuickCenter.sendTarget(chat?.id)
        try await QuickCenter.send(chat: target, text: text, files: [])
        return .result(dialog: "An \(target.title) gesendet.")
    }
}

struct DictateIntent: AppIntent {
    static let title: LocalizedStringResource = "Diktat an Autark"
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult {
        await QuickCenter.handle(.dictate)
        return .result()
    }
}

struct OpenChatIntent: AppIntent {
    static let title: LocalizedStringResource = "Autark öffnen"
    static let openAppWhenRun = true

    @Parameter(title: "Chat")
    var chat: ChatEntity?

    init() {}

    func perform() async throws -> some IntentResult {
        await QuickCenter.handle(.open(chat: chat?.id))
        return .result()
    }
}

struct AutarkShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: SendScreenshotIntent(), phrases: ["Screenshot an \(.applicationName) senden", "Send screenshot to \(.applicationName)"],
                    shortTitle: "Screenshot senden", systemImageName: "camera.viewfinder")
        AppShortcut(intent: QuickReplyIntent(), phrases: ["Antwort an \(.applicationName) senden", "Reply in \(.applicationName)"],
                    shortTitle: "Antwort senden", systemImageName: "text.bubble")
        AppShortcut(intent: DictateIntent(), phrases: ["Diktat an \(.applicationName)", "Dictate to \(.applicationName)"],
                    shortTitle: "Diktat", systemImageName: "mic.fill")
        AppShortcut(intent: OpenChatIntent(), phrases: ["\(.applicationName) öffnen", "Open \(.applicationName)"],
                    shortTitle: "Autark öffnen", systemImageName: "bubble.left.and.text.bubble.right")
    }
}
