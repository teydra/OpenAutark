// Owns: the app's interface file by file (owner 27.11.2026: an update of the interface fetches only the files that changed,
// the others stay) – the lists it has (the one the app carries, ui/ui.json in its bundle, and the ready ones it fetched,
// <dir>/lists/<n>.json), which list a page gets, and the look for a newer one. A list is apps/desktop/scripts/ui-list.mjs's
// ui.json {n, shell, needs, files: {<path>: {sha256, bytes}}}; a fetched one counts only when ui.json.sig (raw 64 bytes)
// verifies under one of `publicKeys` (Ed25519, as Crypto), its n is above the newest list here and its shell is not above
// `shell`. Then only the files whose sha256 is in neither the bundle nor <dir>/blobs are fetched, each to <sha256>.part,
// checked for size and sha256, synced to disk and kept as blobs/<sha256>; with every file there the list is written
// (<n>.json.part, synced, then <n>.json) and ready. A page gets the newest ready list when it starts (UiFiles calls
// pageStarts) and keeps its list while it runs; reloadDue says a newer one with other files is ready (the app loads the
// page anew at the next return to it, not while the page's voice is live). A cut fetch, no network, a wrong signature or
// hash change nothing; lists other than the running and the newest one go, and so do the blobs neither names. At most one
// look a minute; with no key none at all (the app's own interface runs). The same rules as Android's relay/UiUpdate.java:
// docs/ARCHITECTURE.md §8, "The interface updates file by file".
// Never: serves a file of a list it did not verify, writes outside its folder, or depends on UIKit.
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// One published file being read (a download): `read` gives the next bytes, an empty array at the end.
public protocol UiStream: AnyObject {
    func read(max: Int) throws -> Bytes
    func close()
}

/// The published files: ui.json, ui.json.sig, and each file by its sha256.
public protocol UiNet {
    func open(_ name: String) throws -> UiStream
}

public final class UiUpdate: UiSource {
    /// This app's bridge number: a list whose shell is above it needs a newer app (the page's SHELL, native-port.ts).
    public static let shell = 1
    /// The interface keys' public halves, base64url of their raw 32 bytes (the active one and the spare): a list counts when
    /// one of them verifies it. An empty list: no look, the app runs its own interface.
    public static let publicKeys: [String] = [
        "LdtLJGLSC54dj8bVrHxKxe4KCkYKofJMu5FvHjPfbnw", // active
        "Haes-56_0BQE7NuBsZqlQVqkRObOjRWv34weAzbuGuc", // spare
    ]
    /// Where ui.json, ui.json.sig and the files by sha256 are published: assets of the repository's latest versioned release, beside the
    /// app (the same address as Android's UiUpdate.BASE; Konrad 27.11.2026). The one place the app reads the address from.
    public static let base = "https://github.com/teydra/OpenAutark/releases/latest/download/"
    public static let listName = "ui.json", signatureName = "ui.json.sig"
    static let intervalMs: Int64 = 60_000
    static let maxList = 1 << 20
    static let maxFile = 32 << 20, maxTotal = 128 << 20

    struct Entry: Equatable {
        let sha: String
        let bytes: Int
    }

    final class Listing {
        let n: Int, shell: Int, files: [String: Entry], raw: Bytes
        init(n: Int, shell: Int, files: [String: Entry], raw: Bytes) { self.n = n; self.shell = shell; self.files = files; self.raw = raw }
    }

    private let blobs: URL, lists: URL
    private let shipped: UiSource
    private let keys: [Bytes]
    private let shellNumber: Int
    /// The app's list (nil in a build without ui.json: then its files answer by path and nothing is fetched).
    private let packaged: Listing?
    private var packagedBySha = [String: String]()
    private let lock = NSRecursiveLock()
    private var fetching = false
    private var current: Listing?, newest: Listing? // guarded by lock
    private var checkedAt: Int64 = 0
    private var checked = false

    /// The store in `dir` over the app's interface `shipped`; `keys` are the raw public keys (see `decodedKeys`).
    public init(dir: URL, shipped: UiSource, keys: [Bytes], shell: Int = UiUpdate.shell) {
        self.shipped = shipped
        self.keys = keys
        self.shellNumber = shell
        blobs = dir.appendingPathComponent("blobs", isDirectory: true)
        lists = dir.appendingPathComponent("lists", isDirectory: true)
        var own: Listing?
        if let raw = shipped.read(UiUpdate.listName) { own = UiUpdate.parse(raw) }
        packaged = own
        if let own = own { for (path, entry) in own.files { packagedBySha[entry.sha] = path } }
        newest = own
        if let own = own, let saved = try? FileManager.default.contentsOfDirectory(atPath: lists.path) {
            for name in saved.sorted() {
                guard name.hasSuffix(".json") else { continue } // a <n>.json.part the app was killed on is not ready; it goes
                guard let data = FileManager.default.contents(atPath: lists.appendingPathComponent(name).path),
                      let list = UiUpdate.parse(Bytes(data)) else { continue }
                if list.n > (newest ?? own).n && list.shell <= shell && complete(list) { newest = list }
            }
        }
        current = newest
        lock.lock(); prune(files: true); lock.unlock()
    }

    /// `publicKeys` as raw 32-byte keys; one that does not decode to 32 bytes is left out.
    public static func decodedKeys(_ texts: [String] = UiUpdate.publicKeys) -> [Bytes] {
        texts.compactMap { text in Crypto.fromB64url(text).flatMap { $0.count == 32 ? $0 : nil } }
    }

    /// A file of the running page's list (UiSource); nil when the list has no such path.
    public func read(_ path: String) -> Bytes? {
        lock.lock(); let page = current; lock.unlock()
        guard let list = page else { return shipped.read(path) }
        guard let entry = list.files[path] else { return nil }
        return bytes(of: entry)
    }

    /// A page starts: from now on it gets the newest ready list (UiFiles, on a document request).
    public func pageStarts() {
        lock.lock(); defer { lock.unlock() }
        if current === newest { return }
        current = newest
        prune(files: !fetching)
    }

    /// True when a newer list with other files is ready than the one the running page started with.
    public var reloadDue: Bool {
        lock.lock(); defer { lock.unlock() }
        guard let next = newest, let now = current else { return false }
        return next !== now && next.files != now.files
    }

    /// True when a look is due: a key, a list in the app, and a minute since the last look (or the clock went back).
    public func due(now: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !keys.isEmpty && packaged != nil && (!checked || now < checkedAt || now - checkedAt >= UiUpdate.intervalMs)
    }

    /// Looks for a newer list and fetches what it lacks (call it off the main thread); true when a new list is ready.
    @discardableResult
    public func check(net: UiNet, now: Int64) -> Bool {
        lock.lock()
        if !due(now: now) { lock.unlock(); return false }
        checked = true
        checkedAt = now
        if fetching { lock.unlock(); return false }
        fetching = true
        let above = newest?.n ?? 0
        lock.unlock()
        defer { lock.lock(); fetching = false; lock.unlock() }
        do {
            let raw = try UiUpdate.get(net, UiUpdate.listName, max: UiUpdate.maxList)
            let signature = try UiUpdate.get(net, UiUpdate.signatureName, max: 64)
            guard let list = UiUpdate.accept(raw, signature: signature, keys: keys, above: above, shell: shellNumber) else { return false }
            var wanted = Set<String>()
            for entry in list.files.values where !has(entry.sha) && wanted.insert(entry.sha).inserted { try fetch(net, entry) }
            lock.lock(); defer { lock.unlock() }
            if !complete(list) || list.n <= (newest?.n ?? 0) { return false } // a file went meanwhile, or another look won
            try? FileManager.default.createDirectory(at: lists, withIntermediateDirectories: true)
            let part = lists.appendingPathComponent("\(list.n).json.part"), ready = lists.appendingPathComponent("\(list.n).json")
            try write(Data(list.raw), to: part)
            try? FileManager.default.removeItem(at: ready)
            do { try FileManager.default.moveItem(at: part, to: ready) } catch { try? FileManager.default.removeItem(at: part); return false }
            newest = list
            prune(files: true)
            return true
        } catch {
            return false // the app keeps what it has; the next look tries again
        }
    }

    /// The list `raw` when `signature` verifies under one of `keys`, its n is above `above` and its shell at most `shell`; else nil.
    static func accept(_ raw: Bytes, signature: Bytes, keys: [Bytes], above: Int, shell: Int) -> Listing? {
        guard keys.contains(where: { Crypto.verify(publicKey: $0, message: raw, signature: signature) }) else { return nil }
        guard let list = parse(raw), list.n > above, list.shell <= shell else { return nil }
        return list
    }

    /// A well-formed list (index.html among safe paths, lower-case sha256, sizes in bounds), else nil.
    static func parse(_ raw: Bytes) -> Listing? {
        guard let text = String(bytes: raw, encoding: .utf8), let list = try? Json.object(text) else { return nil }
        let n = Json.num(list, "n", -1), shell = Json.num(list, "shell", -1)
        guard n > 0, shell >= 1, let described = list["files"] as? JSONObject else { return nil }
        var files = [String: Entry]()
        var total = 0
        for (path, value) in described {
            guard UiFiles.safe(path), let about = value as? JSONObject, let sha = Json.str(about, "sha256"), isSha(sha) else { return nil }
            let bytes = Json.num(about, "bytes", -1)
            total += max(bytes, 0)
            if bytes < 0 || bytes > maxFile || total > maxTotal { return nil }
            files[path] = Entry(sha: sha, bytes: bytes)
        }
        return files["index.html"] != nil ? Listing(n: n, shell: shell, files: files, raw: raw) : nil
    }

    private static func isSha(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    private func has(_ sha: String) -> Bool {
        packagedBySha[sha] != nil || FileManager.default.fileExists(atPath: blobs.appendingPathComponent(sha).path)
    }

    private func complete(_ list: Listing) -> Bool { list.files.values.allSatisfy { has($0.sha) } }

    private func bytes(of entry: Entry) -> Bytes? {
        if let data = FileManager.default.contents(atPath: blobs.appendingPathComponent(entry.sha).path) { return Bytes(data) }
        return packagedBySha[entry.sha].flatMap { shipped.read($0) }
    }

    private func write(_ data: Data, to file: URL) throws {
        guard FileManager.default.createFile(atPath: file.path, contents: nil), let handle = FileHandle(forWritingAtPath: file.path) else { throw AutarkError("no file") }
        defer { try? handle.close() }
        try handle.write(contentsOf: data)
        try handle.synchronize() // on the disk before the rename: a power cut never leaves a ready name over unwritten bytes
    }

    /// One file to blobs/<sha256>.part, then – exactly its size and sha256 – blobs/<sha256>; otherwise an error.
    private func fetch(_ net: UiNet, _ entry: Entry) throws {
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        let part = blobs.appendingPathComponent(entry.sha + ".part"), target = blobs.appendingPathComponent(entry.sha)
        try? FileManager.default.removeItem(at: part)
        guard FileManager.default.createFile(atPath: part.path, contents: nil), let handle = FileHandle(forWritingAtPath: part.path) else { throw AutarkError("no file") }
        var hasher = SHA256()
        var read = 0
        do {
            let stream = try net.open(entry.sha)
            defer { stream.close() }
            while true {
                let chunk = try stream.read(max: 64 * 1024)
                if chunk.isEmpty { break }
                read += chunk.count
                if read > entry.bytes { break }
                hasher.update(data: chunk)
                try handle.write(contentsOf: Data(chunk))
            }
            try handle.synchronize() // on the disk before the rename
            try handle.close()
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: part)
            throw error
        }
        let digest = Crypto.hex(Bytes(hasher.finalize()))
        if read != entry.bytes || digest != entry.sha {
            try? FileManager.default.removeItem(at: part)
            throw AutarkError("file \(entry.sha) is not what the list names")
        }
        try? FileManager.default.removeItem(at: target)
        do { try FileManager.default.moveItem(at: part, to: target) } catch { try? FileManager.default.removeItem(at: part); throw error }
    }

    /// A small published file, at most `max` bytes.
    private static func get(_ net: UiNet, _ name: String, max: Int) throws -> Bytes {
        let stream = try net.open(name)
        defer { stream.close() }
        var out = Bytes()
        while true {
            let chunk = try stream.read(max: 16 * 1024)
            if chunk.isEmpty { return out }
            out.append(contentsOf: chunk)
            if out.count > max { throw AutarkError("\(name) is too large") }
        }
    }

    /// Lists other than the running and the newest go; with `files`, every blob (and .part) neither of them names.
    private func prune(files: Bool) {
        var keepLists = Set<String>(), keepFiles = Set<String>()
        for list in [current, newest] {
            guard let list = list, list !== packaged else { continue }
            keepLists.insert("\(list.n).json")
            for entry in list.files.values { keepFiles.insert(entry.sha) }
        }
        let manager = FileManager.default
        if let saved = try? manager.contentsOfDirectory(atPath: lists.path) {
            for name in saved where !keepLists.contains(name) { try? manager.removeItem(at: lists.appendingPathComponent(name)) }
        }
        if files, let kept = try? manager.contentsOfDirectory(atPath: blobs.path) {
            for name in kept where !keepFiles.contains(name) { try? manager.removeItem(at: blobs.appendingPathComponent(name)) }
        }
    }

    /// For a test: the n of the running page's list and of the newest ready one (0: none).
    func ns() -> (current: Int, newest: Int) {
        lock.lock(); defer { lock.unlock() }
        return (current?.n ?? 0, newest?.n ?? 0)
    }
}
