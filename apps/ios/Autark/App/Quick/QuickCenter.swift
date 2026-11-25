// Owns: the app's side of every quick way in – the Live Activity's buttons (answer, Pause / Continue / Stop), the Control Center and
// Lock Screen buttons (open, newest screenshot, dictation), the App Intents of Shortcuts / Action button / Back Tap / Siri (send a
// screenshot, a reply, open a chat) and the share extension's posts – each over the app's own socket to the PC (AppModel.useLink, the
// core's UseLink): it starts the connection when iOS launched the app in the background for an intent, waits until the PC answered
// attach, then sends (QuickSend). The last chat a post went to is remembered (the default of the next one) and the chat list is kept in
// the App Group folder for the share extension's pick (ShareInbox; without a signed App Group the app's own folder).
// Never: sends without a chat, or reads the photo library before the person allowed it once in the app.
import Foundation
import Photos
import UIKit
import AutarkCore

enum QuickCenter {
    static let appGroup = "group.com.teydralab.autark"
    /// How long an intent waits for the PC (iOS gives a background intent about 30 s).
    static let linkMs = 20_000

    /// The App Group folder the share extension sees; the app's own Application Support folder when the App Group is missing
    /// (unsigned simulator builds: the extension then cannot reach the app's posts).
    static var folder: URL {
        if let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) { return shared.appendingPathComponent("Autark", isDirectory: true) }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("Shared", isDirectory: true)
    }

    static var inbox: ShareInbox { ShareInbox(folder: folder) }

    // MARK: the last chat

    private static let lastKey = "autark.quick.lastChat"

    static var lastChat: ChatRef? {
        get { UserDefaults.standard.data(forKey: lastKey).flatMap { try? JSONDecoder().decode(ChatRef.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: lastKey) }
    }

    // MARK: commands of the shared intents (QuickBridge)

    static func handle(_ command: QuickCommand) async {
        switch command {
        case .answer(let job, let label):
            let model = await linkedModel()
            await MainActor.run { _ = model?.responder?.answer(job: job, label: label) }
        case .control(let job, let action):
            let model = await linkedModel()
            await MainActor.run { model?.control(job: job, action: action) }
        case .open(let chat):
            await MainActor.run { AppModel.shared.openChat(chat) }
        case .screenshot:
            await MainActor.run { AppModel.shared.openChat(lastChat?.id) }
            do {
                let shot = try await newestScreenshot()
                let chat = try await sendTarget(nil)
                try await send(chat: chat, text: "", files: [shot])
                await MainActor.run { AppModel.shared.quickNote = "Screenshot sent to \(chat.title)." }
            } catch {
                await MainActor.run { AppModel.shared.quickNote = (error as? AutarkError)?.message ?? error.localizedDescription }
            }
        case .dictate:
            await MainActor.run { AppModel.shared.ensureStarted(); AppModel.shared.dictating = true }
        }
    }

    /// The app's model with its socket up (started when iOS launched the app for this), or nil when the PC did not answer in time.
    static func linkedModel() async -> AppModel? {
        let link = await MainActor.run { () -> UseLink? in AppModel.shared.ensureStarted(); return AppModel.shared.useLink }
        guard let link = link else { return nil }
        let up = await Task.detached { link.waitLinked(timeoutMs: linkMs) }.value
        if !up { return nil }
        return await MainActor.run { AppModel.shared }
    }

    /// The socket to the PC, up; throws when there is none.
    static func caller() async throws -> UseLink {
        guard let model = await linkedModel(), let link = await MainActor.run(body: { model.useLink }) else {
            throw AutarkError("Autark could not reach your PC. Open the app once it is paired and online.")
        }
        return link
    }

    /// The chats for the pick (from the PC, kept for the share extension; the kept list when the PC is out of reach).
    static func chats() async -> [ChatRef] {
        if let link = try? await caller(), let fresh = try? await Task.detached(operation: { try QuickSend.fetchChats(link) }).value, !fresh.isEmpty {
            inbox.saveChats(fresh)
            return fresh
        }
        return inbox.chats()
    }

    /// The chat to send to: the one given, else the last one, else the first of the list.
    static func sendTarget(_ id: String?) async throws -> ChatRef {
        if let id = id {
            if let known = (inbox.chats() + [lastChat].compactMap { $0 }).first(where: { $0.id == id }) { return known }
            return ChatRef(id: id, title: "Chat")
        }
        if let last = lastChat { return last }
        if let first = await chats().first { return first }
        throw AutarkError("Pick a chat first – Autark knows none yet.")
    }

    /// Sends `text` and `files` into `chat` over the app's socket; the chat becomes the default of the next post.
    static func send(chat: ChatRef, text: String, files: [OutFile]) async throws {
        let link = try await caller()
        let id = QuickSend.clientId()
        try await Task.detached { try QuickSend.send(link, chat: chat.id, text: text, files: files, clientId: id) }.value
        lastChat = chat
    }

    /// The share extension's posts, sent in order (after the socket came up).
    static func sendInbox(_ link: UseLink) {
        let box = inbox
        if box.posts().isEmpty { return }
        spawn("autark-share-inbox") { box.sendAll(link) }
    }

    // MARK: the newest screenshot

    /// The newest screenshot of the photo library as PNG/JPEG bytes. Asks for read access once (only in the foreground).
    static func newestScreenshot() async throws -> OutFile {
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined { status = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
        guard status == .authorized || status == .limited else { throw AutarkError("Allow Autark to read your photos to send the newest screenshot.") }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "(mediaSubtypes & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 1
        guard let asset = PHAsset.fetchAssets(with: .image, options: options).firstObject else { throw AutarkError("There is no screenshot on this phone yet.") }
        let request = PHImageRequestOptions()
        request.isNetworkAccessAllowed = true
        request.deliveryMode = .highQualityFormat
        request.isSynchronous = false
        return try await withCheckedThrowingContinuation { continuation in
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: request) { data, type, _, _ in
                guard let data = data else { continuation.resume(throwing: AutarkError("The screenshot could not be read.")); return }
                let png = (type ?? "").contains("png")
                continuation.resume(returning: OutFile(name: png ? "screenshot.png" : "screenshot.jpg", mime: png ? "image/png" : "image/jpeg", data: Bytes(data)))
            }
        }
    }
}
