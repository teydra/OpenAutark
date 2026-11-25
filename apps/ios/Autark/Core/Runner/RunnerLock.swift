// Owns: whether the iPhone counts as locked for the Autark runner (PROTOKOLL-RUNNER.md 5.2 `locked`, 7 `locked`, 9.6; Konrad's
// decision #53 of 21.11.2026: when the iPhone locks during a task the agent pauses and asks for an unlock in the Live Activity; a
// device code is never typed). The runner on the iPhone reads the signals; deciding from them, and which operations the lock
// refuses, is here and tested on Linux. Never: types, taps or swipes anything to find out.
import Foundation

/// The signals the runner can read, each nil when it could not be read on this device.
public struct RunnerLockSignals: Equatable {
    /// State of the Darwin notification `com.apple.springboard.lockstate` (public notify API, notify.h): 1 = locked.
    public var notify: UInt64?
    /// A BOOL getter of the XCTest runtime's XCUIDevice that answers "screen locked", found by name at run time (undocumented).
    public var device: Bool?
    /// SpringBoard shows a code entry (a password field, or the number pad of the device code). nil = not looked at.
    public var passcode: Bool?

    public init(notify: UInt64? = nil, device: Bool? = nil, passcode: Bool? = nil) {
        self.notify = notify
        self.device = device
        self.passcode = passcode
    }

    /// true when at least one source that says "locked" or "unlocked" without looking at the screen exists on this device.
    public var hasSource: Bool { notify != nil || device != nil }
}

public enum RunnerLock {
    public static let notifyName = "com.apple.springboard.lockstate"
    /// Logged in the CI only (screen dark), not part of the decision.
    public static let blankedName = "com.apple.springboard.hasBlankedScreen"
    /// Getter names tried on XCUIDevice, in order (only a method with no arguments that returns BOOL is used).
    public static let deviceGetters = ["isScreenLocked", "screenLocked", "isLocked"]

    /// locked: any source saying locked wins (a visible code entry always counts); all readable sources saying unlocked: false;
    /// nothing readable: nil (unknown – the PC checks itself).
    public static func decide(_ s: RunnerLockSignals) -> Bool? {
        if s.passcode == true { return true }
        if let notify = s.notify, notify != 0 { return true }
        if s.device == true { return true }
        if s.hasSource { return false }
        return nil
    }

    /// The operations refused while the iPhone is locked (section 5): every input except the home and volume buttons; reading
    /// (state, screenshot, tree) goes on.
    public static func refuses(_ op: RunnerOp) -> Bool {
        switch op {
        case .state, .screenshot, .tree: return false
        case .button(let name): return !(name == "home" || name == "volume_up" || name == "volume_down")
        case .tap, .swipe, .text, .openURL, .openBundle: return true
        }
    }

    /// Before these the runner also looks for a code entry in SpringBoard, so a code is never typed even when no lock source exists
    /// (or a source is wrong): the operations that could put digits into it.
    public static func checksCodeEntry(_ op: RunnerOp) -> Bool {
        switch op {
        case .tap, .swipe, .text: return true
        default: return false
        }
    }

    /// A code entry in a SpringBoard tree, without reading any language: an on-screen password field, or an on-screen number pad –
    /// buttons or keys whose label starts with each of the ten digits 0–9 (any script; "2 ABC" counts as 2) and is at most 8
    /// characters long. Off-screen elements (another page, the cover sheet above) do not count.
    public static func codeEntryVisible(_ root: RunnerElement, screen: RunnerScreen) -> Bool {
        var digits = Set<Int>()
        var found = false
        func visit(_ e: RunnerElement) {
            if found { return }
            let onScreen = e.frame.map { !$0.isEmpty && $0.intersects(width: screen.width, height: screen.height) } ?? false
            if onScreen {
                if e.type == "SecureTextField" {
                    found = true
                    return
                }
                if e.type == "Button" || e.type == "Key", let digit = leadingDigit(e.label) {
                    digits.insert(digit)
                    if digits.count == 10 {
                        found = true
                        return
                    }
                }
            }
            for child in e.children { visit(child) }
        }
        visit(root)
        return found
    }

    static func leadingDigit(_ label: String) -> Int? {
        let trimmed = label.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.count <= 8, let first = trimmed.first, let value = first.wholeNumberValue, (0...9).contains(value) else { return nil }
        // "1", "2 ABC", "2, ABC": a single digit, then nothing that is a digit (so "10:41", a clock, is not a key).
        if trimmed.dropFirst().first?.wholeNumberValue != nil { return nil }
        return value
    }
}
