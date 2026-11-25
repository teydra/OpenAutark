// Owns: reading the colour strings the page sends for the system bars (computed style: rgb()/rgba(), or #rgb/#rrggbb) and
// whether a colour is light enough for dark bar icons. Ported from CssColor.java.
// Never: depends on a platform framework (host tests run it).
import Foundation

public enum CssColor {
    /// An opaque 0xFFRRGGBB value, or the fallback for anything else (transparent, unknown words, garbage).
    public static func parse(_ css: String?, fallback: UInt32) -> UInt32 {
        guard let css = css else { return fallback }
        let value = css.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hex = Set("0123456789abcdef")
        if value.hasPrefix("#") {
            let digits = Array(value.dropFirst())
            if digits.allSatisfy({ hex.contains($0) }) {
                if digits.count == 6, let n = UInt32(String(digits), radix: 16) { return 0xFF000000 | n }
                if digits.count == 3 {
                    let r = UInt32(String(digits[0]), radix: 16)!, g = UInt32(String(digits[1]), radix: 16)!, b = UInt32(String(digits[2]), radix: 16)!
                    return 0xFF000000 | (r * 17 << 16) | (g * 17 << 8) | (b * 17)
                }
            }
            return fallback
        }
        if (value.hasPrefix("rgb(") || value.hasPrefix("rgba(")), value.hasSuffix(")"), let open = value.firstIndex(of: "(") {
            let inner = value[value.index(after: open)..<value.index(before: value.endIndex)].trimmingCharacters(in: .whitespaces)
            let parts = inner.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "/" }).map(String.init)
            if parts.count < 3 { return fallback }
            if parts.count > 3 {
                guard let alpha = Double(parts[3].replacingOccurrences(of: "%", with: "")) else { return fallback }
                if alpha == 0 { return fallback }
            }
            guard let r = channel(parts[0]), let g = channel(parts[1]), let b = channel(parts[2]) else { return fallback }
            return 0xFF000000 | (r << 16) | (g << 8) | b
        }
        return fallback
    }

    /// True when dark icons read better on this colour (relative luminance above the middle).
    public static func isLight(_ color: UInt32) -> Bool {
        let r = linear(Int((color >> 16) & 0xFF)), g = linear(Int((color >> 8) & 0xFF)), b = linear(Int(color & 0xFF))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179
    }

    private static func channel(_ part: String) -> UInt32? {
        guard let value = Double(part) else { return nil }
        return UInt32(max(0, min(255, value.rounded())))
    }

    private static func linear(_ channel: Int) -> Double {
        let c = Double(channel) / 255.0
        return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
}
