// Owns: the small JSON subset the relay and peer protocols use (objects, arrays, strings, numbers, booleans, null) as
// Swift `Any` values – [String: Any], [Any], String, Double (every parsed number), Bool, NSNull – ported from
// apps/android/.../relay/Json.java. Objects are written with sorted keys, so the same value always gives the same bytes.
// Never: depends on a platform framework beyond Foundation, so the same code runs on Linux in the host tests.
import Foundation

public typealias JSONObject = [String: Any]

public enum Json {
    /// Parses a JSON value; throws AutarkError when it is not JSON.
    public static func parse(_ text: String) throws -> Any? {
        var parser = Parser(Array(text.utf16))
        parser.space()
        let value = try parser.value(0)
        parser.space()
        if parser.at != parser.text.count { throw AutarkError("trailing data") }
        return value
    }

    public static func object(_ text: String) throws -> JSONObject {
        guard let value = try parse(text) as? JSONObject else { throw AutarkError("not an object") }
        return value
    }

    public static func str(_ map: JSONObject, _ key: String) -> String? { map[key] as? String }

    /// A whole number under `key`, else the fallback.
    public static func num(_ map: JSONObject, _ key: String, _ fallback: Int) -> Int {
        guard let number = map[key] as? Double, number == number.rounded(), abs(number) < 9e15 else {
            if let int = map[key] as? Int { return int }
            return fallback
        }
        return Int(number)
    }

    public static func write(_ value: Any?) -> String {
        var out = ""
        write(&out, value)
        return out
    }

    private static func write(_ out: inout String, _ value: Any?) {
        guard let value = value else { out += "null"; return }
        switch value {
        case is NSNull: out += "null"
        case let text as String: quote(&out, text)
        case let flag as Bool: out += flag ? "true" : "false"
        case let int as Int: out += String(int)
        case let int as Int64: out += String(int)
        case let int as UInt64: out += String(int)
        case let number as Double:
            if number == number.rounded() && abs(number) < 9e15 { out += String(Int64(number)) } else { out += "\(number)" }
        case let map as JSONObject:
            out += "{"
            var first = true
            for key in sortedKeys(Array(map.keys)) {
                if !first { out += "," }
                first = false
                quote(&out, key)
                out += ":"
                write(&out, map[key] ?? nil)
            }
            out += "}"
        case let list as [Any]:
            out += "["
            var first = true
            for item in list {
                if !first { out += "," }
                first = false
                write(&out, item)
            }
            out += "]"
        default:
            out += "null"
        }
    }

    /// JavaScript's default sort: UTF-16 code unit order.
    public static func sortedKeys(_ keys: [String]) -> [String] {
        keys.sorted { a, b in a.utf16.lexicographicallyPrecedes(b.utf16) }
    }

    private static func quote(_ out: inout String, _ text: String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += "\\u" + hex4(UInt16(scalar.value)) } else { out.unicodeScalars.append(scalar) }
            }
        }
        out += "\""
    }

    static func hex4(_ unit: UInt16) -> String {
        let digits = Array("0123456789abcdef")
        return String([digits[Int((unit >> 12) & 15)], digits[Int((unit >> 8) & 15)], digits[Int((unit >> 4) & 15)], digits[Int(unit & 15)]])
    }

    private struct Parser {
        let text: [UInt16]
        var at = 0

        init(_ text: [UInt16]) { self.text = text }

        func peek(_ c: Character) -> Bool { at < text.count && text[at] == String(c).utf16.first! }

        mutating func expect(_ c: Character) throws {
            if !peek(c) { throw AutarkError("expected \(c)") }
            at += 1
        }

        mutating func space() {
            while at < text.count, text[at] == 0x20 || text[at] == 0x09 || text[at] == 0x0a || text[at] == 0x0d { at += 1 }
        }

        func starts(_ word: String) -> Bool {
            let units = Array(word.utf16)
            if at + units.count > text.count { return false }
            for i in 0..<units.count where text[at + i] != units[i] { return false }
            return true
        }

        mutating func value(_ depth: Int) throws -> Any? {
            if depth > 32 { throw AutarkError("too deep") }
            if at >= text.count { throw AutarkError("end of input") }
            let c = text[at]
            if c == 0x7b { // {
                at += 1
                var out = JSONObject()
                space()
                if peek("}") { at += 1; return out }
                while true {
                    space()
                    if !peek("\"") { throw AutarkError("key expected") }
                    let key = try string()
                    space()
                    try expect(":")
                    space()
                    out[key] = try value(depth + 1) ?? NSNull()
                    space()
                    if peek(",") { at += 1; continue }
                    try expect("}")
                    return out
                }
            }
            if c == 0x5b { // [
                at += 1
                var out = [Any]()
                space()
                if peek("]") { at += 1; return out }
                while true {
                    space()
                    out.append(try value(depth + 1) ?? NSNull())
                    space()
                    if peek(",") { at += 1; continue }
                    try expect("]")
                    return out
                }
            }
            if c == 0x22 { return try string() }
            if starts("true") { at += 4; return true }
            if starts("false") { at += 5; return false }
            if starts("null") { at += 4; return nil }
            let start = at
            let allowed = Set("+-0123456789.eE".utf16)
            while at < text.count, allowed.contains(text[at]) { at += 1 }
            if start == at { throw AutarkError("unexpected character") }
            guard let number = Double(String(decoding: text[start..<at], as: UTF16.self)) else { throw AutarkError("bad number") }
            return number
        }

        mutating func string() throws -> String {
            try expect("\"")
            var out = [UInt16]()
            while at < text.count {
                let c = text[at]
                at += 1
                if c == 0x22 { return String(decoding: out, as: UTF16.self) }
                if c != 0x5c { out.append(c); continue }
                if at >= text.count { break }
                let e = text[at]
                at += 1
                switch e {
                case 0x6e: out.append(0x0a)
                case 0x72: out.append(0x0d)
                case 0x74: out.append(0x09)
                case 0x62: out.append(0x08)
                case 0x66: out.append(0x0c)
                case 0x75:
                    if at + 4 > text.count { throw AutarkError("bad escape") }
                    guard let unit = UInt16(String(decoding: text[at..<(at + 4)], as: UTF16.self), radix: 16) else { throw AutarkError("bad escape") }
                    out.append(unit)
                    at += 4
                default: out.append(e)
                }
            }
            throw AutarkError("unterminated string")
        }
    }
}
