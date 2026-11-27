// Owns: the app's own interface on the company's origin (owner 27.11.2026: the phone carries its interface, nothing of it
// comes from a PC) – which requests are the interface's (a GET or HEAD outside the PC's data paths, `dataPaths`) and their
// answer from the app's copy of apps/desktop/app/ui (the bundle's `ui` folder, Tools/build-ui.sh), at once and without a
// channel: the type by extension (the table of shared/files/mime.ts), the page's content security policy on HTML (APP_CSP of
// runtime/http/static.ts), no-cache for the shell and immutable for esbuild's content-hashed files, index.html for a
// navigation path without an extension, 404 for any other missing file. /sw.js is the one piece for what an older version
// left on the phone: the PC-served page registered a service worker that keeps answering its cached interface; this one
// deletes every cache, unregisters itself and loads the open pages once more (only when it found a cache). A document
// request tells the source that a page starts (UiUpdate then gives that page the newest ready interface list; the running
// page keeps its own). Ported from relay/UiFiles.java; the rules: docs/ARCHITECTURE.md §8.
// Never: reads outside its source (no dotfiles, no '..'), answers a data path, or waits for a PC.
import Foundation

/// The interface's files by path below it ("index.html", "chunks/x-ABCDEFGH.js"); nil when there is no such file.
public protocol UiSource: AnyObject {
    func read(_ path: String) -> Bytes?
    /// A page starts (a document request): UiUpdate gives it the newest ready list from here on.
    func pageStarts()
}

public final class UiFiles {
    /// First path segments that are the PC's (runtime/http/server.ts and static.ts's /turn/): they go through a channel.
    public static let dataPaths: Set<String> = ["ws", "rpc", "events", "mcp", "files", "sandbox", "turn", "peer", ".well-known"]
    /// The page's policy, as the PC sent it for index.html (runtime/http/static.ts APP_CSP).
    static let appCsp = [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self' ws: wss: blob: https://firestore.googleapis.com",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
    ].joined(separator: "; ")
    /// esbuild content hashes: chunks/name-ABCDEFGH.js, font-ABCDEFGH.woff2.
    private static let hashed = try! NSRegularExpression(pattern: "-[A-Z0-9]{8}\\.[a-z0-9]+$")
    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json; charset=utf-8", "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
        "gif": "image/gif", "ico": "image/x-icon", "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf",
        "map": "application/json; charset=utf-8", "txt": "text/plain; charset=utf-8", "wasm": "application/wasm",
        "mp3": "audio/mpeg", "wav": "audio/wav",
    ]
    /// Ends the PC-served page's service worker on a phone that still has it (see the header).
    static let retireWorker = [
        "// Autark for iPhone: the interface is in the app now; this ends the service worker an older version left here.",
        "self.addEventListener('install', () => self.skipWaiting());",
        "self.addEventListener('activate', (event) => event.waitUntil((async () => {",
        "  await self.clients.claim();",
        "  const names = await caches.keys();",
        "  await Promise.all(names.map((name) => caches.delete(name)));",
        "  await self.registration.unregister();",
        "  if (names.length) for (const page of await self.clients.matchAll({ type: 'window' })) page.navigate(page.url);",
        "})()));",
        "",
    ].joined(separator: "\n")

    private let source: UiSource
    private let lock = NSLock()
    private var servedCount = 0

    public init(source: UiSource) { self.source = source }

    /// How many requests the interface answered itself (for the status line and the Simulator run's proof).
    public var served: Int { lock.lock(); defer { lock.unlock() }; return servedCount }

    /// True when `head` (a request head) is the interface's: GET or HEAD, no socket, outside the data paths.
    public static func ours(_ head: String) -> Bool {
        let first = head.components(separatedBy: "\r\n").first ?? ""
        let line = first.split(separator: " ", omittingEmptySubsequences: false)
        guard line.count == 3, line[0] == "GET" || line[0] == "HEAD", !isUpgrade(head) else { return false }
        let path = decodedPath(String(line[1]))
        let segment = path.hasPrefix("/") ? path.dropFirst().prefix { $0 != "/" } : ""
        return !dataPaths.contains(String(segment))
    }

    /// True for a WebSocket upgrade (the page's own socket).
    public static func isUpgrade(_ head: String) -> Bool {
        for line in head.components(separatedBy: "\r\n") {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { continue }
            if line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased() == "upgrade",
               line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces).lowercased() == "websocket" { return true }
        }
        return false
    }

    /// The whole answer to the interface request `head` (Connection: close – each request of the interface is its own).
    public func answer(_ head: String) -> Bytes {
        let first = head.components(separatedBy: "\r\n").first ?? ""
        let line = first.split(separator: " ", omittingEmptySubsequences: false)
        let method = line.first.map(String.init) ?? "GET"
        let path = UiFiles.decodedPath(line.count > 1 ? String(line[1]) : "/")
        var file = path == "/" ? "index.html" : path.hasPrefix("/") ? String(path.dropFirst()) : ""
        // A page starts with its document request (Sec-Fetch-Dest: document; without that header, a request for the shell).
        let dest = UiFiles.header(head, "sec-fetch-dest")
        if dest.map({ $0.lowercased() == "document" }) ?? (file == "index.html") { source.pageStarts() }
        var body: Bytes? = file == "sw.js" ? Crypto.utf8(UiFiles.retireWorker) : (UiFiles.safe(file) ? source.read(file) : nil)
        if body == nil, UiFiles.safe(file), !(file.split(separator: "/").last.map { $0.contains(".") } ?? false) {
            if dest == nil { source.pageStarts() }
            file = "index.html"
            body = source.read(file)
        }
        var reply: String
        let content: Bytes
        if let found = body {
            content = found
            reply = "HTTP/1.1 200 OK\r\nContent-Type: \(UiFiles.type(file))\r\nCache-Control: \(UiFiles.cacheControl(file))\r\n"
            if file.hasSuffix(".html") { reply += "Content-Security-Policy: \(UiFiles.appCsp)\r\n" }
        } else {
            content = Crypto.utf8("Not found.")
            reply = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n"
        }
        reply += "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Length: \(content.count)\r\nConnection: close\r\n\r\n"
        lock.lock(); servedCount += 1; lock.unlock()
        return Crypto.utf8(reply) + (method == "GET" ? content : Bytes())
    }

    /// The value of header `name` (lower case) in a request head, or nil.
    public static func header(_ head: String, _ name: String) -> String? {
        for line in head.components(separatedBy: "\r\n") {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { continue }
            if line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased() == name {
                return line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    /// The decoded path of a request target, without query or fragment; "" when it cannot be decoded.
    static func decodedPath(_ target: String) -> String {
        var end = target.endIndex
        for stop in ["?", "#"] as [Character] { if let at = target.firstIndex(of: stop), at < end { end = at } }
        return String(target[target.startIndex..<end]).replacingOccurrences(of: "+", with: "%2B").removingPercentEncoding ?? ""
    }

    /// A file path below the interface: no empty, dot-led ('..', dotfiles) or backslashed segment.
    public static func safe(_ file: String) -> Bool {
        if file.isEmpty || file.contains("\0") || file.contains("\\") { return false }
        for segment in file.split(separator: "/", omittingEmptySubsequences: false) where segment.isEmpty || segment.hasPrefix(".") { return false }
        return true
    }

    static func type(_ file: String) -> String {
        guard let dot = file.lastIndex(of: ".") else { return "application/octet-stream" }
        return types[String(file[file.index(after: dot)...]).lowercased()] ?? "application/octet-stream"
    }

    /// runtime/http/static.ts cacheControlFor: shell files revalidate every time, content-hashed ones never change.
    static func cacheControl(_ file: String) -> String {
        if file == "index.html" || file == "sw.js" { return "no-cache" }
        let range = NSRange(file.startIndex..., in: file)
        return file.hasPrefix("chunks/") || hashed.firstMatch(in: file, range: range) != nil ? "public, max-age=31536000, immutable" : "no-cache"
    }

    /// `head` (header lines through the empty line) with Connection: close in place of its own Connection and Keep-Alive
    /// lines: the PC ends the connection after its answer, so the WebView's next request opens a new one and passes `ours`.
    public static func closing(_ head: String) -> String {
        var out = ""
        for line in head.components(separatedBy: "\r\n") {
            if line.isEmpty { continue }
            let name = line.firstIndex(of: ":").map { line[line.startIndex..<$0].trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
            if name != "connection" && name != "keep-alive" { out += line + "\r\n" }
        }
        return out + "Connection: close\r\n\r\n"
    }
}
