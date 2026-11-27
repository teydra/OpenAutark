// The app's own interface (owner 27.11.2026): UiFiles answers it from the app's copy, the entrance sends only the PC's data
// paths over the channel, UiUpdate takes a newer interface file by file – signature, n, shell, paths, sizes, .part, ready.
// Written from docs/ARCHITECTURE.md §8 and relay/UiFiles.java, relay/UiUpdate.java, not from the Swift code under test.
import Foundation
import XCTest
@testable import AutarkCore
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The interface of a test: files by path, a count of the pages that started.
final class MemoryUi: UiSource {
    var files: [String: Bytes]
    private(set) var pages = 0
    init(_ files: [String: Bytes]) { self.files = files }
    func read(_ path: String) -> Bytes? { files[path] }
    func pageStarts() { pages += 1 }
}

func sha(_ data: Bytes) -> String { Crypto.hex(Crypto.sha256(data)) }

/// A ui.json for `files` (path → bytes), written the way scripts/ui-list.mjs writes it: compact, paths sorted.
func uiList(n: Int, shell: Int = 1, files: [String: Bytes]) -> Bytes {
    let entries = files.keys.sorted().map { "\"\($0)\":{\"sha256\":\"\(sha(files[$0]!))\",\"bytes\":\(files[$0]!.count)}" }
    return Crypto.utf8("{\"n\":\(n),\"shell\":\(shell),\"needs\":\"0.3.22\",\"files\":{\(entries.joined(separator: ","))}}")
}

/// The published place: ui.json, ui.json.sig and files by sha256; `failing` names that end in an error, `cut` names whose bytes stop short.
final class FakeUiNet: UiNet {
    var published = [String: Bytes]()
    var failing = Set<String>()
    var cut = Set<String>()
    private let lock = NSLock()
    private var opened = [String]()
    var opens: [String] { lock.lock(); defer { lock.unlock() }; return opened }

    final class Stream: UiStream {
        var rest: Bytes
        let fail: Bool
        init(_ bytes: Bytes, fail: Bool) { rest = bytes; self.fail = fail }
        func read(max: Int) throws -> Bytes {
            if rest.isEmpty { if fail { throw AutarkError("network lost") }; return [] }
            let part = Bytes(rest.prefix(max))
            rest.removeFirst(part.count)
            return part
        }
        func close() {}
    }

    func open(_ name: String) throws -> UiStream {
        lock.lock(); opened.append(name); lock.unlock()
        guard !failing.contains(name), let bytes = published[name] else { throw AutarkError("HTTP 404 for \(name)") }
        return Stream(cut.contains(name) ? Bytes(bytes.prefix(bytes.count / 2)) : bytes, fail: cut.contains(name))
    }

    /// Publishes a signed list and its files.
    func publish(n: Int, shell: Int = 1, files: [String: Bytes], seed: Bytes) {
        let list = uiList(n: n, shell: shell, files: files)
        published["ui.json"] = list
        published["ui.json.sig"] = Crypto.sign(seed: seed, message: list)
        for data in files.values { published[sha(data)] = data }
    }
}

func tempDir(_ name: String) -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("autark-ui-\(name)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func request(_ target: String, method: String = "GET", extra: String = "") -> String {
    "\(method) \(target) HTTP/1.1\r\nHost: 127.0.0.1:47920\r\nCookie: autark_gate=g\r\n\(extra)\r\n"
}

private func text(_ reply: Bytes) -> String { String(decoding: reply, as: UTF8.self) }

final class UiFilesTests: XCTestCase {
    func ui() -> (UiFiles, MemoryUi) {
        let source = MemoryUi([
            "index.html": Crypto.utf8("<html>own shell</html>"),
            "chunks/app-ABCDEFGH.js": Crypto.utf8("console.log(1)"),
            "style.css": Crypto.utf8("body{}"),
            "font-ABCD1234.woff2": [1, 2, 3],
            "icons/a b.png": [9],
        ])
        return (UiFiles(source: source), source)
    }

    func testTheShellAnswersWithTypeCspAndNoCache() {
        let (files, _) = ui()
        let reply = text(files.answer(request("/")))
        XCTAssertTrue(reply.hasPrefix("HTTP/1.1 200 OK\r\n"))
        XCTAssertTrue(reply.contains("Content-Type: text/html; charset=utf-8"))
        XCTAssertTrue(reply.contains("Cache-Control: no-cache"))
        XCTAssertTrue(reply.contains("Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"))
        XCTAssertTrue(reply.contains("Connection: close"))
        XCTAssertTrue(reply.hasSuffix("<html>own shell</html>"))
        XCTAssertTrue(reply.contains("Content-Length: 22"))
    }

    func testHashedFilesAreImmutableAndTypedByExtension() {
        let (files, _) = ui()
        let script = text(files.answer(request("/chunks/app-ABCDEFGH.js")))
        XCTAssertTrue(script.contains("Content-Type: text/javascript; charset=utf-8"))
        XCTAssertTrue(script.contains("Cache-Control: public, max-age=31536000, immutable"))
        XCTAssertFalse(script.contains("Content-Security-Policy"), "only HTML carries the policy")
        let font = text(files.answer(request("/font-ABCD1234.woff2")))
        XCTAssertTrue(font.contains("Content-Type: font/woff2") && font.contains("immutable"))
        XCTAssertTrue(text(files.answer(request("/style.css"))).contains("Cache-Control: no-cache"))
        XCTAssertTrue(text(files.answer(request("/icons/a%20b.png?x=1#y"))).hasPrefix("HTTP/1.1 200 OK"), "the target is decoded, the query is not part of the path")
    }

    func testANavigationPathWithoutAnExtensionGivesTheShellAndAMissingFileIs404() {
        let (files, _) = ui()
        XCTAssertTrue(text(files.answer(request("/chat/abc"))).hasSuffix("<html>own shell</html>"))
        let missing = text(files.answer(request("/chunks/gone-ABCDEFGH.js")))
        XCTAssertTrue(missing.hasPrefix("HTTP/1.1 404 Not Found"))
        XCTAssertTrue(missing.contains("Cache-Control: no-store"))
    }

    func testNothingOutsideTheInterfaceIsRead() {
        let (files, source) = ui()
        source.files[".secret"] = [1]
        for target in ["/.secret", "/%2e%2e/etc/passwd", "/a/../index.html", "/chunks//app-ABCDEFGH.js", "/a%5Cb.js", "/%00.js"] {
            XCTAssertTrue(text(files.answer(request(target))).hasPrefix("HTTP/1.1 404"), target)
        }
    }

    func testHeadHasTheHeadersAndNoBody() {
        let (files, _) = ui()
        let reply = text(files.answer(request("/", method: "HEAD")))
        XCTAssertTrue(reply.hasPrefix("HTTP/1.1 200 OK"))
        XCTAssertTrue(reply.contains("Content-Length: 22"))
        XCTAssertTrue(reply.hasSuffix("\r\n\r\n"), "no body after the head")
    }

    func testTheAppsOwnRequestsAreTheInterfaceAndTheDataPathsAreNot() {
        for target in ["/", "/index.html", "/chunks/x-ABCDEFGH.js", "/chat/1", "/rpcx", "/websocket", "/sw.js", "/manifest.webmanifest"] {
            XCTAssertTrue(UiFiles.ours(request(target)), target)
        }
        for target in ["/ws", "/rpc", "/rpc/x", "/events", "/events?x=1", "/mcp", "/files/a.png", "/sandbox/app/x", "/turn/", "/peer", "/.well-known/x", "/files%2Fx"] {
            // "/files%2Fx" decodes to /files/x
            XCTAssertFalse(UiFiles.ours(request(target)), target)
        }
        XCTAssertFalse(UiFiles.ours(request("/rpc", method: "POST")), "a POST is the PC's")
        XCTAssertFalse(UiFiles.ours(request("/x", method: "PUT")))
        XCTAssertFalse(UiFiles.ours(request("/", extra: "Upgrade: websocket\r\nConnection: Upgrade\r\n")), "a socket is the PC's")
        XCTAssertFalse(UiFiles.ours("garbage"))
    }

    func testAPageStartsWithItsDocumentRequest() {
        let (files, source) = ui()
        _ = files.answer(request("/chunks/app-ABCDEFGH.js", extra: "Sec-Fetch-Dest: script\r\n"))
        _ = files.answer(request("/style.css"))
        XCTAssertEqual(source.pages, 0, "a script, a style and a request without the header for another file are no page")
        _ = files.answer(request("/", extra: "Sec-Fetch-Dest: document\r\n"))
        XCTAssertEqual(source.pages, 1)
        _ = files.answer(request("/chat/1", extra: "Sec-Fetch-Dest: document\r\n"))
        XCTAssertEqual(source.pages, 2)
        _ = files.answer(request("/")) // no header: a request for the shell
        XCTAssertEqual(source.pages, 3)
        _ = files.answer(request("/chat/2")) // no header, a navigation path: the shell
        XCTAssertEqual(source.pages, 4)
        XCTAssertEqual(files.served, 6)
    }

    func testTheOldServiceWorkerEndsItself() {
        let (files, _) = ui()
        let reply = text(files.answer(request("/sw.js")))
        XCTAssertTrue(reply.hasPrefix("HTTP/1.1 200 OK"))
        XCTAssertTrue(reply.contains("caches.delete") && reply.contains("registration.unregister()") && reply.contains("Cache-Control: no-cache"))
    }

    func testClosingReplacesTheConnectionLines() {
        let head = "GET /rpc HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nCookie: a=b\r\n\r\n"
        let closed = UiFiles.closing(head)
        XCTAssertEqual(closed, "GET /rpc HTTP/1.1\r\nHost: x\r\nCookie: a=b\r\nConnection: close\r\n\r\n")
        XCTAssertEqual(UiFiles.closing("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    }
}

final class OwnUiEntranceTests: XCTestCase {
    private func fetch(_ port: Int, _ head: String, body: Bytes = []) -> String {
        guard let client = TcpConnection.connect(port: port) else { XCTFail("could not connect"); return "" }
        client.write(Crypto.utf8(head) + body)
        var all = Bytes()
        while let part = client.read(max: 64 * 1024, timeoutSeconds: 10) { all.append(contentsOf: part) }
        client.shutdown()
        return String(decoding: all, as: UTF8.self)
    }

    private func rig() throws -> (ProxyRig, MemoryUi) {
        let source = MemoryUi(["index.html": Crypto.utf8("<html>own shell</html>"), "chunks/app-ABCDEFGH.js": Crypto.utf8("x")])
        return (try makeProxyRig(ui: UiFiles(source: source)), source)
    }

    func testTheInterfaceComesFromTheAppAndNoRequestReachesThePc() throws {
        let (r, source) = try rig()
        defer { r.proxy.close() }
        let page = fetch(r.proxy.port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: autark_gate=gate-secret\r\nSec-Fetch-Dest: document\r\n\r\n")
        XCTAssertTrue(page.hasSuffix("<html>own shell</html>"), page)
        XCTAssertTrue(fetch(r.proxy.port, "GET /chunks/app-ABCDEFGH.js HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n").contains("immutable"))
        XCTAssertEqual(r.streams.requestHeads.count, 0, "the PC was asked for no interface file")
        XCTAssertEqual(r.proxy.openStreams, 0)
        XCTAssertEqual(source.pages, 1)
    }

    func testTheInterfaceShowsWithNoPcAtAll() throws {
        let (r, _) = try rig()
        defer { r.proxy.close() }
        r.channels.channel = nil
        let page = fetch(r.proxy.port, "GET / HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n")
        XCTAssertTrue(page.hasPrefix("HTTP/1.1 200 OK") && page.hasSuffix("<html>own shell</html>"), page)
        let data = fetch(r.proxy.port, "GET /files/a.png HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\n\r\n")
        XCTAssertTrue(data.hasPrefix("HTTP/1.1 503 Service Unavailable"), "a data path with no PC is the PC's 503, the page shows its own quiet state: \(data)")
    }

    func testDataPathsGoOverTheChannelWithConnectionClose() throws {
        let (r, _) = try rig()
        defer { r.proxy.close() }
        let answer = fetch(r.proxy.port, "GET /files/a.png HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nCookie: autark_gate=gate-secret\r\n\r\n")
        XCTAssertTrue(answer.hasPrefix("HTTP/1.1 404 Not Found"), "the PC answered: \(answer)")
        let rpc = fetch(r.proxy.port, "POST /upload HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\nContent-Length: 5\r\n\r\n", body: Crypto.utf8("hello"))
        XCTAssertTrue(rpc.hasSuffix("got 5 bytes"), rpc)
        let heads = r.streams.requestHeads
        XCTAssertEqual(heads.count, 2)
        for head in heads {
            XCTAssertTrue(head.hasSuffix("Connection: close"), head)
            XCTAssertEqual(head.lowercased().components(separatedBy: "connection:").count, 2, "one Connection line: \(head)")
            XCTAssertFalse(head.lowercased().contains("keep-alive"))
        }
    }

    func testAnUploadBodyThatArrivedWithTheHeadIsNotLost() throws {
        let (r, _) = try rig()
        defer { r.proxy.close() }
        let body = Bytes(repeating: 7, count: 1000)
        let answer = fetch(r.proxy.port, "POST /upload HTTP/1.1\r\nHost: x\r\nCookie: autark_gate=gate-secret\r\nContent-Length: 1000\r\n\r\n", body: body)
        XCTAssertTrue(answer.hasSuffix("got 1000 bytes"), answer)
    }

    func testTheCompanysPortNeverChanges() throws {
        let channels = FixedChannels()
        let first = try StreamProxy(port: 0, gate: "g", channels: channels)
        defer { first.close() }
        XCTAssertThrowsError(try StreamProxy(port: first.port, gate: "g", channels: channels, ui: nil, fixedPort: true), "a taken company port is an error, not another port")
        let free = try StreamProxy(port: 0, gate: "g", channels: channels, ui: nil, fixedPort: true)
        free.close()
    }
}

final class UiUpdateTests: XCTestCase {
    let seed = Bytes(repeating: 0x42, count: 32)
    let spare = Bytes(repeating: 0x43, count: 32)
    let stranger = Bytes(repeating: 0x44, count: 32)
    var keys: [Bytes] { [Crypto.ed25519Public(seed: seed), Crypto.ed25519Public(seed: spare)] }

    let own: [String: Bytes] = ["index.html": Crypto.utf8("<html>v1</html>"), "chunks/a-AAAAAAAA.js": Crypto.utf8("a1"), "chunks/b-BBBBBBBB.js": Crypto.utf8("b1")]

    /// The app's interface and its own list (n 100), as the build puts them in the bundle (ui.json among the files).
    func shipped(n: Int = 100, shell: Int = 1) -> MemoryUi {
        var files = own
        files["ui.json"] = uiList(n: n, shell: shell, files: own)
        return MemoryUi(files)
    }

    func store(_ dir: URL, shipped: MemoryUi? = nil, keys: [Bytes]? = nil) -> UiUpdate {
        UiUpdate(dir: dir, shipped: shipped ?? self.shipped(), keys: keys ?? self.keys)
    }

    var newer: [String: Bytes] { ["index.html": Crypto.utf8("<html>v2</html>"), "chunks/a-AAAAAAAA.js": Crypto.utf8("a1"), "chunks/c-CCCCCCCC.js": Crypto.utf8("c2")] }

    // MARK: the two public keys

    func testBothPublicKeysAreValid32ByteEd25519Keys() throws {
        XCTAssertEqual(UiUpdate.publicKeys.count, 2, "the active key and the spare")
        XCTAssertEqual(UiUpdate.decodedKeys().count, 2, "both decode to 32 bytes")
        for text in UiUpdate.publicKeys {
            let raw = try XCTUnwrap(Crypto.fromB64url(text), text)
            XCTAssertEqual(raw.count, 32)
            XCTAssertNotNil(try? Curve25519.Signing.PublicKey(rawRepresentation: raw), "\(text) is an Ed25519 public key")
            XCTAssertEqual(Crypto.b64url(raw), text, "base64url without padding, as the Android constant")
        }
        XCTAssertNotEqual(UiUpdate.publicKeys[0], UiUpdate.publicKeys[1])
        XCTAssertEqual(UiUpdate.decodedKeys(["short", "", "!!!!"]).count, 0, "a key that does not decode to 32 bytes counts for nothing")
        XCTAssertTrue(UiUpdate.base.hasPrefix("https://github.com/teydra/OpenAutark/releases/download/") && UiUpdate.base.hasSuffix("/"))
        XCTAssertEqual(UiUpdate.shell, 1)
    }

    // MARK: the list

    func testAListIsTakenOnlyWhenItIsWellFormed() throws {
        func parse(_ text: String) -> UiUpdate.Listing? { UiUpdate.parse(Crypto.utf8(text)) }
        let sha1 = String(repeating: "a", count: 64)
        let good = "{\"n\":5,\"shell\":1,\"files\":{\"index.html\":{\"sha256\":\"\(sha1)\",\"bytes\":3},\"chunks/x.js\":{\"sha256\":\"\(sha1)\",\"bytes\":0}}}"
        XCTAssertEqual(parse(good)?.files.count, 2)
        XCTAssertNil(parse(good.replacingOccurrences(of: "\"index.html\"", with: "\"main.html\"")), "index.html must be among the files")
        for bad in ["../x.js", "/x.js", "a//b.js", ".hidden", "a/.b", "a\\\\b.js", ""] {
            XCTAssertNil(parse(good.replacingOccurrences(of: "chunks/x.js", with: bad)), "path '\(bad)'")
        }
        XCTAssertNil(parse(good.replacingOccurrences(of: String(repeating: "a", count: 64), with: String(repeating: "A", count: 64))), "lower-case hex only")
        XCTAssertNil(parse(good.replacingOccurrences(of: "\"sha256\":\"\(sha1)\",\"bytes\":3", with: "\"sha256\":\"abc\",\"bytes\":3")), "64 hex digits")
        XCTAssertNil(parse(good.replacingOccurrences(of: "\"bytes\":3", with: "\"bytes\":-1")))
        XCTAssertNil(parse(good.replacingOccurrences(of: "\"bytes\":3", with: "\"bytes\":\(33 << 20)")), "a file is at most 32 MB")
        XCTAssertNil(parse(good.replacingOccurrences(of: "\"n\":5", with: "\"n\":0")))
        XCTAssertNil(parse(good.replacingOccurrences(of: "\"shell\":1", with: "\"shell\":0")))
        XCTAssertNil(parse("{\"n\":5,\"shell\":1}"))
        XCTAssertNil(parse("[]"))
        XCTAssertNil(parse("not json"))
        // all together at most 128 MB: five files of 30 MB are too many
        var many = [String]()
        for i in 0..<5 { many.append("\"f\(i).js\":{\"sha256\":\"\(sha1)\",\"bytes\":\(30 << 20)}") }
        XCTAssertNil(parse("{\"n\":5,\"shell\":1,\"files\":{\"index.html\":{\"sha256\":\"\(sha1)\",\"bytes\":1},\(many.joined(separator: ","))}}"))
    }

    // MARK: with no key, nothing is looked for

    func testWithNoKeyTheAppNeverLooksAndRunsItsOwnInterface() {
        let dir = tempDir("nokey")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        let ui = store(dir, keys: [])
        XCTAssertFalse(ui.due(now: 1_000))
        XCTAssertFalse(ui.check(net: net, now: 1_000))
        XCTAssertEqual(net.opens, [])
        XCTAssertEqual(ui.read("index.html"), own["index.html"])
        XCTAssertEqual(ui.ns().newest, 100)
    }

    func testABuildWithoutItsListFetchesNothingAndAnswersByPath() {
        let ui = UiUpdate(dir: tempDir("nolist"), shipped: MemoryUi(own), keys: keys)
        XCTAssertFalse(ui.due(now: 1_000))
        XCTAssertEqual(ui.read("index.html"), own["index.html"])
    }

    // MARK: a newer list

    func testANewerSignedListFetchesOnlyTheFilesTheAppLacksAndIsReady() throws {
        let dir = tempDir("fetch")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        let ui = store(dir)
        XCTAssertTrue(ui.due(now: 5_000))
        XCTAssertTrue(ui.check(net: net, now: 5_000))
        // the page's own file a1 and the shell's new file: only index.html (v2) and c are new
        XCTAssertEqual(Set(net.opens), ["ui.json", "ui.json.sig", sha(newer["index.html"]!), sha(newer["chunks/c-CCCCCCCC.js"]!)])
        XCTAssertFalse(net.opens.contains(sha(own["chunks/a-AAAAAAAA.js"]!)), "a file the app already has is not fetched again")
        let ready = dir.appendingPathComponent("lists/200.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: ready.path), "ready: the list is written last")
        XCTAssertEqual(try Data(contentsOf: ready), Data(uiList(n: 200, files: newer)))
        XCTAssertEqual(ui.ns().newest, 200)
        XCTAssertEqual(ui.ns().current, 100, "the running page keeps its list")
        XCTAssertTrue(ui.reloadDue)
        let blobs = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("blobs").path)
        XCTAssertEqual(Set(blobs), [sha(newer["index.html"]!), sha(newer["chunks/c-CCCCCCCC.js"]!)], "no .part is left")
    }

    func testAPageStartsWithTheNewestReadyListAndARunningPageNeverMixesTwoBuilds() {
        let dir = tempDir("pages")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        let ui = store(dir)
        XCTAssertTrue(ui.check(net: net, now: 5_000))
        XCTAssertEqual(ui.read("index.html"), own["index.html"], "the running page still reads its own list")
        XCTAssertNil(ui.read("chunks/c-CCCCCCCC.js"))
        XCTAssertEqual(ui.read("chunks/b-BBBBBBBB.js"), own["chunks/b-BBBBBBBB.js"])
        ui.pageStarts()
        XCTAssertEqual(ui.read("index.html"), newer["index.html"])
        XCTAssertEqual(ui.read("chunks/c-CCCCCCCC.js"), newer["chunks/c-CCCCCCCC.js"])
        XCTAssertEqual(ui.read("chunks/a-AAAAAAAA.js"), own["chunks/a-AAAAAAAA.js"], "a file the new list shares with the app's own comes from the app")
        XCTAssertNil(ui.read("chunks/b-BBBBBBBB.js"), "the new list does not name it")
        XCTAssertFalse(ui.reloadDue)
        XCTAssertEqual(ui.ns().current, 200)
    }

    func testTheSpareKeyVerifiesToo() {
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: spare)
        XCTAssertTrue(store(tempDir("spare")).check(net: net, now: 5_000))
    }

    func testAWrongSignatureChangesNothing() throws {
        let dir = tempDir("sig")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: stranger)
        let ui = store(dir)
        XCTAssertFalse(ui.check(net: net, now: 5_000))
        XCTAssertFalse(net.opens.contains(sha(newer["chunks/c-CCCCCCCC.js"]!)), "no file of an unsigned list is fetched")
        XCTAssertEqual(ui.ns().newest, 100)
        // a signature over other bytes, a short one, a missing one
        net.publish(n: 200, files: newer, seed: seed)
        net.published["ui.json"] = uiList(n: 201, files: newer)
        XCTAssertFalse(store(tempDir("sig2")).check(net: net, now: 5_000), "the signature is over the exact bytes")
        net.publish(n: 200, files: newer, seed: seed)
        net.published["ui.json.sig"] = Bytes(net.published["ui.json.sig"]!.prefix(63))
        XCTAssertFalse(store(tempDir("sig3")).check(net: net, now: 5_000))
        net.published["ui.json.sig"] = nil
        XCTAssertFalse(store(tempDir("sig4")).check(net: net, now: 5_000))
    }

    func testAListThatIsNotNewerOrNeedsANewerAppIsNotTaken() {
        let net = FakeUiNet()
        net.publish(n: 100, files: newer, seed: seed)
        XCTAssertFalse(store(tempDir("same")).check(net: net, now: 5_000), "n must be above the app's own")
        net.publish(n: 99, files: newer, seed: seed)
        XCTAssertFalse(store(tempDir("older")).check(net: net, now: 5_000))
        net.publish(n: 300, shell: 2, files: newer, seed: seed)
        XCTAssertFalse(store(tempDir("shell")).check(net: net, now: 5_000), "shell above the app's number needs a newer app")
        XCTAssertFalse(net.opens.contains(sha(newer["chunks/c-CCCCCCCC.js"]!)))
        net.publish(n: 300, shell: 1, files: newer, seed: seed)
        XCTAssertTrue(store(tempDir("shellok")).check(net: net, now: 5_000), "shell equal to the app's number is fine")
    }

    func testAnUnsafePathOrAMissingIndexInASignedListIsRefused() {
        let net = FakeUiNet()
        var bad = newer
        bad["../evil.js"] = [1]
        net.publish(n: 200, files: bad, seed: seed)
        XCTAssertFalse(store(tempDir("path")).check(net: net, now: 5_000))
        var noIndex = newer
        noIndex["index.html"] = nil
        net.publish(n: 200, files: noIndex, seed: seed)
        XCTAssertFalse(store(tempDir("index")).check(net: net, now: 5_000))
    }

    func testAFileWithTheWrongSizeOrHashIsNeverKept() throws {
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        let c = sha(newer["chunks/c-CCCCCCCC.js"]!)
        net.published[c] = Crypto.utf8("c3") // the same size, other bytes
        let dir = tempDir("hash")
        XCTAssertFalse(store(dir).check(net: net, now: 5_000))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("blobs/\(c)").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("blobs/\(c).part").path), "the .part goes")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("lists/200.json").path), "no list without every file")
        net.published[c] = Crypto.utf8("c22") // longer than announced
        XCTAssertFalse(store(tempDir("long")).check(net: net, now: 5_000))
        net.published[c] = Crypto.utf8("c") // shorter
        XCTAssertFalse(store(tempDir("short")).check(net: net, now: 5_000))
    }

    func testACutFetchKeepsTheFilesAlreadyCheckedAndTheNextLookCompletes() throws {
        let dir = tempDir("cut")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        let index = sha(newer["index.html"]!), c = sha(newer["chunks/c-CCCCCCCC.js"]!)
        net.cut = [c]
        let ui = store(dir)
        XCTAssertFalse(ui.check(net: net, now: 5_000))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("lists/200.json").path), "no ready list")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("blobs/\(c).part").path))
        XCTAssertEqual(ui.ns().newest, 100)
        net.cut = []
        XCTAssertFalse(ui.check(net: net, now: 5_000 + 30_000), "at most one look a minute")
        XCTAssertTrue(ui.check(net: net, now: 5_000 + 60_000))
        XCTAssertEqual(net.opens.filter { $0 == index }.count, 1, "a file already checked is fetched once, in the cut round or the next, never twice")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("lists/200.json").path))
    }

    func testNoNetworkChangesNothingAndAnotherLookFollowsAMinuteLater() {
        let dir = tempDir("offline")
        let net = FakeUiNet()
        let ui = store(dir)
        XCTAssertFalse(ui.check(net: net, now: 10_000)) // nothing published: a 404
        XCTAssertFalse(ui.due(now: 10_000 + 59_999))
        XCTAssertTrue(ui.due(now: 10_000 + 60_000))
        XCTAssertTrue(ui.due(now: 9_000), "the clock went back")
        net.publish(n: 200, files: newer, seed: seed)
        XCTAssertTrue(ui.check(net: net, now: 10_000 + 60_000))
    }

    func testAnOversizedListIsNotRead() {
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        net.published["ui.json"] = Bytes(repeating: 32, count: (1 << 20) + 1)
        XCTAssertFalse(store(tempDir("big")).check(net: net, now: 5_000))
        net.publish(n: 200, files: newer, seed: seed)
        net.published["ui.json.sig"] = Bytes(repeating: 1, count: 65)
        XCTAssertFalse(store(tempDir("bigsig")).check(net: net, now: 5_000))
    }

    // MARK: what stays on the disk

    func testAReadyListSurvivesARestartAndAPartNeverCountsAsReady() throws {
        let dir = tempDir("restart")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        XCTAssertTrue(store(dir).check(net: net, now: 5_000))
        // a list the app was killed on: written as .part only
        let part = dir.appendingPathComponent("lists/250.json.part")
        try Data(uiList(n: 250, files: newer)).write(to: part)
        let again = store(dir)
        XCTAssertEqual(again.ns().newest, 200, "a .part is no ready list")
        XCTAssertEqual(again.ns().current, 200, "a new run's first page gets the newest")
        XCTAssertEqual(again.read("index.html"), newer["index.html"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path), "it goes")
    }

    func testAListWhoseFileWentMissingIsNotReady() throws {
        let dir = tempDir("missing")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        XCTAssertTrue(store(dir).check(net: net, now: 5_000))
        try FileManager.default.removeItem(at: dir.appendingPathComponent("blobs/\(sha(newer["chunks/c-CCCCCCCC.js"]!))"))
        let again = store(dir)
        XCTAssertEqual(again.ns().newest, 100, "back on the app's own interface")
        XCTAssertEqual(again.read("index.html"), own["index.html"])
    }

    func testAnAppWithANewerOwnListDropsEveryFetchedListAndFile() throws {
        let dir = tempDir("update")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        XCTAssertTrue(store(dir).check(net: net, now: 5_000))
        let updated = store(dir, shipped: shipped(n: 300))
        XCTAssertEqual(updated.ns().newest, 300)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("lists").path), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("blobs").path), [])
    }

    func testOnlyTheRunningAndTheNewestListAndTheirFilesStay() throws {
        let dir = tempDir("prune")
        let net = FakeUiNet()
        let ui = store(dir)
        net.publish(n: 200, files: newer, seed: seed)
        XCTAssertTrue(ui.check(net: net, now: 5_000))
        ui.pageStarts() // the page runs list 200
        var third = newer
        third["chunks/c-CCCCCCCC.js"] = Crypto.utf8("c3")
        net.publish(n: 300, files: third, seed: seed)
        XCTAssertTrue(ui.check(net: net, now: 5_000 + 60_000))
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("lists").path)), ["200.json", "300.json"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("blobs/\(sha(newer["chunks/c-CCCCCCCC.js"]!))").path), "the running page's file stays")
        ui.pageStarts() // the page moved to 300: 200 and the files only it named go
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("lists").path)), ["300.json"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("blobs/\(sha(newer["chunks/c-CCCCCCCC.js"]!))").path))
    }

    func testAReloadIsNotDueWhenTheNewListHasTheSameFiles() {
        let net = FakeUiNet()
        net.publish(n: 200, files: own, seed: seed) // a newer build with the very same files
        let ui = store(tempDir("same-files"))
        XCTAssertTrue(ui.check(net: net, now: 5_000))
        XCTAssertFalse(ui.reloadDue)
    }

    func testTheEntranceServesTheNewListToTheNextPageOnly() throws {
        let dir = tempDir("entrance")
        let net = FakeUiNet()
        net.publish(n: 200, files: newer, seed: seed)
        let ui = store(dir)
        let files = UiFiles(source: ui)
        XCTAssertTrue(text(files.answer(request("/", extra: "Sec-Fetch-Dest: document\r\n"))).hasSuffix("<html>v1</html>"))
        XCTAssertTrue(ui.check(net: net, now: 5_000))
        XCTAssertTrue(text(files.answer(request("/", extra: "Sec-Fetch-Dest: empty\r\n"))).hasSuffix("<html>v1</html>"), "not a page start")
        XCTAssertTrue(text(files.answer(request("/", extra: "Sec-Fetch-Dest: document\r\n"))).hasSuffix("<html>v2</html>"))
    }
}
