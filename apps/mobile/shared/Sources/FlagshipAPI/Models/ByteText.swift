import Foundation

/// Byte sizes in the reader's language: the number with the locale's decimal mark ("3,4") and the unit from the
/// string catalog ("Go" / "Mo" in French), never a fixed "3.4 GB" (store review: French screens showed "GB").
public enum ByteText {
    private static let kib = 1024.0, mib = kib * 1024, gib = mib * 1024

    private static func number(_ v: Double, _ decimals: Int) -> String {
        v.formatted(.number.precision(.fractionLength(decimals)).grouping(.never))
    }

    public static func gb(_ n: Int64, decimals: Int) -> String {
        let v = number(Double(n) / gib, decimals)
        return String(localized: "\(v) GB")
    }

    public static func mb(_ n: Int64, decimals: Int) -> String {
        let v = number(Double(n) / mib, decimals)
        return String(localized: "\(v) MB")
    }

    public static func kb(_ n: Int64, decimals: Int) -> String {
        let v = number(Double(n) / kib, decimals)
        return String(localized: "\(v) KB")
    }

    /// One decimal under 10 GB, none above (the box's own `formatGb`).
    public static func gbAuto(_ n: Int64) -> String { gb(n, decimals: Double(n) < 10 * gib ? 1 : 0) }

    /// KB, MB or GB with one decimal for GB (the server page's meters).
    public static func meter(_ n: Int64) -> String {
        let b = Double(n)
        if b >= gib { return gb(n, decimals: 1) }
        if b >= mib { return mb(n, decimals: 0) }
        if b >= kib { return kb(n, decimals: 0) }
        return "\(n) B"
    }
}
