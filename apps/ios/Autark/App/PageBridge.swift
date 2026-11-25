// Owns: the app's one WKWebView and everything between it and the PC's page – the cookie that lets only this web view through
// the local entrance, the user agent (… AutarkIOS/<version> (iOS <release>; <model>)), navigation (same origin stays, other
// addresses open outside, autark-app:forget asks the app), and the one channel to the page (apps/desktop ui/pwa/native-port.ts):
// after every new document the page gets a MessagePort as the window message 'autark-port' (a user script in the page's main
// frame makes the channel; its other end talks to the app through one WKScriptMessageHandler that answers only the main frame),
// JSON {t, …} both ways, the latest 'companies' and 'status' replayed to every new page. The hello is posted again for a few
// seconds until the page answers, because the page installs its listener a moment after the load event.
// Never: lets a sub-frame (an agent's sandboxed iframe) reach the app, loads another origin in the app's view, or keeps a message
// from a page that is gone.
import SwiftUI
import UIKit
import WebKit
import AutarkCore

@MainActor
final class PageBridge: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let handlerName = "autark"

    /// The channel's JavaScript: hello() hands the page a fresh MessagePort, send(text) goes to the page through it.
    static let script = """
    (function () {
      if (window.__autarkBridge) return;
      var mine = null;
      var bridge = {
        hello: function () {
          if (mine) { try { mine.close(); } catch (e) {} }
          var channel = new MessageChannel();
          mine = channel.port1;
          mine.onmessage = function (event) {
            var data = event.data;
            try { window.webkit.messageHandlers.autark.postMessage(typeof data === 'string' ? data : JSON.stringify(data)); } catch (e) {}
          };
          window.postMessage('autark-port', '*', [channel.port2]);
        },
        send: function (text) { if (mine) mine.postMessage(text); }
      };
      Object.defineProperty(window, '__autarkBridge', { value: Object.freeze(bridge), enumerable: false });
    })();
    """

    let webView: WKWebView
    private(set) var origin: String?
    private var lastCompanies: String?
    private var lastStatus: String?
    private var lastOwner: String?
    private var lastPushToken: String?
    /// A notice's route waiting for the page to load (a tap that started the app).
    private var pendingRoute: String?
    private var routeGeneration = 0
    /// The newest 'offline.owner' message as sent (tests; it carries no secret).
    var lastOwnerText: String? { lastOwner }
    private var portAlive = false
    private var helloTries = 0
    private var helloTimer: Timer?
    private var pending: URL?

    /// What the page asks of the app (main thread).
    var onMessage: ((_ type: String, _ message: [String: Any]) -> Void)?
    /// The page's document did not load: why, for the offline screen; nil when a page loaded.
    var onOffline: ((String?) -> Void)?
    private var mainFrameRefused = false
    /// The page asked for "Forget this phone" through its address autark-app:forget.
    var onForgetAddress: (() -> Void)?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = [] // a call's voice plays without a second tap
        configuration.applicationNameForUserAgent = PageBridge.userAgentSuffix()
        configuration.limitsNavigationsToAppBoundDomains = false
        let controller = WKUserContentController()
        configuration.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        controller.addUserScript(WKUserScript(source: PageBridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakHandler(self), name: PageBridge.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never // the page keeps itself clear of the notch and home bar (env(safe-area-inset-*))
        webView.scrollView.bounces = true
        webView.isOpaque = true
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
    }

    /// " AutarkIOS/0.1.0 (iOS 26.1; iPhone15,2)" – the model sits in the user agent because Safari's own hides it and a
    /// feedback report names it (apps/desktop ui/feedback/client.ts reads the Android twin).
    static func userAgentSuffix() -> String {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        var system = utsname()
        uname(&system)
        let machine = withUnsafeBytes(of: &system.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        let clean = { (text: String) in text.replacingOccurrences(of: "[();\\s]", with: "", options: .regularExpression) }
        let model = machine.isEmpty ? UIDevice.current.model : machine
        return "AutarkIOS/\(clean(version)) (iOS \(clean(UIDevice.current.systemVersion)); \(model.replacingOccurrences(of: "[();]", with: " ", options: .regularExpression)))"
    }

    // MARK: loading

    /// Lets only this web view through the company's entrance, then opens the PC's page with the phone's token.
    func load(origin: String, token: String, gate: String) {
        self.origin = origin
        portAlive = false
        routeGeneration += 1
        stopHello()
        let allowed = CharacterSet.urlFragmentAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))
        guard let url = URL(string: origin + "/#token=" + (token.addingPercentEncoding(withAllowedCharacters: allowed) ?? token)) else { return }
        pending = url
        let properties: [HTTPCookiePropertyKey: Any] = [
            .name: StreamProxy.gateCookie, .value: gate, .domain: "127.0.0.1", .path: "/",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE", .sameSitePolicy: "strict",
        ]
        guard let cookie = HTTPCookie(properties: properties) else { webView.load(URLRequest(url: url)); return }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            guard let self = self, self.pending == url else { return }
            self.webView.load(URLRequest(url: url))
        }
    }

    func reload() {
        if webView.url == nil || webView.url?.absoluteString == "about:blank", let url = pending { webView.load(URLRequest(url: url)) } else { webView.reload() }
    }

    /// Leaves the app page: its live camera and microphone streams, port and timers end.
    func unload() {
        stopHello()
        portAlive = false
        routeGeneration += 1
        origin = nil
        pending = nil
        webView.load(URLRequest(url: URL(string: "about:blank")!))
    }

    /// "Forget this phone": the web storage and the gate cookie of the entrance go (all of 127.0.0.1: the companies share the host).
    func forgetWebData(completion: @escaping () -> Void) {
        let store = webView.configuration.websiteDataStore
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { completion() }
    }

    @objc private func pullToRefresh(_ control: UIRefreshControl) {
        reload()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { MainActor.assumeIsolated { control.endRefreshing() } }
    }

    // MARK: app → page

    /// Sends one JSON message to the page; 'companies' and 'status' are kept and sent again to every new page.
    func send(_ message: [String: Any]) {
        guard let text = encode(message) else { return }
        switch message["t"] as? String {
        case "companies": lastCompanies = text
        case "status": lastStatus = text
        case "offline.owner": lastOwner = text
        case "push.token": lastPushToken = text
        default: break
        }
        post(text)
    }

    private func post(_ text: String) {
        guard let literal = encode(text) else { return }
        webView.evaluateJavaScript("window.__autarkBridge && window.__autarkBridge.send(\(literal))", completionHandler: nil)
    }

    private func encode(_ value: Any) -> String? {
        if let text = value as? String {
            guard let data = try? JSONSerialization.data(withJSONObject: [text], options: []), let json = String(data: data, encoding: .utf8) else { return nil }
            return String(json.dropFirst().dropLast()) // the array's one element: a JSON string literal, valid JavaScript
        }
        let sorted = Json.write(value)
        return sorted
    }

    private func startHello() {
        stopHello()
        helloTries = 0
        sendHello()
        helloTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self = self else { timer.invalidate(); return }
                if self.portAlive || self.helloTries >= 8 { self.stopHello(); return }
                self.sendHello()
            }
        }
    }

    private func sendHello() {
        helloTries += 1
        webView.evaluateJavaScript("window.__autarkBridge && window.__autarkBridge.hello()", completionHandler: nil)
        if let owner = lastOwner { post(owner) } // first: the page waits for it before it shows its cache
        if let companies = lastCompanies { post(companies) }
        if let status = lastStatus { post(status) }
        if let token = lastPushToken { post(token) }
    }

    /// A tapped notice's route ("/#/chat/<id>"): the page routes to its hash like the PC's worker does on a tap (wf.navigate); a route that
    /// is no hash route does nothing, and while no page is loaded the route waits for it.
    func open(url: String) {
        guard let hash = NoticeRoute.hash(of: url) else { return }
        guard ConnectionAddress.sameOrigin(origin, webView.url?.absoluteString), !webView.isLoading, let literal = encode(hash) else { pendingRoute = hash; return }
        pendingRoute = nil
        routeGeneration += 1
        applyRoute(literal, generation: routeGeneration, tries: 0)
    }

    /// Sets the page's hash route – but only once the page has taken its device token out of the address: the page reads
    /// `#token=…` when its socket to the PC opens (ui/lib/rpc-token.ts), which can be seconds after the load event (meeting server,
    /// tunnel). A route written earlier replaces the hash, the token is lost and the page shows "Connect this phone" (the CI run of
    /// 24.11.2026 showed exactly that). A newer route, or a new page, ends the waiting of an older one.
    private func applyRoute(_ literal: String, generation: Int, tries: Int) {
        let script = "(function (h) { if (/(?:^#|&)token=/.test(location.hash)) return false; location.hash = h; return true; })(\(literal))"
        webView.evaluateJavaScript(script) { [weak self] result, _ in
            MainActor.assumeIsolated {
                guard let self = self, self.routeGeneration == generation, (result as? Bool) != true, tries < 120 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    MainActor.assumeIsolated { self.applyRoute(literal, generation: generation, tries: tries + 1) }
                }
            }
        }
    }

    private func stopHello() { helloTimer?.invalidate(); helloTimer = nil }

    // MARK: page → app

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        received(message.body, mainFrame: message.frameInfo.isMainFrame, from: message.frameInfo.request.url?.absoluteString)
    }

    private func received(_ body: Any, mainFrame: Bool, from url: String?) {
        guard mainFrame, let origin = origin, ConnectionAddress.sameOrigin(origin, url), let text = body as? String,
              let object = try? Json.object(text), let type = Json.str(object, "t") else { return }
        portAlive = true
        onMessage?(type, object)
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.absoluteString == "autark-app:forget" { decisionHandler(.cancel); onForgetAddress?(); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if navigationAction.targetFrame?.isMainFrame != true { decisionHandler(.allow); return } // frames of the page itself
        if ConnectionAddress.sameOrigin(origin, url.absoluteString) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" || scheme == "mailto" || scheme == "tel" {
            UIApplication.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(.allow)
        guard navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, ConnectionAddress.sameOrigin(origin, http.url?.absoluteString) else { return }
        mainFrameRefused = http.statusCode >= 400
        if http.statusCode == 503 { onOffline?("None of your PCs is reachable right now. Autark must be running on one of them.") }
        else if http.statusCode >= 400 { onOffline?("The PC answered HTTP \(http.statusCode).") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ConnectionAddress.sameOrigin(origin, webView.url?.absoluteString) else { return }
        if let path = webView.url?.path, path.hasPrefix("/files/") { return } // a stored file opened as the page: the person's content, no port
        if mainFrameRefused { webView.scrollView.refreshControl?.endRefreshing(); return } // an error answer stays an error, the page is not "online"
        onOffline?(nil)
        webView.scrollView.refreshControl?.endRefreshing()
        startHello()
        if let route = pendingRoute { open(url: route) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        onOffline?("Autark must be running on one of your PCs, and this phone needs internet.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() } // the renderer died: open the same place again

    /// A link that wants a new window (target=_blank) opens outside the app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // the app's own page (and only it) may use camera and microphone; iOS still asks the person once
        decisionHandler(ConnectionAddress.sameOrigin(self.origin, "\(origin.protocol)://\(origin.host):\(origin.port)") ? .grant : .deny)
    }

    /// JavaScript dialogs of the page (alert, confirm) as native sheets.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        present(UIAlertController(title: nil, message: message, preferredStyle: .alert), actions: [("OK", .default, { completionHandler() })])
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        present(UIAlertController(title: nil, message: message, preferredStyle: .alert),
                actions: [("Cancel", .cancel, { completionHandler(false) }), ("OK", .default, { completionHandler(true) })])
    }

    private func present(_ alert: UIAlertController, actions: [(String, UIAlertAction.Style, () -> Void)]) {
        for (title, style, run) in actions { alert.addAction(UIAlertAction(title: title, style: style) { _ in run() }) }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let top = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { actions.last?.2(); return }
        var presenter = top
        while let next = presenter.presentedViewController { presenter = next }
        presenter.present(alert, animated: true)
    }
}

/// The user content controller keeps its handler alive; this one lets the bridge go.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: PageBridge?
    init(_ target: PageBridge) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// Hosts the bridge's web view in SwiftUI.
struct PageView: UIViewRepresentable {
    let bridge: PageBridge
    func makeUIView(context: Context) -> WKWebView { bridge.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
