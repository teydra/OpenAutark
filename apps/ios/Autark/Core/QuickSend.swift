// Owns: what the iPhone's quick ways in (App Intents "Screenshot an Autark senden" / "Antwort an Autark senden" / "Diktat an Autark",
// the share extension, the Control Center button) send to the PC, as pure frames over the app's own socket (UseLink, a RpcCaller):
// the chat list for the pick (`chats.list` → ChatRef: not archived, no threads, pinned first, then the newest), a file up (`files.upload`
// for up to 2 MiB, else `files.uploadChunk` in 2 MiB pieces of one upload id "up_…" into that chat, as the web composer does), and the
// message with its attachments (`messages.send {conversationId, body, attachments, clientId}` – the client id is made once per post,
// so a retry after a lost answer makes no second message). The same calls and limits as the phone page (apps/desktop: methods.ts
// chats.list / files.upload / files.uploadChunk / messages.send, rpc/uploads.ts CHUNK_MAX_BYTES 4 MB). Pure Foundation (Linux tests).
// Never: sends without a chat, or puts the person's text anywhere but messages.send's body.
import Foundation

/// A chat the person can send to.
public struct ChatRef: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let pinned: Bool
    /// Milliseconds since 1970 of its last message (0: none).
    public let lastAt: Int64

    public init(id: String, title: String, pinned: Bool = false, lastAt: Int64 = 0) {
        self.id = id; self.title = title; self.pinned = pinned; self.lastAt = lastAt
    }
}

/// One file to send: its bytes, name and type.
public struct OutFile: Equatable {
    public let name: String
    public let mime: String
    public let data: Bytes
    public init(name: String, mime: String, data: Bytes) { self.name = name; self.mime = mime; self.data = data }
}

public enum QuickSend {
    /// Up to this size one files.upload carries the file; above it goes in pieces of this size (the PC takes ≤ 4 MB each).
    public static let pieceBytes = 2 * 1024 * 1024
    /// The most chats the pick shows.
    public static let chatsMax = 60
    public static let callMs = 30_000

    /// The chats of chats.list's result for the pick: not archived, no threads (settings.anchorId), pinned first, then the newest.
    public static func chats(_ result: Any?) -> [ChatRef] {
        guard let rows = result as? [Any] else { return [] }
        var out = [ChatRef]()
        for case let row as JSONObject in rows {
            guard let id = Json.str(row, "id"), !id.isEmpty else { continue }
            if row["archivedAt"] is Double || row["archivedAt"] is Int { continue }
            if let settings = row["settings"] as? JSONObject, let anchor = Json.str(settings, "anchorId"), !anchor.isEmpty { continue }
            let title = LiveState.oneLine(Json.str(row, "title") ?? "")
            let last = (row["lastMessageAt"] as? Double).map { Int64($0) } ?? (row["lastMessageAt"] as? Int).map { Int64($0) } ?? 0
            out.append(ChatRef(id: id, title: title.isEmpty ? "Chat" : title, pinned: row["pinned"] as? Bool ?? false, lastAt: last))
        }
        out.sort { a, b in a.pinned != b.pinned ? a.pinned : (a.lastAt != b.lastAt ? a.lastAt > b.lastAt : a.title < b.title) }
        return Array(out.prefix(chatsMax))
    }

    /// files.upload's params.
    public static func upload(_ file: OutFile) -> JSONObject {
        ["name": file.name, "mime": file.mime, "dataBase64": Crypto.b64Std(file.data)]
    }

    /// The files.uploadChunk params of `file` into `chat`: pieces of pieceBytes, in order, the last with final: true.
    public static func pieces(_ file: OutFile, uploadId: String, chat: String?) -> [JSONObject] {
        var out = [JSONObject]()
        var start = 0
        var index = 0
        repeat {
            let end = min(file.data.count, start + pieceBytes)
            var piece: JSONObject = ["uploadId": uploadId, "index": index, "dataBase64": Crypto.b64Std(Array(file.data[start..<end])), "name": file.name, "mime": file.mime]
            if end >= file.data.count { piece["final"] = true }
            if let chat = chat { piece["conversationId"] = chat }
            out.append(piece)
            start = end
            index += 1
        } while start < file.data.count
        return out
    }

    /// A new upload id the PC accepts (`up_` and 24 lowercase letters/digits).
    public static func uploadId() -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return "up_" + String(Crypto.random(24).map { alphabet[Int($0) % alphabet.count] })
    }

    /// The attachment for messages.send from a stored file (FileRef {id, name, mime, size, width?, height?, durationMs?}); nil without id.
    public static func attachment(_ fileRef: Any?) -> JSONObject? {
        guard let ref = fileRef as? JSONObject, let id = Json.str(ref, "id") ?? Json.str(ref, "fileId"), !id.isEmpty else { return nil }
        var out: JSONObject = ["fileId": id, "name": Json.str(ref, "name") ?? "file", "mime": Json.str(ref, "mime") ?? "application/octet-stream",
                               "size": Json.num(ref, "size", 0)]
        for key in ["width", "height", "durationMs"] where Json.num(ref, key, -1) >= 0 { out[key] = Json.num(ref, key, 0) }
        return out
    }

    /// messages.send's params.
    public static func message(chat: String, text: String, attachments: [JSONObject], clientId: String) -> JSONObject {
        var out: JSONObject = ["conversationId": chat, "body": text, "clientId": clientId]
        if !attachments.isEmpty { out["attachments"] = attachments as [Any] }
        return out
    }

    /// A client id for one post (made once, the same on every retry of it).
    public static func clientId() -> String { "ios-" + Crypto.b64url(Crypto.random(12)) }

    /// The chats for the pick, from the PC.
    public static func fetchChats(_ caller: RpcCaller) throws -> [ChatRef] {
        chats(try caller.request("chats.list", [:], timeoutMs: callMs))
    }

    /// Stores `file` on the PC (one call or pieces) and returns its attachment.
    public static func store(_ caller: RpcCaller, _ file: OutFile, chat: String) throws -> JSONObject {
        var ref: Any?
        if file.data.count <= pieceBytes {
            ref = try caller.request("files.upload", upload(file), timeoutMs: callMs * 2)
        } else {
            for piece in pieces(file, uploadId: uploadId(), chat: chat) {
                let answer = try caller.request("files.uploadChunk", piece, timeoutMs: callMs * 2)
                if piece["final"] as? Bool == true { ref = (answer as? JSONObject)?["file"] }
            }
        }
        guard let attachment = attachment(ref) else { throw AutarkError("The PC did not keep the file.") }
        return attachment
    }

    /// Sends `text` with `files` into `chat`: every file up, then one message; returns the message id ("" when the PC named none).
    @discardableResult
    public static func send(_ caller: RpcCaller, chat: String, text: String, files: [OutFile], clientId: String) throws -> String {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty && files.isEmpty { throw AutarkError("Nothing to send.") }
        var attachments = [JSONObject]()
        for file in files { attachments.append(try store(caller, file, chat: chat)) }
        let sent = try caller.request("messages.send", message(chat: chat, text: body, attachments: attachments, clientId: clientId), timeoutMs: callMs)
        return (sent as? JSONObject).flatMap { Json.str($0, "id") } ?? ""
    }
}

/// What the share extension leaves for the app (App Group folder): one post – the chat picked, the text, the files – sent by the app
/// over its own connection the next time it runs (the extension has no channel to the PC of its own).
public struct SharedPost: Codable, Equatable, Identifiable {
    public struct File: Codable, Equatable {
        public let name: String
        public let mime: String
        /// The file's name in the inbox folder.
        public let stored: String
        public init(name: String, mime: String, stored: String) { self.name = name; self.mime = mime; self.stored = stored }
    }

    public let id: String
    public let chat: ChatRef
    public let text: String
    public let files: [File]
    public let at: Int64
    public let clientId: String

    public init(id: String, chat: ChatRef, text: String, files: [File], at: Int64, clientId: String) {
        self.id = id; self.chat = chat; self.text = text; self.files = files; self.at = at; self.clientId = clientId
    }
}

/// The App Group folder the app and its extensions share: the chat list for the pick (chats.json) and the shared posts (inbox/).
public final class ShareInbox {
    public let folder: URL
    private let fm = FileManager.default

    public init(folder: URL) { self.folder = folder }

    private var inbox: URL { folder.appendingPathComponent("inbox", isDirectory: true) }

    /// The chats the app last read from the PC (the extension's pick works without a connection).
    public func saveChats(_ chats: [ChatRef]) {
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(chats) { try? data.write(to: folder.appendingPathComponent("chats.json"), options: .atomic) }
    }

    public func chats() -> [ChatRef] {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("chats.json")) else { return [] }
        return (try? JSONDecoder().decode([ChatRef].self, from: data)) ?? []
    }

    /// Leaves a post: its files beside it, then the post (a post never names a file that is not there yet).
    @discardableResult
    public func put(chat: ChatRef, text: String, files: [OutFile], now: Int64 = Clock.nowMs()) throws -> SharedPost {
        let id = "s" + String(now) + "-" + Crypto.b64url(Crypto.random(6))
        let dir = inbox.appendingPathComponent(id, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var stored = [SharedPost.File]()
        for (index, file) in files.enumerated() {
            let name = "\(index)-" + ShareInbox.safe(file.name)
            try Data(file.data).write(to: dir.appendingPathComponent(name), options: .atomic)
            stored.append(SharedPost.File(name: file.name, mime: file.mime, stored: name))
        }
        let post = SharedPost(id: id, chat: chat, text: text, files: stored, at: now, clientId: QuickSend.clientId())
        try JSONEncoder().encode(post).write(to: dir.appendingPathComponent("post.json"), options: .atomic)
        return post
    }

    /// The posts left, oldest first.
    public func posts() -> [SharedPost] {
        guard let names = try? fm.contentsOfDirectory(atPath: inbox.path) else { return [] }
        return names.compactMap { name -> SharedPost? in
            guard let data = try? Data(contentsOf: inbox.appendingPathComponent(name).appendingPathComponent("post.json")) else { return nil }
            return try? JSONDecoder().decode(SharedPost.self, from: data)
        }.sorted { $0.at < $1.at }
    }

    /// A post's files with their bytes.
    public func files(of post: SharedPost) -> [OutFile] {
        post.files.compactMap { file in
            guard let data = try? Data(contentsOf: inbox.appendingPathComponent(post.id).appendingPathComponent(file.stored)) else { return nil }
            return OutFile(name: file.name, mime: file.mime, data: Bytes(data))
        }
    }

    /// The post went through (or the person dropped it): its folder goes.
    public func remove(_ post: SharedPost) { try? fm.removeItem(at: inbox.appendingPathComponent(post.id)) }

    /// Sends every post left (oldest first) over `caller`; a post that fails stays for the next time. Returns how many went.
    @discardableResult
    public func sendAll(_ caller: RpcCaller) -> Int {
        var sent = 0
        for post in posts() {
            do {
                try QuickSend.send(caller, chat: post.chat.id, text: post.text, files: files(of: post), clientId: post.clientId)
                remove(post)
                sent += 1
            } catch {
                break // the link is gone or the PC refused: the rest waits too, in order
            }
        }
        return sent
    }

    static func safe(_ name: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        let cleaned = String(name.map { allowed.contains($0) ? $0 : "_" }.prefix(80))
        return cleaned.isEmpty ? "file" : cleaned
    }
}
