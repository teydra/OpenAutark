// Owns: the tree answer of the Autark runner protocol v1 (PROTOKOLL-RUNNER.md 5.4 and 6) in its pure data form – a UI element as
// the runner read it from iOS, turned into the flat node list (document order, parents before children, i/p/d), with the limits
// (maxNodes, maxDepth, off-screen nodes), cut texts, password fields without value, and at most two roots (the app and a system
// dialog of SpringBoard). The runner on the iPhone fills `RunnerElement` from XCUIElementSnapshot; everything after that is here.
import Foundation

/// A rectangle in points.
public struct RunnerRect: Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var isUsable: Bool { x.isFinite && y.isFinite && width.isFinite && height.isFinite && width >= 0 && height >= 0 }
    public var isEmpty: Bool { width <= 0 || height <= 0 }

    public func intersects(width w: Double, height h: Double) -> Bool { x < w && y < h && x + width > 0 && y + height > 0 }

    public var json: [Double] { [RunnerScreen.round1(x), RunnerScreen.round1(y), RunnerScreen.round1(width), RunnerScreen.round1(height)] }
}

/// One UI element as iOS reports it (accessibility attributes), with its children.
public struct RunnerElement {
    public var type: String
    public var label: String
    public var value: String
    public var identifier: String
    public var title: String
    public var placeholder: String
    public var frame: RunnerRect?
    public var enabled: Bool
    public var selected: Bool
    public var focused: Bool
    public var children: [RunnerElement]

    public init(type: String, label: String = "", value: String = "", identifier: String = "", title: String = "", placeholder: String = "",
                frame: RunnerRect? = nil, enabled: Bool = true, selected: Bool = false, focused: Bool = false, children: [RunnerElement] = []) {
        self.type = type
        self.label = label
        self.value = value
        self.identifier = identifier
        self.title = title
        self.placeholder = placeholder
        self.frame = frame
        self.enabled = enabled
        self.selected = selected
        self.focused = focused
        self.children = children
    }
}

public enum RunnerTree {
    public static let textMax = 300
    public static let idMax = 200
    public static let springboard = "com.apple.springboard"

    /// Section 6: the element types by raw value of XCUIElement.ElementType (the runner maps by a fixed switch; this table is the
    /// check of that switch and the list the PC knows). An unknown value is "Other".
    public static let typeNames: [String] = [
        "Any", "Other", "Application", "Group", "Window", "Sheet", "Drawer", "Alert", "Dialog", "Button", "RadioButton", "RadioGroup",
        "CheckBox", "DisclosureTriangle", "PopUpButton", "ComboBox", "MenuButton", "ToolbarButton", "Popover", "Keyboard", "Key",
        "NavigationBar", "TabBar", "TabGroup", "Toolbar", "StatusBar", "Table", "TableRow", "TableColumn", "Outline", "OutlineRow",
        "Browser", "CollectionView", "Slider", "PageIndicator", "ProgressIndicator", "ActivityIndicator", "SegmentedControl", "Picker",
        "PickerWheel", "Switch", "Toggle", "Link", "Image", "Icon", "SearchField", "ScrollView", "ScrollBar", "StaticText", "TextField",
        "SecureTextField", "DatePicker", "TextView", "Menu", "MenuItem", "MenuBar", "MenuBarItem", "Map", "WebView", "IncrementArrow",
        "DecrementArrow", "Timeline", "RatingIndicator", "ValueIndicator", "SplitGroup", "Splitter", "RelevanceIndicator", "ColorWell",
        "HelpTag", "Matte", "DockItem", "Ruler", "RulerMarker", "Grid", "LevelIndicator", "Cell", "LayoutArea", "LayoutItem", "Handle",
        "Stepper", "Tab", "TouchBar", "StatusItem",
    ]

    public static func typeName(raw: Int) -> String { raw >= 0 && raw < typeNames.count ? typeNames[raw] : "Other" }

    /// Cuts a text to `max` characters, the last one being "…".
    public static func cut(_ text: String, _ max: Int) -> String {
        guard text.count > max else { return text }
        return String(text.prefix(max - 1)) + "…"
    }

    public struct Result {
        public var nodes: [JSONObject]
        public var truncated: Bool
    }

    /// The flat list. `roots`: the app (and, when a system dialog lies over it, SpringBoard's dialog as a second root), each with
    /// the bundle id it belongs to. Nodes deeper than `maxDepth` (root = 0) and nodes past `maxNodes` are left out and set
    /// `truncated`. Without `all`, a node whose frame lies wholly outside the screen is left out with everything below it
    /// (not counted as truncated); roots and nodes without a usable frame always stay.
    public static func flatten(roots: [(element: RunnerElement, app: String)], screen: RunnerScreen, maxNodes: Int, maxDepth: Int, all: Bool) -> Result {
        var nodes = [JSONObject]()
        var truncated = false
        // Iterative depth-first walk (a deep tree must not exhaust the stack): (element, parent index, depth, app of a root).
        for root in roots.prefix(2) {
            var stack: [(RunnerElement, Int, Int, String?)] = [(root.element, -1, 0, root.app)]
            while let item = stack.popLast() {
                let (element, parent, depth, app) = item
                if nodes.count >= maxNodes { truncated = true; break }
                if depth > 0, !all, let frame = element.frame, frame.isUsable, !frame.isEmpty, !frame.intersects(width: screen.width, height: screen.height) {
                    continue
                }
                let index = nodes.count
                nodes.append(node(element, index: index, parent: parent, depth: depth, app: app))
                if depth >= maxDepth {
                    if !element.children.isEmpty { truncated = true }
                    continue
                }
                for child in element.children.reversed() { stack.append((child, index, depth + 1, nil)) }
            }
            if nodes.count >= maxNodes && !stack.isEmpty { truncated = true }
            if truncated && nodes.count >= maxNodes { break }
        }
        return Result(nodes: nodes, truncated: truncated)
    }

    static func node(_ e: RunnerElement, index: Int, parent: Int, depth: Int, app: String?) -> JSONObject {
        var n: JSONObject = ["i": index, "p": parent, "d": depth, "type": e.type]
        if !e.label.isEmpty { n["label"] = cut(e.label, textMax) }
        let secure = e.type == "SecureTextField"
        if secure {
            n["secure"] = true // never a value, not even dots
        } else if !e.value.isEmpty {
            n["value"] = cut(e.value, textMax)
        }
        if !e.identifier.isEmpty { n["id"] = cut(e.identifier, idMax) }
        if !e.title.isEmpty && e.title != e.label { n["title"] = cut(e.title, textMax) }
        if !e.placeholder.isEmpty { n["placeholder"] = cut(e.placeholder, textMax) }
        if let frame = e.frame, frame.isUsable { n["frame"] = frame.json }
        if !e.enabled { n["enabled"] = false }
        if e.selected { n["selected"] = true }
        if e.focused { n["focused"] = true }
        if let app = app { n["app"] = app }
        return n
    }

    /// The answer fields of `tree` (beside id and ok).
    public static func answer(front: String?, screen: RunnerScreen, result: Result) -> JSONObject {
        [
            "front": front.map { ["bundle": $0] as JSONObject } ?? NSNull(),
            "screen": screen.json,
            "count": result.nodes.count,
            "truncated": result.truncated,
            "nodes": result.nodes,
        ]
    }

    /// A value as the protocol writes it: switches "1"/"0", numbers as text, anything else its text.
    public static func valueText(_ value: Any?) -> String {
        switch value {
        case nil: return ""
        case let text as String: return text
        case let flag as Bool: return flag ? "1" : "0"
        case let number as Double:
            return number == number.rounded() && abs(number) < 9e15 ? String(Int64(number)) : String(number)
        case let number as Int: return String(number)
        case is NSNull: return ""
        default: return String(describing: value!)
        }
    }
}

/// Which app is in front, without a public question for it (RUNNER-DESIGN.md 2.5). CI run 44951831619 (iOS 18.6 Simulator) showed
/// that XCUIApplication.state is not a reliable answer: Settings still said runningForeground seconds after the home button, and
/// Safari, opened by a link and visible, never did. So the runner trusts its own actions first – `open` with a bundle id (activate
/// and wait) puts that app in front, the home button puts SpringBoard in front, a link leaves it unknown – and asks `state` only
/// about apps it has no reason to think left the front: an app that went to the background through our own home button, link or
/// another `open` is not asked again until it is opened again. Taps that switch apps (a link inside an app, an icon on the home
/// screen) are not seen: the answer then stays the app before, until the PC opens one (the PC's phone.open does). Unknown is nil.
public struct RunnerFront {
    public var last: String?
    public private(set) var opened = [String]()
    public var installed = [String]()
    /// Apps that went to the background through our own action (not asked again until opened again).
    public private(set) var left = Set<String>()

    public init() {}

    /// `open` with a bundle id succeeded: that app is in front, every other app went behind it.
    public mutating func didOpen(_ bundle: String) {
        if let last = last, last != bundle { left.insert(last) }
        for id in opened where id != bundle { left.insert(id) }
        left.remove(bundle)
        opened.removeAll { $0 == bundle }
        opened.append(bundle)
        if opened.count > 16 { opened.removeFirst() }
        last = bundle
    }

    /// The home button: SpringBoard is in front; the app before went to the background.
    public mutating func didPressHome() {
        if let last = last, last != RunnerTree.springboard { left.insert(last) }
        for id in opened { left.insert(id) }
        last = RunnerTree.springboard
    }

    /// A link was opened: some app (the default browser, or the app the link belongs to) is in front now – which one is unknown.
    public mutating func didOpenLink() {
        if let last = last, last != RunnerTree.springboard { left.insert(last) }
        for id in opened { left.insert(id) }
        last = nil
    }

    /// The candidates to ask, in order, without SpringBoard, without apps that left the front, without repeats.
    public func candidates() -> [String] {
        var seen = Set<String>([RunnerTree.springboard]).union(left)
        var out = [String]()
        for id in ([last].compactMap { $0 } + opened.reversed() + installed) where !seen.contains(id) {
            seen.insert(id)
            out.append(id)
        }
        return out
    }

    /// The app in front. After the home button: SpringBoard, without asking. Else the candidates are asked with `isForeground`
    /// (the app seen last and the opened ones always, the PC's list only while `budget()` allows); none in front: nil.
    public mutating func find(isForeground: (String) -> Bool, budget: () -> Bool) -> String? {
        if last == RunnerTree.springboard { return RunnerTree.springboard }
        let known = Set([last].compactMap { $0 } + opened)
        for id in candidates() {
            if !known.contains(id) && !budget() { return nil }
            if isForeground(id) {
                last = id
                return id
            }
        }
        return nil
    }
}
