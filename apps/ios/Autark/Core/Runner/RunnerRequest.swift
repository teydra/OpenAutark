// Owns: the requests and answers of the Autark runner protocol v1 (PROTOKOLL-RUNNER.md, sections 2, 4, 5 and 7): which operations
// exist, which fields each takes and their limits, the error codes, the answer forms, the screen description, and the check
// that a point lies on the screen. A request that passes `RunnerRequest.parse` is safe to carry out; the runner on the iPhone
// only adds what needs the device. Never: reads screen content into an error message.
import Foundation

/// One point of a finger's way: points (not pixels), `t` = ms since touch-down.
public struct RunnerPoint: Equatable {
    public var x: Double
    public var y: Double
    public var t: Int

    public init(x: Double, y: Double, t: Int) {
        self.x = x
        self.y = y
        self.t = t
    }

    public var json: JSONObject { ["x": RunnerScreen.round1(x), "y": RunnerScreen.round1(y), "t": t] }
}

/// The operations that need the device (hello, auth, ping and end are answered by `RunnerSession` itself).
public enum RunnerOp: Equatable {
    case state
    case screenshot(format: String, quality: Double, maxEdge: Int?)
    case tree(bundle: String?, maxNodes: Int, maxDepth: Int, all: Bool)
    case tap(x: Double, y: Double, count: Int, holdMs: Int)
    case swipe([RunnerPoint])
    case text(String)
    case button(String)
    case openURL(String)
    case openBundle(String)

    public var name: String {
        switch self {
        case .state: return "state"
        case .screenshot: return "screenshot"
        case .tree: return "tree"
        case .tap: return "tap"
        case .swipe: return "swipe"
        case .text: return "text"
        case .button: return "button"
        case .openURL, .openBundle: return "open"
        }
    }

    /// Operations that change something on the iPhone (refused while it is locked).
    public var isInput: Bool {
        switch self {
        case .state, .screenshot, .tree: return false
        default: return true
        }
    }
}

/// The error codes of section 7.
public enum RunnerCode: String, CaseIterable {
    case badRequest = "bad_request"
    case unknownOp = "unknown_op"
    case unsupportedVersion = "unsupported_version"
    case unauthorized
    case authFailed = "auth_failed"
    case busy
    case notReady = "not_ready"
    case locked
    case noFocus = "no_focus"
    case outOfBounds = "out_of_bounds"
    case appNotFound = "app_not_found"
    case openFailed = "open_failed"
    case unsupported
    case treeFailed = "tree_failed"
    case screenshotFailed = "screenshot_failed"
    case inputFailed = "input_failed"
    case tooLarge = "too_large"
    case timeout
    case `internal`

    /// After these the runner closes the connection.
    public var closes: Bool { self == .unsupportedVersion || self == .unauthorized || self == .authFailed }
}

/// An answer without its id: the fields beside `id` and `ok`, and the binary attachment (only a screenshot has one).
public struct RunnerAnswer {
    public var ok: Bool
    public var fields: JSONObject
    public var binary: Bytes

    public static func done(_ fields: JSONObject = [:], binary: Bytes = []) -> RunnerAnswer {
        RunnerAnswer(ok: true, fields: fields, binary: binary)
    }

    /// `message` is short English text for logs, never screen content; `detail` only technical values.
    public static func fail(_ code: RunnerCode, _ message: String, detail: JSONObject? = nil) -> RunnerAnswer {
        var error: JSONObject = ["code": code.rawValue, "message": message]
        if let detail = detail { error["detail"] = detail }
        return RunnerAnswer(ok: false, fields: ["error": error], binary: [])
    }

    public var code: RunnerCode? {
        guard !ok, let error = fields["error"] as? JSONObject, let raw = error["code"] as? String else { return nil }
        return RunnerCode(rawValue: raw)
    }

    /// The whole frame for request `id`. An answer bigger than the limits becomes `too_large`.
    public func frame(id: Int) -> Bytes {
        var json = fields
        json["id"] = id
        json["ok"] = ok
        let bytes = RunnerWire.frame(json, binary)
        if bytes.count - 8 - binary.count > RunnerWire.answerJsonMax || binary.count > RunnerWire.answerBinMax {
            return RunnerAnswer.fail(.tooLarge, "The answer would be larger than the protocol allows.").frame(id: id)
        }
        return bytes
    }
}

/// The screen in points in its current orientation (section 4).
public struct RunnerScreen: Equatable {
    public var width: Double
    public var height: Double
    public var scale: Int
    public var orientation: String

    public init(width: Double, height: Double, scale: Int, orientation: String) {
        self.width = width
        self.height = height
        self.scale = scale
        self.orientation = orientation
    }

    public static let orientations = ["portrait", "portrait_upside_down", "landscape_left", "landscape_right", "unknown"]

    public var json: JSONObject { ["width": Self.round1(width), "height": Self.round1(height), "scale": scale, "orientation": orientation] }

    /// 0 ≤ x < width and 0 ≤ y < height.
    public func contains(x: Double, y: Double) -> Bool { x >= 0 && y >= 0 && x < width && y < height }

    public var bounds: JSONObject { ["width": Self.round1(width), "height": Self.round1(height)] }

    /// A coordinate with at most one decimal (integral values stay whole numbers on the wire).
    public static func round1(_ value: Double) -> Double { (value * 10).rounded() / 10 }

    /// Portrait points from the panel's native pixels and scale, turned to the device orientation.
    public static func from(nativeWidth: Double, nativeHeight: Double, scale: Double, orientation: String) -> RunnerScreen {
        let s = scale > 0 ? scale : 1
        let short = min(nativeWidth, nativeHeight) / s
        let long = max(nativeWidth, nativeHeight) / s
        let landscape = orientation == "landscape_left" || orientation == "landscape_right"
        return RunnerScreen(width: round1(landscape ? long : short), height: round1(landscape ? short : long), scale: Int(s.rounded()), orientation: orientation)
    }
}

/// What a request is, after every check that needs no device.
public enum RunnerRequest: Equatable {
    case hello(v: Int, nonce: Bytes)
    case auth(proof: Bytes, apps: [String])
    case ping
    case end
    case op(RunnerOp)

    public static let buttons = ["home", "volume_up", "volume_down", "action", "camera"]

    /// The id of a request: a whole number 1 … 2 147 483 647, else nil.
    public static func id(_ json: JSONObject) -> Int? {
        guard let value = json["id"] as? Double, value == value.rounded(), value >= 1, value <= 2_147_483_647 else { return nil }
        return Int(value)
    }

    /// Parses one request. The error answer says what is wrong (bad_request, unknown_op, unsupported, unsupported_version).
    /// `caps` are the runner's capabilities: a request that needs one it lacks answers `unsupported`.
    public static func parse(_ json: JSONObject, caps: Set<String>) -> Result<RunnerRequest, RunnerFailure> {
        guard let op = json["op"] as? String else { return .failure(.init(.badRequest, "The request has no op.")) }
        switch op {
        case "hello":
            guard let v = whole(json["v"]) else { return .failure(.init(.badRequest, "hello needs v.")) }
            if v < RunnerWire.version {
                return .failure(.init(.unsupportedVersion, "This runner speaks protocol version 1.", detail: ["supported": [RunnerWire.version]]))
            }
            guard let nonce = RunnerWire.hexBytes(json["nonce"] as? String, count: 16) else { return .failure(.init(.badRequest, "hello needs a nonce of 32 hex characters.")) }
            return .success(.hello(v: RunnerWire.version, nonce: nonce))
        case "auth":
            guard let proof = RunnerWire.hexBytes(json["proof"] as? String, count: 32) else { return .failure(.init(.badRequest, "auth needs a proof of 64 hex characters.")) }
            var apps = [String]()
            if let raw = json["apps"], !(raw is NSNull) {
                guard let list = raw as? [Any], list.count <= RunnerWire.appsMax else { return .failure(.init(.badRequest, "apps must be a list of at most 800 bundle ids.")) }
                for item in list {
                    guard let id = item as? String, isBundleId(id) else { return .failure(.init(.badRequest, "apps holds something that is not a bundle id.")) }
                    apps.append(id)
                }
            }
            return .success(.auth(proof: proof, apps: apps))
        case "ping": return .success(.ping)
        case "end": return .success(.end)
        case "state": return .success(.op(.state))
        case "screenshot": return screenshot(json, caps: caps)
        case "tree": return tree(json)
        case "tap": return tap(json)
        case "swipe": return swipe(json)
        case "text":
            guard let text = json["text"] as? String else { return .failure(.init(.badRequest, "text needs text.")) }
            let length = text.unicodeScalars.count
            guard length >= 1, length <= RunnerWire.textMax else { return .failure(.init(.badRequest, "text needs 1 to 400 characters.")) }
            return .success(.op(.text(text)))
        case "button":
            guard let name = json["name"] as? String, buttons.contains(name) else {
                return .failure(.init(.badRequest, "button needs name: home, volume_up, volume_down, action or camera."))
            }
            let cap: String? = name == "home" ? nil : (name.hasPrefix("volume") ? "button.volume" : "button." + name)
            if let cap = cap, !caps.contains(cap) { return .failure(.init(.unsupported, "This device has no such button.")) }
            return .success(.op(.button(name)))
        case "open": return open(json, caps: caps)
        default:
            return .failure(.init(.unknownOp, "Unknown operation."))
        }
    }

    // MARK: per operation

    private static func screenshot(_ json: JSONObject, caps: Set<String>) -> Result<RunnerRequest, RunnerFailure> {
        let format = (json["format"] as? String) ?? "png"
        guard format == "png" || format == "jpeg" else { return .failure(.init(.badRequest, "format is png or jpeg.")) }
        var quality = 0.7
        if let raw = json["quality"] {
            guard let q = raw as? Double, q >= 0.1, q <= 1.0 else { return .failure(.init(.badRequest, "quality is 0.1 to 1.0.")) }
            quality = q
        }
        var maxEdge: Int?
        if let raw = json["maxEdge"] {
            guard let edge = whole(raw), (320...4096).contains(edge) else { return .failure(.init(.badRequest, "maxEdge is 320 to 4096.")) }
            maxEdge = edge
        }
        if (format == "jpeg" || maxEdge != nil) && !caps.contains("jpeg") { return .failure(.init(.unsupported, "This runner sends PNG only.")) }
        if format == "png" { maxEdge = nil } // PNG always comes in full size (section 5.3)
        return .success(.op(.screenshot(format: format, quality: quality, maxEdge: maxEdge)))
    }

    private static func tree(_ json: JSONObject) -> Result<RunnerRequest, RunnerFailure> {
        var bundle: String?
        if let raw = json["bundle"] {
            guard let id = raw as? String, isBundleId(id) else { return .failure(.init(.badRequest, "bundle is not a bundle id.")) }
            bundle = id
        }
        var maxNodes = 1500
        if let raw = json["maxNodes"] {
            guard let n = whole(raw), (1...RunnerWire.treeNodesMax).contains(n) else { return .failure(.init(.badRequest, "maxNodes is 1 to 3000.")) }
            maxNodes = n
        }
        var maxDepth = 40
        if let raw = json["maxDepth"] {
            guard let n = whole(raw), (1...60).contains(n) else { return .failure(.init(.badRequest, "maxDepth is 1 to 60.")) }
            maxDepth = n
        }
        var all = false
        if let raw = json["all"] {
            guard let flag = raw as? Bool else { return .failure(.init(.badRequest, "all is true or false.")) }
            all = flag
        }
        return .success(.op(.tree(bundle: bundle, maxNodes: maxNodes, maxDepth: maxDepth, all: all)))
    }

    private static func tap(_ json: JSONObject) -> Result<RunnerRequest, RunnerFailure> {
        guard let x = finite(json["x"]), let y = finite(json["y"]) else { return .failure(.init(.badRequest, "tap needs x and y.")) }
        var count = 1
        if let raw = json["count"] {
            guard let n = whole(raw), n == 1 || n == 2 else { return .failure(.init(.badRequest, "count is 1 or 2.")) }
            count = n
        }
        var holdMs = 0
        if let raw = json["holdMs"] {
            guard let n = whole(raw), (0...5000).contains(n) else { return .failure(.init(.badRequest, "holdMs is 0 to 5000.")) }
            holdMs = n
        }
        if holdMs > 0 && count != 1 { return .failure(.init(.badRequest, "holdMs only with count 1.")) }
        return .success(.op(.tap(x: x, y: y, count: count, holdMs: holdMs)))
    }

    private static func swipe(_ json: JSONObject) -> Result<RunnerRequest, RunnerFailure> {
        guard let list = json["points"] as? [Any], list.count >= 2, list.count <= RunnerWire.swipePointsMax else {
            return .failure(.init(.badRequest, "swipe needs 2 to 32 points."))
        }
        var points = [RunnerPoint]()
        for item in list {
            guard let p = item as? JSONObject, let x = finite(p["x"]), let y = finite(p["y"]), let t = whole(p["t"]) else {
                return .failure(.init(.badRequest, "Every point needs x, y and t."))
            }
            points.append(RunnerPoint(x: x, y: y, t: t))
        }
        guard points[0].t == 0 else { return .failure(.init(.badRequest, "The first point has t 0.")) }
        for i in 1..<points.count where points[i].t <= points[i - 1].t {
            return .failure(.init(.badRequest, "t must rise from point to point."))
        }
        guard points[points.count - 1].t <= 10_000 else { return .failure(.init(.badRequest, "A swipe lasts at most 10000 ms.")) }
        return .success(.op(.swipe(points)))
    }

    private static func open(_ json: JSONObject, caps: Set<String>) -> Result<RunnerRequest, RunnerFailure> {
        let url = json["url"], bundle = json["bundle"]
        if (url == nil) == (bundle == nil) { return .failure(.init(.badRequest, "open needs exactly one of url and bundle.")) }
        if let raw = url {
            guard let text = raw as? String, text.utf8.count <= RunnerWire.urlMax, isWebLink(text) else {
                return .failure(.init(.badRequest, "open takes only http and https links."))
            }
            guard caps.contains("open.url") else { return .failure(.init(.unsupported, "This runner cannot open links.")) }
            return .success(.op(.openURL(text)))
        }
        guard let id = bundle as? String, isBundleId(id) else { return .failure(.init(.badRequest, "bundle is not a bundle id.")) }
        return .success(.op(.openBundle(id)))
    }

    // MARK: field checks

    /// `[A-Za-z0-9.-]`, 1–155 characters.
    public static func isBundleId(_ text: String) -> Bool {
        guard !text.isEmpty, text.utf8.count <= RunnerWire.bundleMax else { return false }
        return text.utf8.allSatisfy { c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c == 0x2e || c == 0x2d
        }
    }

    /// http:// or https:// (scheme in any case) with a host; nothing else (no tel:, sms:, own schemes).
    public static func isWebLink(_ text: String) -> Bool {
        guard let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let host = parts.host, !host.isEmpty else { return false }
        return true
    }

    static func whole(_ value: Any?) -> Int? {
        guard let number = value as? Double, number.isFinite, number == number.rounded(), abs(number) < 9e15 else { return nil }
        return Int(number)
    }

    static func finite(_ value: Any?) -> Double? {
        guard let number = value as? Double, number.isFinite else { return nil }
        return number
    }
}

/// A request the runner refuses before doing anything, with its error code.
public struct RunnerFailure: Error, Equatable {
    public let code: RunnerCode
    public let message: String
    public let detailText: String

    public init(_ code: RunnerCode, _ message: String, detail: JSONObject? = nil) {
        self.code = code
        self.message = message
        self.detailText = detail.map { Json.write($0) } ?? ""
        self.detail = detail
    }

    public let detail: JSONObject?

    public var answer: RunnerAnswer { .fail(code, message, detail: detail) }

    public static func == (a: RunnerFailure, b: RunnerFailure) -> Bool { a.code == b.code && a.message == b.message && a.detailText == b.detailText }
}
