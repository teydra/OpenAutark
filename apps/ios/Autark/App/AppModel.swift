// Owns: what the app is doing – which level the person sees (connect, scanner, code, wait, page), the pairing run, the
// companies and their one live connection (PhoneConnection with its local entrance), what the page asks of the app (bar
// colours, haptics, switching, adding and forgetting a company, refusals) and the lifecycle (reconnect when the app comes forward and
// when the network changes, a look for a newer interface and its reload), the wake of a closed PC the page asks for ('wake' →
// 'woken', through the meeting-server link) and the notification scaffold (Notifier, PushRegistration: nothing asks the person at
// launch). The interface is the app's own (PhoneUi: the bundle's `ui` folder and signed files fetched since); no PC serves it and no
// native screen covers it – the page shows its own connection state. The decisions are Android's MainActivity ones; the screens are SwiftUI.
// Wave 2 (21.11.2026): beside the page the app keeps its own socket to the PC (UseLink, like Android's) for the AI's questions on the
// Live Activity (PhoneUseResponder → LiveController, phoneUse.reply / phoneUse.control) and the quick ways in (QuickCenter: App Intents,
// Control Center, Lock Screen widgets, share extension posts, dictation); one shared model (AppModel.shared) so an intent that launched
// the app in the background finds the same connection.
// Never: keeps a secret anywhere but the keychain store, or talks to a PC outside PhoneConnection.
import SwiftUI
import UIKit
import Network
import AutarkCore

@MainActor
final class AppModel: ObservableObject {
    /// `entrance`: the company's fixed local port is taken by another app – the app tries again every 3 seconds (Android's EntranceScreen).
    enum Screen: Equatable { case start, scan, code, waiting, page, entrance }

    @Published var screen: Screen = .start
    /// "Add a company": the connect level has a back arrow that returns to the page.
    @Published var cancelable = false
    @Published var typed = ""
    @Published var message = ""
    @Published var waiting = PairRun.Wait(line: "Connecting…", code: nil)
    /// Why the page's document did not load (nothing is shown for it: the page, from the app's own copy, shows its connection state itself;
    /// the app only loads it again in a moment). Kept for the logs and tests.
    @Published var offline: String?
    @Published var connectionLine = ""
    @Published var connected = false
    @Published var topColor = Palette.chromeLight
    @Published var bottomColor = Palette.chromeLight
    @Published var askForget = false
    /// What the entrance level says while the company's port is taken.
    @Published var entranceLine = ""
    /// The dictation sheet is open (DictateIntent, the Control Center's Diktat, autark://dictate).
    @Published var dictating = false
    /// A short line about the last quick send ("Screenshot sent to …"), shown over the page for a moment.
    @Published var quickNote: String?
    /// autark://shot asks first: any app or web page can open the link, so the newest screenshot goes only after the person's tap.
    @Published var confirmShot = false

    /// The app's one model: the SwiftUI scene and the App Intents (which may launch the app in the background) share it.
    static let shared: AppModel = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        ? AppModel()
        : AppModel(notices: SystemNoticeCenter(), pushPlatform: SystemPushPlatform(), useConnector: URLSessionConnector())

    let bridge = PageBridge()
    private let store: StringStore
    private let companies: Companies
    private let connector: WebSocketConnector
    private var connection: PhoneConnection?
    private var running: Pairing?
    private var leftFrom: Screen = .start
    private var monitor: NWPathMonitor?
    private var lastPathSatisfied: Bool?
    private let gate: String
    private var notifier: Notifier?
    private var push: PushRegistration?
    /// The connector of the app's own /ws socket (nil: no socket – unit tests that bring a fake meeting server).
    private let useConnector: WebSocketConnector?
    /// The app's own socket to the page's PC and what answers the AI's questions on it.
    private(set) var useLink: UseLink?
    private(set) var responder: PhoneUseResponder?
    private var liveTokens: LiveTokens?
    private var started = false
    /// The interface the entrance answers from (the app's bundle, plus the signed files fetched since).
    private let ui: PhoneUi
    /// The page's voice is live (its 'voice.live'): a newer interface waits until the call ends (Android's voiceLive).
    private var voiceLive = false
    private var retryGeneration = 0
    /// Launch arguments of a CI run against a real PC (see start()).
    private var relayOverride: String?
    private var pendingChat: String?
    #if AUTARK_SIM_E2E && targetEnvironment(simulator)
    /// Simulator CI run only; not compiled into the distributed app.
    private var e2e: E2EDriver?
    #endif

    /// `notices` and `pushPlatform` are the system's (the app passes them; a unit-test process has no notification center, so tests pass
    /// fakes or none).
    init(store: StringStore = KeychainStore(), connector: WebSocketConnector = URLSessionConnector(), notices: NoticeCenter? = nil, pushPlatform: PushPlatform? = nil, useConnector: WebSocketConnector? = nil, ui: PhoneUi = PhoneUi.shared) {
        self.store = store
        self.connector = connector
        self.useConnector = useConnector
        self.ui = ui
        self.companies = Companies(store: store)
        let secret = store.get("gate").flatMap { $0.isEmpty ? nil : $0 } ?? Crypto.b64url(Crypto.random(24))
        store.put("gate", secret)
        self.gate = secret
        bridge.onMessage = { [weak self] type, message in self?.fromPage(type, message) }
        bridge.onOffline = { [weak self] reason in self?.pageOffline(reason) }
        bridge.onForgetAddress = { [weak self] in self?.askForget = true }
        if let notices = notices {
            let notifier = Notifier(center: notices)
            notifier.onOpen = { [weak self] url in onMain { self?.bridge.open(url: url) } }
            notifier.onAnswer = { [weak self] id, answer in
                onMain { var message: [String: Any] = ["t": "notice.answer", "answer": answer]; if let id = id { message["id"] = id }; self?.bridge.send(message) }
            }
            (notices as? SystemNoticeCenter)?.notifier = notifier
            self.notifier = notifier
            AppDelegate.onRemote = { [weak notifier] payload in notifier?.receive(payload) }
        }
        if let platform = pushPlatform {
            let enabled = (Bundle.main.object(forInfoDictionaryKey: "AutarkPushEnabled") as? Bool) == true
            #if DEBUG
            let environment = PushEnvironment.sandbox
            #else
            let environment = PushEnvironment.production
            #endif
            let registration = PushRegistration(platform: platform, sink: PagePushSink(send: { [weak self] message in MainActor.assumeIsolated { self?.bridge.send(message) } }), store: store,
                                                bundleId: Bundle.main.bundleIdentifier ?? "com.teydralab.autark", environment: environment, enabled: enabled)
            AppDelegate.onToken = { token in onMain { registration.didRegister(deviceToken: token) } }
            AppDelegate.onFailure = { message in onMain { registration.didFail(message) } }
            push = registration
        }
    }

    /// The person agreed to notifications (the page's 'notify.enable', or the launch argument -AutarkNotifyDemo): iOS is asked once and
    /// the push registration starts when this build has push (AutarkPushEnabled in Info.plist; off until the Apple account, the
    /// entitlement and the server part exist).
    func enableNotifications() {
        notifier?.requestAuthorization { [weak self] _ in onMain { self?.push?.enable() } }
    }

    // MARK: start

    /// Opens the current company's page, or the connect level; `arguments` are launch arguments (screenshots, tests).
    func start(arguments: [String] = ProcessInfo.processInfo.arguments) {
        if started { return } // the scene's onAppear after an intent already started it (or a second appearance)
        started = true
        watchNetwork()
        func argument(_ name: String) -> String? {
            guard let at = arguments.firstIndex(of: name), at + 1 < arguments.count else { return nil }
            return arguments[at + 1]
        }
        if argument("-AutarkNotifyDemo") != nil {
            // a device check without a server: asks once, then shows one local notice of each kind
            enableNotifications()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                MainActor.assumeIsolated {
                    self?.notifier?.receive(PushPayload(title: "Autark", body: "A local notice: the app shows the PC's notices like this.", url: "/#/home", tag: "demo", kind: "reply", id: "demo-1"))
                    self?.notifier?.receive(PushPayload(title: "Allow the PC to go on?", body: "The AI asks, you tap once.", tag: "ask", id: "demo-2", ask: true))
                }
            }
        }
        if let kind = argument("-AutarkLiveDemo") {
            // the Live Activity's look without a PC (simulator screenshots, a first device check): a sample state, no connection
            LiveController.shared.startDemo(kind)
            screen = .start
            message = "Live Activity demo: " + kind
            return
        }
        // CI run against a real headless PC (apps/ios/Tools/e2e-pc.mjs): -AutarkRelay is the meeting server of that run (the app's own
        // default otherwise), -AutarkConnect pairs with that Remote ID at once (no typing in the Simulator), -AutarkChat opens that chat as
        // soon as the page is there. Nothing here is read in a normal launch.
        relayOverride = argument("-AutarkRelay")
        pendingChat = argument("-AutarkChat")
        #if AUTARK_SIM_E2E && targetEnvironment(simulator)
        if let status = argument("-AutarkE2EStatus"), let chatId = pendingChat {
            let files = ui.files
            e2e = E2EDriver(web: bridge.webView, statusPath: status, chatId: chatId, uiServed: { files.served })
            e2e?.start()
        }
        #endif
        if let remoteId = argument("-AutarkConnect"), companies.currentPaired == nil {
            connect(remoteId)
            return
        }
        if let level = argument("-AutarkScreen") {
            // a fixed starting level for the CI screenshots of the app; it pairs with nothing
            switch level {
            case "code": typed = argument("-AutarkPrefill") ?? ""; screen = .code
            case "scan": screen = .scan
            default: screen = .start
            }
            return
        }
        if let paired = companies.currentPaired { open(paired) } else { screen = .start }
    }

    private func open(_ paired: Paired) {
        closeConnection()
        let link = PhoneConnection(paired: paired, connector: connector, status: { [weak self] text, connected in
            onMain { self?.linkStatus(text, connected) }
        })
        link.onLinked { [weak self] in onMain { self?.bridge.send(["t": "resume"]) } }
        // the PC list the page's PC told (new PCs, their direct addresses) is kept with the company
        let companyId = companies.currentId
        link.onPcsChanged { [weak self] pcs in onMain { if let id = companyId { self?.companies.setPcs(company: id, pcs) } } }
        // another PC takes over the page: its identity goes to the page BEFORE the entrance hands that PC's channel to any stream
        link.onPageChannel { [weak self, weak link] fingerprint in
            let announced = DispatchSemaphore(value: 0)
            onMain {
                if let self = self, let link = link, self.connection === link { self.announceOwner(fingerprint) }
                announced.signal()
            }
            _ = announced.wait(timeout: .now() + 2)
        }
        retryGeneration += 1
        do {
            // the interface is the app's own: the entrance answers it from `ui`, only the PC's data paths go through a channel
            let origin = try link.start(port: companies.port, gate: gate, ui: ui.files)
            connection = link
            connectionLine = "Reaching the meeting server…"
            connected = false
            offline = nil
            voiceLive = false
            announceOwner(paired.pcs.first?.fingerprint) // the locally chosen PC owns the offline cache; first, then the page
            bridge.load(origin: origin, token: paired.token, gate: gate)
            openUseLink(origin: origin, paired: paired)
            screen = .page
            cancelable = false
            pushCompanies()
        } catch {
            let reason = (error as? AutarkError)?.message ?? error.localizedDescription
            if companies.port > 0 {
                // the company's own port (the page's origin, so its storage stays) is taken by something else: wait for it, never pick another
                entranceLine = reason
                screen = .entrance
                let generation = retryGeneration
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self = self, self.retryGeneration == generation, self.screen == .entrance else { return }
                        self.open(paired)
                    }
                }
            } else {
                screen = .start
                message = reason
            }
        }
    }

    /// The page's document did not load (the entrance died, the web view was cut off): the page is the app's own, so nothing is shown
    /// for it – the app loads it again in a moment (the page shows its own connection state once it is there).
    private func pageOffline(_ reason: String?) {
        offline = reason
        guard reason != nil, screen == .page else { return }
        let generation = retryGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            MainActor.assumeIsolated {
                guard let self = self, self.retryGeneration == generation, self.screen == .page, self.offline != nil else { return }
                self.bridge.reload()
            }
        }
    }

    private func closeConnection() {
        retryGeneration += 1
        connection?.stop()
        connection = nil
        useLink?.stop()
        useLink = nil
        responder = nil
    }

    /// The app's own socket through the local entrance (UseLink): the AI's questions on the Live Activity, the tokens, the quick sends.
    private func openUseLink(origin: String, paired: Paired) {
        guard let useConnector = useConnector else { return }
        let bounds = UIScreen.main.nativeBounds
        let use = UseLink(origin: origin, gate: gate, token: paired.token, deviceId: paired.deviceId, model: AppModel.deviceModel(),
                          screen: (Int(bounds.width), Int(bounds.height)), connector: useConnector)
        let answering = PhoneUseResponder()
        answering.onReply = { [weak use] reply in use?.send("phoneUse.reply", reply) }
        answering.onControl = { [weak use] params in use?.send("phoneUse.control", params) }
        answering.onShow = { state in onMain { LiveController.shared.show(state) } }
        use.onRequest = { [weak answering] request in answering?.handle(request) }
        #if DEBUG
        let environment = PushEnvironment.sandbox
        #else
        let environment = PushEnvironment.production
        #endif
        let tokens = LiveTokens(bundle: Bundle.main.bundleIdentifier ?? "com.teydralab.autark", environment: environment) { [weak use] params, done in
            guard let use = use else { done(false); return }
            use.call("phone.liveToken", params) { result in if case .success = result { done(true) } else { done(false) } }
        }
        use.onLinked = { [weak use] up in
            guard up, let use = use else { return }
            tokens.flush()
            QuickCenter.sendInbox(use)
            spawn("autark-chat-list") { if let chats = try? QuickSend.fetchChats(use), !chats.isEmpty { QuickCenter.inbox.saveChats(chats) } }
        }
        LiveController.shared.tokens = tokens
        LiveController.shared.watchPush()
        liveTokens = tokens
        responder = answering
        useLink = use
        use.start()
    }

    /// iOS launched the app for an intent (or the scene appears): the connection runs once.
    func ensureStarted() { start() }

    /// Pause / Continue / Stop from the Live Activity: the responder when it knows the run, else straight to the PC (an activity the
    /// PC started by push while the app was not running).
    func control(job: String, action: String) {
        guard let responder = responder else { return }
        let done: Bool
        switch action {
        case "pause": done = responder.pause(job: job)
        case "continue": done = responder.resume(job: job)
        default: done = responder.stop(job: job)
        }
        if !done, let link = useLink {
            let sent = action == "pause" || action == "continue" ? action : "stop"
            _ = link.send("phoneUse.control", ["job": job, "action": sent])
            LiveController.shared.mark(job: job, action: sent) // the activity came by push: it shows the press too
        }
    }

    /// Opens the page at a chat (or at home): autark://chat/<id>, OpenChatIntent, the controls.
    func openChat(_ id: String?) {
        ensureStarted()
        guard screen == .page else { return }
        bridge.open(url: id.map { "/#/chat/" + $0 } ?? "/#/home")
    }

    /// The phone's model name for phoneUse.attach ("iPhone17,1"), like Android's Build.MODEL.
    static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self) }
        if machine.isEmpty || machine == "x86_64" || machine == "arm64" { return UIDevice.current.model } // the simulator
        return machine
    }

    // MARK: connect levels

    func showScanner() { message = ""; screen = .scan }

    func showCode(prefill: String? = nil) {
        if let prefill = prefill { typed = prefill }
        message = ""
        screen = .code
    }

    func backFromLevel() {
        switch screen {
        case .scan, .code: message = ""; screen = .start
        case .waiting: cancelPairing()
        case .start: if cancelable { cancelable = false; screen = .page }
        case .page, .entrance: break
        }
    }

    /// A pair link opened the app (Universal Link or autark://pair/<id>): the code level, filled in.
    func openLink(_ url: URL) {
        if url.scheme == "autark", let host = url.host, host != "pair" {
            switch host {
            case "chat": openChat(url.pathComponents.dropFirst().first)
            case "dictate": dictating = true
            case "shot": openChat(QuickCenter.lastChat?.id); confirmShot = true
            default: openChat(nil)
            }
            return
        }
        guard let id = ConnectionAddress.fromLink(url.absoluteString) else { return }
        if screen == .page { cancelable = true } // already paired: "Add a company"
        typed = id
        showCode()
    }

    /// The scanner read some text; true when it was an Autark pair code (it connects), false to keep scanning.
    @discardableResult
    func scanned(_ text: String) -> Bool {
        guard let id = ConnectionAddress.scanned(text) else { message = "That QR code is not from Autark."; return false }
        connect(id)
        return true
    }

    func connectTyped() {
        do { connect(try ConnectionAddress.remoteId(typed)) }
        catch { message = (error as? AutarkError)?.message ?? "The Remote ID has nine digits." }
    }

    private func connect(_ remoteId: String) {
        leftFrom = screen == .waiting ? leftFrom : screen
        screen = .waiting
        message = ""
        let name = UIDevice.current.name
        running = PairRun.start(remoteId: remoteId, name: name, connector: connector, relay: relayOverride ?? ConnectionAddress.defaultRelay, status: { [weak self] wait in
            onMain { self?.waiting = wait }
        }, done: { [weak self] paired, reason in
            onMain { self?.pairingDone(paired, reason) }
        })
    }

    private func pairingDone(_ paired: Paired?, _ reason: String?) {
        running = nil
        guard let paired = paired else {
            screen = leftFrom == .waiting ? .start : leftFrom
            message = reason ?? "Pairing failed."
            return
        }
        companies.add(paired)
        typed = ""
        open(paired)
        if let chat = pendingChat { pendingChat = nil; bridge.open(url: "/#/chat/" + chat) } // CI run: the route waits for the page
    }

    private func cancelPairing() {
        running?.cancel()
        running = nil
        screen = leftFrom == .waiting ? .start : leftFrom
        message = ""
    }

    // MARK: the page

    private func fromPage(_ type: String, _ message: [String: Any]) {
        switch type {
        case "colors":
            let top = CssColor.parse(Json.str(message, "top"), fallback: 0xFFF3F3F3)
            let bottom = CssColor.parse(Json.str(message, "bottom"), fallback: 0xFFF5F5F5)
            topColor = Color(argb: top)
            bottomColor = Color(argb: bottom)
            bridge.webView.underPageBackgroundColor = UIColor(argb: top)
        case "haptic": UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "card": companies.setCard(name: Json.str(message, "name"), avatar: Json.str(message, "avatar")); pushCompanies()
        case "switch": if let id = Json.str(message, "id") { switchCompany(id) }
        case "add": cancelable = true; typed = ""; self.message = ""; screen = .start
        case "forget": askForget = true
        case "voice.live": voiceLive = message["on"] as? Bool == true
        case "refused": connection?.refused()
        case "wake": wakePc(message)
        case "notify.enable": enableNotifications()
        default: break // speak, download, shot, voice.live, bubble.* … come with later stages
        }
    }

    /// W: the page's Wake while no PC answers – through this company's own meeting-server link, off the main thread; the page hears
    /// 'woken' {id} or {id, error} (device-wake.ts).
    private func wakePc(_ message: [String: Any]) {
        guard let id = Json.str(message, "id") else { return }
        guard let link = connection else { bridge.send(["t": "woken", "id": id, "error": "The Autark app on this phone is not ready yet – try again in a moment."]); return }
        let key = Json.str(message, "key")
        let name = Json.str(message, "name") ?? "Your PC"
        spawn("autark-wake") { [weak self] in
            var failure: String?
            do { try link.wakePc(wakePub: key, name: name) } catch { failure = (error as? AutarkError)?.message ?? "The wake did not go through." }
            let error = failure
            onMain {
                var reply: [String: Any] = ["t": "woken", "id": id]
                if let error = error { reply["error"] = error }
                self?.bridge.send(reply)
            }
        }
    }

    private func linkStatus(_ text: String, _ isConnected: Bool) {
        connectionLine = text
        connected = isConnected
        var status: [String: Any] = ["t": "status", "connected": isConnected, "wake": true] // wake: the page may send {t:'wake'} (device-wake.ts)
        if isConnected, let pc = connection?.pcName { status["pc"] = pc }
        bridge.send(status)
        pushCompanies()
    }

    /// Tells the page whose data it may show offline: this company and this PC – or nobody when the PC is not one of the company's.
    func announceOwner(_ fingerprint: String?) {
        let known = companies.currentPaired?.pcs.contains { $0.fingerprint == fingerprint } == true
        bridge.send(OfflineOwner.message(companyId: companies.currentId, pcFingerprint: known ? fingerprint : nil))
    }

    private func pushCompanies() {
        guard let parsed = try? Json.parse(companies.listJson(pcName: connected ? connection?.pcName : nil)), let list = parsed as? [Any] else { return }
        bridge.send(["t": "companies", "list": list])
    }

    func switchCompany(_ id: String) {
        guard companies.setCurrent(id), let paired = companies.currentPaired else { return }
        open(paired)
    }

    /// "Forget this phone": this company's keys, web storage and entrance go, then the next company or the connect level.
    func forgetCurrent() {
        let id = companies.currentId
        bridge.send(OfflineOwner.message(companyId: nil, pcFingerprint: nil)) // no owner any more
        closeConnection()
        bridge.unload()
        bridge.forgetWebData {}
        companies.remove(id)
        connected = false
        if let paired = companies.currentPaired { open(paired) } else { cancelable = false; typed = ""; screen = .start; push?.forget() } // no company left: no push token to keep
    }

    // MARK: lifecycle

    func scenePhaseChanged(_ phase: ScenePhase) {
        connection?.front(phase == .active) // in front the link's tries stay at most 2 s apart (Android's onResume/onPause)
        if phase == .active {
            connection?.check()
            useLink?.nudge()
            push?.deliverPending()
            // a newer interface that a look found ready loads now – not while the page's voice is live (Android's onResume)
            if screen == .page, !voiceLive, ui.reloadDue { bridge.reload() }
            ui.resumed()
        }
    }

    private func watchNetwork() {
        if monitor != nil { return }
        let watcher = NWPathMonitor()
        watcher.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            onMain {
                guard let self = self else { return }
                // every change to a usable network checks the link at once (the first report is only the starting state)
                if self.lastPathSatisfied != nil && satisfied { self.connection?.check() }
                self.lastPathSatisfied = satisfied
            }
        }
        watcher.start(queue: DispatchQueue(label: "autark-network"))
        monitor = watcher
    }
}

/// Runs `work` on the main thread, in order, as the main actor – for the callbacks of the core's threads.
func onMain(_ work: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated { work() } }
}

// MARK: colours

enum Palette {
    static let chromeLight = Color(argb: 0xFFF3F3F3)
}

extension Color {
    init(argb: UInt32) {
        self.init(.sRGB, red: Double((argb >> 16) & 0xFF) / 255, green: Double((argb >> 8) & 0xFF) / 255, blue: Double(argb & 0xFF) / 255, opacity: 1)
    }
}

extension UIColor {
    convenience init(argb: UInt32) {
        self.init(red: CGFloat((argb >> 16) & 0xFF) / 255, green: CGFloat((argb >> 8) & 0xFF) / 255, blue: CGFloat(argb & 0xFF) / 255, alpha: 1)
    }
}
