// The runner's operations against XCUIAutomation (PROTOKOLL-RUNNER.md 5, RUNNER-DESIGN.md 2.5/2.6), on the main thread. Public API
// for everything but the finger curve (the XCTest runtime's pointer path, found at run time, else a straight line) and one lock
// signal (an XCUIDevice getter, used only when found by name). Lock: RunnerLock decides from the public notify state, that getter
// and a code entry in SpringBoard's tree; while locked every input but home and volume answers `locked`. XCTest's
// findings and Objective-C exceptions during an operation become its error code; error messages are fixed English text, never what
// the screen shows. Nothing is stored: no picture, tree or text outlives its answer.
import UIKit
import XCTest

@MainActor
final class RunnerOps {
    static let springboardId = RunnerTree.springboard

    let diag: Bool
    private let springboard = XCUIApplication(bundleIdentifier: RunnerTree.springboard)
    private var apps = [String: XCUIApplication]()
    private var front = RunnerFront()
    private var caps = Set<String>()
    private var pathReady = false
    private var lastOrientation = "portrait"
    /// The XCUIDevice getter for "screen locked" when this XCTest runtime has one (found by name and signature at setup).
    private var lockGetter: String?
    /// At setup a lock source (notify state or getter) answered: `lock_state` is offered and the code entry is only looked for
    /// before inputs; without one `state` looks for it too.
    private var lockSource = false
    private weak var shared: RunnerShared?

    init(diag: Bool) { self.diag = diag }

    private func log(_ line: String) { print("AUTARK-RUNNER \(line)") }

    private func app(_ id: String) -> XCUIApplication {
        if id == Self.springboardId { return springboard }
        if let known = apps[id] { return known }
        let made = XCUIApplication(bundleIdentifier: id)
        apps[id] = made
        return made
    }

    // MARK: setup

    /// Capabilities, device, screen; with AUTARK_RUNNER_DIAG=1 also the evidence the CI log needs (pointer path methods, type table).
    func setup() -> RunnerShared {
        pathReady = ATKRunnerBridge.pathAvailable()
        caps = ["open.url", "jpeg"]
        if pathReady { caps.insert("path") }
        let device = XCUIDevice.shared
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        if device.hasHardwareButton(.volumeUp) && device.hasHardwareButton(.volumeDown) { caps.insert("button.volume") }
        if #available(iOS 18.0, *), device.hasHardwareButton(.camera) { caps.insert("button.camera") }
        #endif
        #if !targetEnvironment(simulator)
        // In the Simulator pressing it took 5.8 s and ran past the 5 s limit (CI run 44951831619): offered on a device only.
        if device.hasHardwareButton(.action) { caps.insert("button.action") }
        #endif
        lockGetter = ATKRunnerBridge.boolGetter(of: XCUIDevice.shared, among: RunnerLock.deviceGetters)
        lockSource = lockSignals(codeEntry: false).hasSource
        if lockSource { caps.insert("lock_state") }
        measureScreen()
        let screen = screenNow()
        let ui = UIDevice.current
        let info = Bundle(for: RunnerOps.self).infoDictionary ?? [:]
        let welcome: JSONObject = [
            "runner": [
                "version": info["CFBundleShortVersionString"] as? String ?? "0.1.0",
                "build": info["CFBundleVersion"] as? String ?? "1",
                "protocol": RunnerWire.version,
                "bundle": Bundle.main.bundleIdentifier ?? "com.teydralab.autark.runner.xctrunner",
            ] as JSONObject,
            "device": [
                "name": ui.name,
                "model": Self.model(),
                "system": ui.systemName,
                "version": ui.systemVersion,
                "simulator": simulator,
            ] as JSONObject,
            "screen": screen.json,
            "caps": caps.sorted(),
            "limits": ["textMax": RunnerWire.textMax, "swipePointsMax": RunnerWire.swipePointsMax, "treeNodesMax": RunnerWire.treeNodesMax] as JSONObject,
        ]
        if diag {
            log("caps \(caps.sorted().joined(separator: ","))")
            log("screen \(Json.write(screen.json)) native \(Int(UIScreen.main.nativeBounds.width))x\(Int(UIScreen.main.nativeBounds.height))")
            log("pointer path available: \(pathReady)")
            log("methods XCPointerEventPath: \(ATKRunnerBridge.methods(of: "XCPointerEventPath"))")
            log("methods XCSynthesizedEventRecord: \(ATKRunnerBridge.methods(of: "XCSynthesizedEventRecord"))")
            let checks: [(XCUIElement.ElementType, String)] = [(.application, "Application"), (.button, "Button"), (.cell, "Cell"), (.staticText, "StaticText"),
                                                               (.secureTextField, "SecureTextField"), (.`switch`, "Switch"), (.searchField, "SearchField"), (.textField, "TextField")]
            let wrong = checks.filter { RunnerTree.typeName(raw: Int($0.0.rawValue)) != $0.1 }.map { "\($0.1)=\($0.0.rawValue)" }
            log("element type table: \(wrong.isEmpty ? "matches XCUIElement.ElementType" : "MISMATCH " + wrong.joined(separator: ","))")
            log("springboard state at start: \(springboard.state.rawValue)")
            log("lock: notify \(RunnerLock.notifyName)=\(ATKRunnerBridge.notifyState(RunnerLock.notifyName)) \(RunnerLock.blankedName)=\(ATKRunnerBridge.notifyState(RunnerLock.blankedName)), XCUIDevice getter \(lockGetter ?? "none"), lock_state \(lockSource)")
            log("methods XCUIDevice: \(ATKRunnerBridge.methods(of: "XCUIDevice"))")
            let started = Date()
            log("lock-related selectors of XC classes: \(ATKRunnerBridge.selectorsOfXCClasses(matching: ["screenlock", "islocked", "lockstate", "lockbutton", "lockscreen", "passcode"])) (\(Int(Date().timeIntervalSince(started) * 1000)) ms)")
        }
        let shared = RunnerShared(welcome: welcome, caps: caps)
        self.shared = shared
        return shared
    }

    static func model() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: &system.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    // MARK: screen

    private func orientationName() -> String {
        switch XCUIDevice.shared.orientation {
        case .portrait: lastOrientation = "portrait"
        case .portraitUpsideDown: lastOrientation = "portrait_upside_down"
        case .landscapeLeft: lastOrientation = "landscape_left"
        case .landscapeRight: lastOrientation = "landscape_right"
        default: break // face up/down, unknown: the interface keeps its last orientation
        }
        return lastOrientation
    }

    /// UIInterfaceOrientation for the event record (the device's landscape left is the interface's landscape right).
    private func interfaceOrientation() -> Int {
        switch orientationName() {
        case "portrait_upside_down": return 2
        case "landscape_left": return 4
        case "landscape_right": return 3
        default: return 1
        }
    }

    /// The panel in portrait points and its pixels per point. Not from UIScreen: the runner's own host app has no launch screen, so
    /// iOS runs it in the old 320×480 compatibility mode (CI run 44950636780: UIScreen said 320×480 on an iPhone 16 Pro Simulator).
    /// SpringBoard's frame is the screen in points; the screenshot's pixels give the scale.
    private var portrait = (width: 0.0, height: 0.0, scale: 0.0)

    private func measureScreen() {
        let frame = springboard.frame
        let image = XCUIScreen.main.screenshot().image
        let pixelsLong = Double(max(image.cgImage?.width ?? 0, image.cgImage?.height ?? 0))
        let pixelsShort = Double(min(image.cgImage?.width ?? 0, image.cgImage?.height ?? 0))
        var width = Double(min(frame.width, frame.height)), height = Double(max(frame.width, frame.height))
        if !(width >= 1 && height >= 1 && width.isFinite && height.isFinite) {
            let fallback = Double(UIScreen.main.scale)
            width = pixelsShort / fallback
            height = pixelsLong / fallback
        }
        let scale = height > 0 && pixelsLong > 0 ? (pixelsLong / height).rounded() : Double(UIScreen.main.scale)
        portrait = (width, height, max(1, scale))
        if diag {
            log("screen: springboard frame \(Int(frame.width))x\(Int(frame.height)) pt, screenshot \(Int(pixelsShort))x\(Int(pixelsLong)) px, UIScreen \(Int(UIScreen.main.bounds.width))x\(Int(UIScreen.main.bounds.height)) pt scale \(UIScreen.main.scale)")
        }
    }

    func screenNow() -> RunnerScreen {
        if portrait.height <= 0 { measureScreen() }
        let screenNow = RunnerScreen.from(nativeWidth: portrait.width * portrait.scale, nativeHeight: portrait.height * portrait.scale,
                                          scale: portrait.scale, orientation: orientationName())
        shared?.setScreen(screenNow)
        return screenNow
    }

    // MARK: front app

    private func frontApp() -> String? {
        let started = Date()
        let budget: TimeInterval = front.last == nil ? 8 : 3
        return front.find(isForeground: { [unowned self] id in self.app(id).state == .runningForeground },
                          budget: { Date().timeIntervalSince(started) < budget })
    }

    /// The element whose coordinates the input is anchored to: the app seen last if it is still in front, else SpringBoard.
    private func anchor() -> XCUIApplication {
        if let last = front.last, last != Self.springboardId {
            let candidate = app(last)
            if candidate.state == .runningForeground { return candidate }
        }
        return springboard
    }

    // MARK: lock (RunnerLock decides)

    /// The lock signals now. `codeEntry`: also look for a code entry in SpringBoard's tree (a snapshot, so only where it matters).
    private func lockSignals(codeEntry: Bool) -> RunnerLockSignals {
        var signals = RunnerLockSignals()
        let notify = ATKRunnerBridge.notifyState(RunnerLock.notifyName)
        if notify >= 0 { signals.notify = UInt64(notify) }
        if let getter = lockGetter {
            let value = ATKRunnerBridge.callBool(XCUIDevice.shared, getter: getter)
            if value >= 0 { signals.device = value == 1 }
        }
        if codeEntry { signals.passcode = codeEntryVisible() }
        return signals
    }

    private func codeEntryVisible() -> Bool {
        let started = Date()
        guard let snapshot = try? springboard.snapshot() else {
            if diag { log("lock: no SpringBoard snapshot for the code entry check") }
            return false
        }
        var budget = 20_000
        let root = RunnerSnapshot.element(snapshot, depth: 0, maxDepth: 60, budget: &budget)
        let visible = RunnerLock.codeEntryVisible(root, screen: screenNow())
        if diag { log("lock: code entry \(visible) in \(Int(Date().timeIntervalSince(started) * 1000)) ms") }
        return visible
    }

    private func lockedNow(codeEntry: Bool) -> Bool? {
        let signals = lockSignals(codeEntry: codeEntry)
        let locked = RunnerLock.decide(signals)
        if diag {
            log("lock: notify \(signals.notify.map { String($0) } ?? "-") blanked \(ATKRunnerBridge.notifyState(RunnerLock.blankedName)) device \(signals.device.map { "\($0)" } ?? "-") code \(signals.passcode.map { "\($0)" } ?? "-") -> \(locked.map { "\($0)" } ?? "null")")
        }
        return locked
    }

    // MARK: run

    func run(_ op: RunnerOp, apps installed: [String]) -> RunnerAnswer {
        if installed != front.installed { front.installed = installed }
        RunnerIssues.begin()
        var answer = RunnerAnswer.fail(.internal, "The operation did not finish.")
        let raised = ATKRunnerBridge.catching {
            // Konrad #53 / protocol 9.6: no input while locked, and never into a code entry (looked for before tap, swipe, text).
            if RunnerLock.refuses(op), self.lockedNow(codeEntry: RunnerLock.checksCodeEntry(op)) == true {
                answer = .fail(.locked, "The iPhone is locked.")
            } else {
                answer = self.perform(op)
            }
        }
        let issue = RunnerIssues.end()
        if let raised = raised {
            if diag { log("op=\(op.name) raised: \(raised)") }
            return failure(op, issue: raised)
        }
        if let issue = issue, answer.ok {
            if diag { log("op=\(op.name) XCTest finding: \(issue)") }
            return failure(op, issue: issue)
        }
        return answer
    }

    /// The error code for an operation XCTest refused. The finding's text only decides the code; it never goes into the answer.
    private func failure(_ op: RunnerOp, issue: String) -> RunnerAnswer {
        let text = issue.lowercased()
        switch op {
        case .text:
            if text.contains("focus") { return .fail(.noFocus, "No field has the keyboard focus.") }
            return .fail(.inputFailed, "iOS did not type the text.")
        case .openBundle:
            if text.contains("not installed") || text.contains("unable to find") || text.contains("could not be found") || text.contains("no such") || text.contains("unknown") {
                return .fail(.appNotFound, "No app with this bundle id is installed.")
            }
            return .fail(.openFailed, "iOS did not open the app.")
        case .openURL: return .fail(.openFailed, "iOS did not open the link.")
        case .tree: return .fail(.treeFailed, "iOS returned no UI tree.")
        case .screenshot: return .fail(.screenshotFailed, "iOS returned no screenshot.")
        case .tap, .swipe, .button: return .fail(.inputFailed, "iOS did not carry out the input.")
        case .state: return .fail(.internal, "The state could not be read.")
        }
    }

    private func perform(_ op: RunnerOp) -> RunnerAnswer {
        switch op {
        case .state: return state()
        case .screenshot(let format, let quality, let maxEdge): return screenshot(format: format, quality: quality, maxEdge: maxEdge)
        case .tree(let bundle, let maxNodes, let maxDepth, let all): return tree(bundle: bundle, maxNodes: maxNodes, maxDepth: maxDepth, all: all)
        case .tap(let x, let y, let count, let holdMs): return tap(x: x, y: y, count: count, holdMs: holdMs)
        case .swipe(let points): return swipe(points)
        case .text(let text): return typeText(text)
        case .button(let name): return button(name)
        case .openURL(let url): return open(url: url)
        case .openBundle(let bundle): return open(bundle: bundle)
        }
    }

    private static func frontJSON(_ bundle: String?) -> Any { bundle.map { ["bundle": $0] as JSONObject } ?? NSNull() }

    // MARK: state, screenshot, tree

    private func state() -> RunnerAnswer {
        // Without a lock source the code entry is the only sign; with one, the cheap signals decide.
        let locked = lockedNow(codeEntry: !lockSource)
        if locked == true {
            // The lock screen is SpringBoard's; the app seen last stays remembered for after the unlock.
            let keyboard = springboard.keyboards.count > 0
            return .done(["front": Self.frontJSON(Self.springboardId), "screen": screenNow().json, "locked": true, "keyboard": keyboard, "alert": false])
        }
        let id = frontApp()
        let target = app(id ?? Self.springboardId)
        let keyboard = target.keyboards.count > 0
        let alert = id != Self.springboardId && springboard.alerts.count > 0
        return .done(["front": Self.frontJSON(id), "screen": screenNow().json, "locked": locked.map { $0 as Any } ?? NSNull(), "keyboard": keyboard, "alert": alert])
    }

    private func screenshot(format: String, quality: Double, maxEdge: Int?) -> RunnerAnswer {
        let shot = XCUIScreen.main.screenshot()
        let image = shot.image
        let screen = screenNow()
        if format == "png" {
            let data = shot.pngRepresentation
            guard !data.isEmpty else { return .fail(.screenshotFailed, "iOS returned no screenshot.") }
            let width = image.cgImage?.width ?? Int(image.size.width * image.scale)
            let height = image.cgImage?.height ?? Int(image.size.height * image.scale)
            return .done(["format": "png", "width": width, "height": height, "screen": screen.json], binary: Bytes(data))
        }
        let pixelWidth = CGFloat(image.cgImage?.width ?? Int(image.size.width * image.scale))
        let pixelHeight = CGFloat(image.cgImage?.height ?? Int(image.size.height * image.scale))
        var size = CGSize(width: pixelWidth, height: pixelHeight)
        if let edge = maxEdge, max(pixelWidth, pixelHeight) > CGFloat(edge) {
            let factor = CGFloat(edge) / max(pixelWidth, pixelHeight)
            size = CGSize(width: (pixelWidth * factor).rounded(), height: (pixelHeight * factor).rounded())
        }
        let rendererFormat = UIGraphicsImageRendererFormat()
        rendererFormat.scale = 1
        rendererFormat.opaque = true
        let drawn = UIGraphicsImageRenderer(size: size, format: rendererFormat).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let data = drawn.jpegData(compressionQuality: CGFloat(quality)) else { return .fail(.screenshotFailed, "The screenshot could not be encoded.") }
        return .done(["format": "jpeg", "width": Int(size.width), "height": Int(size.height), "screen": screen.json], binary: Bytes(data))
    }

    private func tree(bundle: String?, maxNodes: Int, maxDepth: Int, all: Bool) -> RunnerAnswer {
        let frontId: String?
        let rootId: String
        if let bundle = bundle {
            let target = app(bundle)
            let state = target.state
            if state == .unknown || state == .notRunning { return .fail(.appNotFound, "This app is not running (or not installed).") }
            rootId = bundle
            frontId = state == .runningForeground ? bundle : (front.last == bundle ? nil : front.last)
        } else if lockSource, lockedNow(codeEntry: false) == true {
            frontId = Self.springboardId // the lock screen
            rootId = Self.springboardId
        } else {
            frontId = frontApp()
            rootId = frontId ?? Self.springboardId
        }
        let snapshot: XCUIElementSnapshot
        do {
            snapshot = try app(rootId).snapshot()
        } catch {
            return .fail(.treeFailed, "iOS returned no UI tree.")
        }
        var budget = 20_000
        var roots = [(element: RunnerSnapshot.element(snapshot, depth: 0, maxDepth: maxDepth, budget: &budget), app: rootId)]
        if rootId != Self.springboardId {
            let alert = springboard.alerts.firstMatch
            if alert.exists, let alertSnapshot = try? alert.snapshot() {
                roots.append((element: RunnerSnapshot.element(alertSnapshot, depth: 0, maxDepth: maxDepth, budget: &budget), app: Self.springboardId))
            }
        }
        let screen = screenNow()
        let result = RunnerTree.flatten(roots: roots, screen: screen, maxNodes: maxNodes, maxDepth: maxDepth, all: all)
        return .done(RunnerTree.answer(front: frontId, screen: screen, result: result))
    }

    // MARK: input

    private func coordinate(_ base: XCUIApplication, _ x: Double, _ y: Double) -> XCUICoordinate {
        base.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: x, dy: y))
    }

    private func tap(x: Double, y: Double, count: Int, holdMs: Int) -> RunnerAnswer {
        let screen = screenNow()
        guard screen.contains(x: x, y: y) else { return .fail(.outOfBounds, "The point is outside the screen.", detail: ["screen": screen.bounds]) }
        let point = coordinate(anchor(), x, y)
        if holdMs > 0 {
            point.press(forDuration: Double(holdMs) / 1000)
        } else if count == 2 {
            point.doubleTap()
        } else {
            point.tap()
        }
        return .done()
    }

    private func swipe(_ points: [RunnerPoint]) -> RunnerAnswer {
        let screen = screenNow()
        if RunnerSwipe.outside(points, screen: screen) != nil {
            return .fail(.outOfBounds, "A point of the swipe is outside the screen.", detail: ["screen": screen.bounds])
        }
        if pathReady {
            let why = ATKRunnerBridge.swipe(xs: points.map { NSNumber(value: $0.x) }, ys: points.map { NSNumber(value: $0.y) },
                                            offsets: RunnerSwipe.offsets(points).map { NSNumber(value: $0) }, orientation: interfaceOrientation())
            if why == nil { return .done(["mode": "path"]) }
            log("pointer path refused (\(why!)): straight line instead")
        }
        let line = RunnerSwipe.line(points)
        let base = anchor()
        let start = coordinate(base, line.fromX, line.fromY)
        if line.velocity == 0 {
            start.press(forDuration: Double(line.pressMs) / 1000)
        } else {
            start.press(forDuration: max(0.05, Double(line.pressMs) / 1000), thenDragTo: coordinate(base, line.toX, line.toY),
                        withVelocity: XCUIGestureVelocity(rawValue: CGFloat(line.velocity)), thenHoldForDuration: Double(line.holdMs) / 1000)
        }
        return .done(["mode": "line"])
    }

    private func typeText(_ text: String) -> RunnerAnswer {
        anchor().typeText(text)
        return .done(["typed": text.unicodeScalars.count])
    }

    private func button(_ name: String) -> RunnerAnswer {
        let device = XCUIDevice.shared
        switch name {
        case "home":
            device.press(.home)
            front.didPressHome()
            return .done()
        case "action":
            guard caps.contains("button.action") else { return .fail(.unsupported, "This device has no action button.") }
            device.press(.action)
            return .done()
        case "volume_up", "volume_down":
            #if targetEnvironment(simulator)
            return .fail(.unsupported, "The Simulator has no volume buttons.")
            #else
            guard caps.contains("button.volume") else { return .fail(.unsupported, "This device has no volume buttons.") }
            device.press(name == "volume_up" ? .volumeUp : .volumeDown)
            return .done()
            #endif
        case "camera":
            #if targetEnvironment(simulator)
            return .fail(.unsupported, "The Simulator has no camera button.")
            #else
            guard caps.contains("button.camera") else { return .fail(.unsupported, "This device has no camera button.") }
            if #available(iOS 18.0, *) { device.press(.camera) }
            return .done()
            #endif
        default:
            return .fail(.badRequest, "Unknown button.")
        }
    }

    private func open(url: String) -> RunnerAnswer {
        guard let link = URL(string: url) else { return .fail(.badRequest, "The link is not valid.") }
        XCUIDevice.shared.system.open(link)
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 1.5))
        front.didOpenLink() // which app took the link is not known (XCUIApplication.state did not tell, CI run 44951831619)
        return .done(["front": Self.frontJSON(frontApp())])
    }

    private func open(bundle: String) -> RunnerAnswer {
        let target = app(bundle)
        target.activate()
        if !target.wait(for: .runningForeground, timeout: 10) {
            let state = target.state
            if state == .unknown || state == .notRunning { return .fail(.appNotFound, "No app with this bundle id is installed.") }
            return .fail(.openFailed, "iOS did not bring the app to the front.")
        }
        front.didOpen(bundle)
        return .done(["front": ["bundle": bundle] as JSONObject])
    }
}

/// XCUIElementSnapshot → RunnerElement (the pure data form of AutarkCore's RunnerTree).
@MainActor
enum RunnerSnapshot {
    static func element(_ s: XCUIElementSnapshot, depth: Int, maxDepth: Int, budget: inout Int) -> RunnerElement {
        let raw = Int(s.elementType.rawValue)
        let type = RunnerTree.typeName(raw: raw)
        let secure = type == "SecureTextField"
        var e = RunnerElement(type: type, label: s.label, value: secure ? "" : RunnerTree.valueText(s.value), identifier: s.identifier, title: s.title,
                              placeholder: s.placeholderValue ?? "", frame: rect(s.frame), enabled: s.isEnabled, selected: s.isSelected, focused: focused(s))
        let children = s.children
        if children.isEmpty || budget <= 0 { return e }
        if depth >= maxDepth {
            e.children = [RunnerElement(type: "Other")] // marks "there is more" for the depth limit
            return e
        }
        for child in children {
            guard budget > 0 else { break }
            budget -= 1
            e.children.append(element(child, depth: depth + 1, maxDepth: maxDepth, budget: &budget))
        }
        return e
    }

    static func rect(_ frame: CGRect) -> RunnerRect? {
        guard !frame.isNull, !frame.isInfinite else { return nil }
        let r = RunnerRect(x: Double(frame.origin.x), y: Double(frame.origin.y), width: Double(frame.size.width), height: Double(frame.size.height))
        return r.isUsable ? r : nil
    }

    /// `hasFocus` where the snapshot object answers it (read at run time, so no SDK difference breaks the build).
    static func focused(_ s: XCUIElementSnapshot) -> Bool {
        guard let object = s as AnyObject as? NSObject, object.responds(to: NSSelectorFromString("hasFocus")) else { return false }
        return (object.value(forKey: "hasFocus") as? Bool) ?? false
    }
}
