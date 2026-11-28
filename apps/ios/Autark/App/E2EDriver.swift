// Simulator CI only: inspect the actual WKWebView and use its existing Composer input/Send handlers.
// No direct RPC. The two markers allow the test to capture the filled composer before enabling Send.
#if AUTARK_SIM_E2E && targetEnvironment(simulator)
import UIKit
import WebKit

@MainActor
final class E2EDriver {
    private let web: WKWebView
    private let statusPath: String
    private let chatRoute: String
    private var timer: Timer?
    private var busy = false
    private var blankSince: Date?
    private var reloads = 0

    /// How many requests the app's own interface answered itself (UiFiles.served): the run's proof that the page came from the app.
    private let uiServed: () -> Int

    init(web: WKWebView, statusPath: String, chatId: String, uiServed: @escaping () -> Int) {
        self.web = web
        self.statusPath = statusPath
        self.chatRoute = "#/chat/" + chatId
        self.uiServed = uiServed
    }

    func start() {
        // Observe bootstrap asset load errors; report only a count, never a URL or token.
        web.configuration.userContentController.addUserScript(WKUserScript(source: """
        window.__autarkE2EAssetErrors = 0;
        window.addEventListener('error', function (event) {
          const el = event.target;
          if (el?.tagName === 'SCRIPT' || (el?.tagName === 'LINK' && ['stylesheet', 'modulepreload'].includes(el.rel))) {
            window.__autarkE2EAssetErrors++;
          }
        }, true);
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        report("{\"phase\":\"started\",\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard !busy, let encoded = try? JSONEncoder().encode(chatRoute),
              let route = String(data: encoded, encoding: .utf8) else { return }
        busy = true
        let drive = FileManager.default.fileExists(atPath: statusPath + ".go")
        let send = FileManager.default.fileExists(atPath: statusPath + ".send")
        web.evaluateJavaScript(Self.probe(route: route, drive: drive, send: send)) { [weak self] result, _ in
            MainActor.assumeIsolated {
                guard let self = self else { return }
                self.busy = false
                self.observe(result as? String, driving: drive)
            }
        }
    }

    private func observe(_ json: String?, driving: Bool) {
        guard let json, var state = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else {
            report("{\"phase\":\"no-page\"}")
            return
        }
        // A 503 on main.js or CSS leaves a successful HTML document with an empty root.
        // Retry that same origin from the server, before input only; never reload a running chat.
        if !driving, state["blankShell"] as? Bool == true, !web.isLoading, reloads < 2 {
            let now = Date()
            let since = blankSince ?? now
            blankSince = since
            if now.timeIntervalSince(since) >= 12 {
                reloads += 1
                blankSince = nil
                print("AUTARK-E2E reloading blank phone shell, attempt \(reloads)")
                web.reloadFromOrigin()
            }
        } else {
            blankSince = nil
        }
        state["bootstrapReloads"] = reloads
        state["uiServed"] = uiServed()
        state["pid"] = Int(ProcessInfo.processInfo.processIdentifier)
        if let encoded = try? JSONSerialization.data(withJSONObject: state, options: .sortedKeys),
           let line = String(data: encoded, encoding: .utf8) {
            report(line)
        }
    }

    private func report(_ json: String) {
        try? json.write(toFile: statusPath, atomically: true, encoding: .utf8)
    }

    private static func probe(route: String, drive: Bool, send: Bool) -> String {
        """
        (function (route, drive, allowSend) {
          const s = window.__autarkSimE2E ||= { sent: false };
          const atChat = location.hash === route;
          function visible(el) {
            if (!el) return false;
            for (let node = el; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
            }
            const r = el.getBoundingClientRect();
            const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
            if (!r.width || !r.height || x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return false;
            return el.contains(document.elementFromPoint(x, y));
          }
          const box = atChat ? document.querySelector('textarea.composer-input') : null;
          const canType = visible(box) && !box.disabled && !box.readOnly;
          const connectCard = /Connect this phone/.test(document.body?.innerText || '');
          if (drive && canType && !connectCard && !s.sent && box.value === '') {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Hallo');
            box.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const button = atChat ? document.querySelector('button.send-button[aria-label="Send"]') : null;
          const sendReady = canType && box.value === 'Hallo' && visible(button) && !button.disabled;
          if (allowSend && drive && sendReady && !connectCard && !s.sent) {
            s.sent = true;
            button.click();
          }
          const root = document.querySelector('#app');
          const blankShell = document.readyState === 'complete' && !!root && !root.children.length;
          const texts = atChat ? Array.from(document.querySelectorAll('.message-body')).filter(visible).map(el => el.innerText.trim()) : [];
          return JSON.stringify({
            phase: 'page', blankShell, rendered: !!root && root.children.length > 0, poisoned: (document.documentElement.outerHTML || '').includes('POISONED-PC-UI'), textLength: (document.body?.innerText || '').length, assetErrors: window.__autarkE2EAssetErrors || 0,
            notReachable: (document.body?.innerText || '').toLowerCase().includes('not reachable'),
            waitingFor: (document.body?.innerText || '').includes('Waiting for'),
            nothingHere: (document.body?.innerText || '').includes('Nothing for you here'),
            tokenPending: location.hash.startsWith('#token='),
            atChat, composer: canType, connectCard, sendReady, sent: s.sent,
            halloVisible: texts.includes('Hallo'),
            echoVisible: texts.some(t => t.startsWith('Echo:') && t.endsWith('Hallo'))
          });
        })(\(route), \(drive ? "true" : "false"), \(send ? "true" : "false"))
        """
    }
}
#endif
