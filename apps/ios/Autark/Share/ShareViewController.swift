// Owns: the share extension "AutarkShare" – "Autark" in the share sheet of any app for images, text and links (the Android app's
// "Share to Autark", B-084): the person picks the chat (the list the app last read from the PC, kept in the App Group folder), may add
// a line, and taps Send. The extension has no channel to the PC of its own (that would need the pairing keys in a shared keychain, i.e.
// a signed build), so it leaves the post in the App Group inbox (ShareInbox) and the app sends it over its own socket the next time it
// is connected (AppModel: UseLink up → QuickCenter.sendInbox) – the card says so.
// Never: sends to a chat the person did not pick, or keeps more than the shared items.
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import AutarkCore

final class ShareViewController: UIViewController {
    private static let appGroup = "group.com.teydralab.autark"

    override func viewDidLoad() {
        super.viewDidLoad()
        let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareViewController.appGroup)?.appendingPathComponent("Autark", isDirectory: true)
        let inbox = folder.map { ShareInbox(folder: $0) }
        let host = UIHostingController(rootView: ShareCard(inbox: inbox, chats: inbox?.chats() ?? [], items: extensionContext?.inputItems as? [NSExtensionItem] ?? [],
                                                           done: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
                                                           cancel: { [weak self] in self?.extensionContext?.cancelRequest(withError: NSError(domain: "Autark", code: 0)) }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

struct ShareCard: View {
    let inbox: ShareInbox?
    let chats: [ChatRef]
    let items: [NSExtensionItem]
    let done: () -> Void
    let cancel: () -> Void

    @State private var chat: ChatRef?
    @State private var text = ""
    @State private var files = [OutFile]()
    @State private var line = ""
    @State private var busy = true

    var body: some View {
        NavigationStack {
            Form {
                Section("Chat") {
                    if chats.isEmpty {
                        Text("Open Autark once while it is connected to your PC – then your chats are listed here.").foregroundStyle(.secondary)
                    } else {
                        Picker("Chat", selection: $chat) {
                            ForEach(chats) { one in Text(one.title).tag(Optional(one)) }
                        }
                    }
                }
                Section("Text") {
                    TextField("Add a line (optional)", text: $text, axis: .vertical).lineLimit(1...6)
                }
                if !files.isEmpty {
                    Section("Files") { ForEach(Array(files.enumerated()), id: \.offset) { _, file in Label(file.name, systemImage: file.mime.hasPrefix("image") ? "photo" : "doc") } }
                }
                Section { Text(line.isEmpty ? "Autark sends this as soon as the app is connected to your PC." : line).font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("Autark")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send", action: send).disabled(busy || chat == nil || inbox == nil || (text.isEmpty && files.isEmpty))
                }
            }
            .task { await load() }
        }
    }

    private func send() {
        guard let inbox = inbox, let chat = chat else { return }
        do {
            try inbox.put(chat: chat, text: text, files: files)
            done()
        } catch {
            line = "Autark could not keep this: " + error.localizedDescription
        }
    }

    /// The shared items: images as files, links and text into the line.
    private func load() async {
        chat = chats.first
        if inbox == nil { line = "This build has no shared App Group (unsigned): sharing works once the app is signed." }
        var texts = [String]()
        var loaded = [OutFile]()
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), let file = await ShareCard.image(provider) {
                    loaded.append(file)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = await ShareCard.value(provider, UTType.url) as? URL {
                    texts.append(url.absoluteString)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let words = await ShareCard.value(provider, UTType.plainText) as? String {
                    texts.append(words)
                }
            }
        }
        files = Array(loaded.prefix(10))
        text = texts.joined(separator: "\n")
        busy = false
    }

    private static func image(_ provider: NSItemProvider) async -> OutFile? {
        let type = provider.registeredTypeIdentifiers.compactMap { UTType($0) }.first { $0.conforms(to: .image) } ?? .jpeg
        return await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                guard let data = data else { continuation.resume(returning: nil); return }
                let ext = type.preferredFilenameExtension ?? "jpg"
                continuation.resume(returning: OutFile(name: (provider.suggestedName ?? "image") + "." + ext, mime: type.preferredMIMEType ?? "image/jpeg", data: Bytes(data)))
            }
        }
    }

    private static func value(_ provider: NSItemProvider, _ type: UTType) async -> Any? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { value, _ in continuation.resume(returning: value) }
        }
    }
}
