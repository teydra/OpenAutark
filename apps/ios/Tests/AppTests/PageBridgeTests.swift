// Owns: what only WebKit on an iPhone simulator can show – the app's WKWebView loading the PC's page through the local entrance
// (the gate cookie on 127.0.0.1 really reaches the entrance; the page is a secure context; the user agent says AutarkIOS/…),
// the MessagePort channel of ui/pwa/native-port.ts in both directions with the same JSON {t,…} (the page's own listener code
// is the desktop's, trimmed), a sub-frame that cannot reach the app, and a screenshot of the loaded page. The PC and its page are
// stand-ins (FakePcStreams); a real PC's page and a real device are not involved.
import XCTest
import WebKit
import UIKit
@testable import Autark
@testable import AutarkCore

/// The listener of apps/desktop ui/pwa/native-port.ts, reduced: it adopts the port from a top-window 'autark-port' message, answers
/// {t:'colors'} and keeps what the app sends.
private let nativePortPage = """
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Autark</title><style>body{font:17px -apple-system;margin:0;padding:env(safe-area-inset-top) 16px;background:#202020;color:#eee}</style></head>
<body><h1>Autark phone UI</h1><p id="out">waiting for the app</p>
<iframe srcdoc="<script>try{window.webkit.messageHandlers.autark.postMessage('{&quot;t&quot;:&quot;evil&quot;}')}catch(e){}</script>" style="display:none"></iframe>
<script>
window.__got = [];
window.addEventListener('message', function (event) {
  if (event.data !== 'autark-port' || !event.ports || !event.ports[0]) return;
  if (!(event.source === null || event.source === window.top)) return;
  var port = event.ports[0];
  window.__port = port;
  port.onmessage = function (m) { window.__got.push(m.data); document.getElementById('out').textContent = 'app says: ' + m.data; };
  port.postMessage(JSON.stringify({ t: 'colors', top: 'rgb(32, 32, 32)', bottom: '#232323' }));
});
</script></body></html>
"""

@MainActor
final class PageBridgeTests: XCTestCase {
    private var window: UIWindow!

    override func setUp() async throws {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
    }

    private func attach(_ bridge: PageBridge) {
        bridge.webView.frame = window.bounds
        window.rootViewController?.view.addSubview(bridge.webView)
    }

    private func waitFor(_ what: String, seconds: Double = 15, _ condition: () -> Bool) async {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    private func js(_ bridge: PageBridge, _ script: String) async -> Any? {
        try? await bridge.webView.evaluateJavaScript(script)
    }

    func testThePcsPageLoadsThroughTheEntranceAndTalksThroughThePort() async throws {
        let rig = try makeProxyRig(gate: "gate-secret")
        defer { rig.proxy.close() }
        rig.streams.pageHTML = nativePortPage
        let bridge = PageBridge()
        attach(bridge)
        var got = [(String, [String: Any])]()
        bridge.onMessage = { type, message in got.append((type, message)) }

        bridge.load(origin: rig.proxy.origin, token: "tok abc&=", gate: "gate-secret")

        // page → app: the page adopted the port and sent its colours
        await waitFor("the page's first message through the port") { got.contains { $0.0 == "colors" } }
        let colors = got.first { $0.0 == "colors" }?.1
        let top = colors.flatMap { Json.str($0, "top") }
        XCTAssertEqual(top, "rgb(32, 32, 32)")
        XCTAssertEqual(CssColor.parse(top, fallback: 0), 0xFF202020)

        // app → page
        bridge.send(["t": "status", "connected": true, "pc": "Studio PC"])
        var count = 0
        for _ in 0..<100 {
            count = (await js(bridge, "window.__got.length") as? Int) ?? 0
            if count >= 1 { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertGreaterThanOrEqual(count, 1)
        let last = await js(bridge, "window.__got[window.__got.length - 1]") as? String
        let parsed = last.flatMap { try? Json.object($0) }
        XCTAssertEqual(parsed.flatMap { Json.str($0, "t") }, "status")
        XCTAssertEqual(parsed.flatMap { Json.str($0, "pc") }, "Studio PC")
        XCTAssertEqual(parsed?["connected"] as? Bool, true)

        // the page is what WebKit says it is
        let secure = await js(bridge, "window.isSecureContext") as? Bool
        XCTAssertEqual(secure, true, "http://127.0.0.1 is a secure context")
        let agent = await js(bridge, "navigator.userAgent") as? String ?? ""
        XCTAssertTrue(agent.contains("AutarkIOS/"), agent)
        XCTAssertTrue(agent.contains("(iOS "), agent)
        let hash = await js(bridge, "location.hash") as? String
        XCTAssertEqual(hash, "#token=tok%20abc%26%3D")
        let pageOrigin = await js(bridge, "location.origin") as? String
        XCTAssertEqual(pageOrigin, rig.proxy.origin)
        XCTAssertGreaterThanOrEqual(rig.streams.requestHeads.filter { $0.contains("autark_gate=gate-secret") }.count, 1, "the cookie reached the entrance")

        // an iframe of the page cannot talk to the app
        try? await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertFalse(got.contains { $0.0 == "evil" })

        // a later message while the page lives
        bridge.send(["t": "resume"])
        for _ in 0..<60 {
            count = (await js(bridge, "window.__got.length") as? Int) ?? 0
            if count >= 2 { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertGreaterThanOrEqual(count, 2)

        await snapshot(bridge, name: "page-through-the-entrance")
        bridge.unload()
    }

    func testWithoutTheGateCookieTheEntranceRefusesTheWebView() async throws {
        let rig = try makeProxyRig(gate: "the-real-gate")
        defer { rig.proxy.close() }
        let bridge = PageBridge()
        attach(bridge)
        var offline: String?
        bridge.onOffline = { offline = $0 }
        bridge.load(origin: rig.proxy.origin, token: "t", gate: "a-wrong-gate")
        await waitFor("the refusal") { offline != nil }
        XCTAssertNotNil(offline)
        XCTAssertEqual(rig.streams.requestHeads.count, 0, "nothing reached the PC")
        bridge.unload()
    }

    func testTheOfflineOwnerReachesEveryNewPageFirst() async throws {
        let rig = try makeProxyRig(gate: "gate-secret")
        defer { rig.proxy.close() }
        rig.streams.pageHTML = nativePortPage
        let bridge = PageBridge()
        attach(bridge)
        let fp = String(repeating: "cd", count: 32)
        bridge.send(OfflineOwner.message(companyId: "c1", pcFingerprint: fp)) // sent before the page exists: replayed first
        bridge.send(["t": "companies", "list": [Any]()])
        bridge.send(["t": "status", "connected": true])
        bridge.load(origin: rig.proxy.origin, token: "secret-token-value", gate: "gate-secret")
        var count = 0
        for _ in 0..<200 {
            count = (await js(bridge, "window.__got.length") as? Int) ?? 0
            if count >= 3 { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertGreaterThanOrEqual(count, 3)
        let all = await js(bridge, "JSON.stringify(window.__got)") as? String ?? ""
        let list = (try? Json.parse(all)) as? [Any] ?? []
        let types = list.compactMap { ($0 as? String).flatMap { try? Json.object($0) }.flatMap { Json.str($0, "t") } }
        XCTAssertEqual(Array(types.prefix(3)), ["offline.owner", "companies", "status"])
        XCTAssertTrue(all.contains(fp))
        XCTAssertFalse(all.contains("secret-token-value"))
        XCTAssertNil(bridge.lastOwnerText?.range(of: "token"))
        XCTAssertNil(bridge.lastOwnerText?.range(of: "seed"))
        bridge.unload()
    }

    func testUserAgentSuffixNamesTheApp() {
        let suffix = PageBridge.userAgentSuffix()
        XCTAssertTrue(suffix.hasPrefix("AutarkIOS/"), suffix)
        XCTAssertNil(suffix.range(of: "[;]\\s*\\)", options: .regularExpression), "no empty model group")
        XCTAssertEqual(suffix.filter { $0 == "(" }.count, 1)
        XCTAssertEqual(suffix.filter { $0 == ")" }.count, 1)
    }

    private func snapshot(_ bridge: PageBridge, name: String) async {
        let config = WKSnapshotConfiguration()
        guard let image = try? await bridge.webView.takeSnapshot(configuration: config), let png = image.pngData() else { return }
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["AUTARK_SNAPSHOT_DIR"], !folder.isEmpty {
            try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try? png.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + ".png"))
        }
    }
}
