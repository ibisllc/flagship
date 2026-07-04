import Foundation

/// The single date/time formatter for every Apple-surface (iOS/iPad/watch)
/// UI string. Mirrors the Android `DateFormat.kt` and webapp `lib/dateFormat.js`
/// so all three surfaces render timestamps identically. Route every ad-hoc
/// `RelativeDateTimeFormatter` / `DateFormatter` in a screen through this — the
/// UI must never show a raw ISO string or a bare `DateFormatter` default.
///
/// Rules (v1 UX spec S2):
///   - < 60s            → "just now"
///   - < 60m            → "{n}m ago"
///   - < 24h            → "{n}h ago"
///   - same year        → "MMM d"  (or "MMM d, h:mm a" when `includeTime`)
///   - older            → "MMM d, yyyy"
/// Month names are locale-aware via `setLocalizedDateFormatFromTemplate`.
public extension Date {
    func flagshipFormatted(
        now: Date = Date(),
        includeTime: Bool = false,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let delta = now.timeIntervalSince(self)
        if delta >= 0 {
            if delta < 60 { return "just now" }
            if delta < 3600 { return "\(Int(delta / 60))m ago" }
            if delta < 86400 { return "\(Int(delta / 3600))h ago" }
        }

        let fmt = DateFormatter()
        fmt.locale = locale
        fmt.calendar = calendar
        let sameYear = calendar.component(.year, from: self) == calendar.component(.year, from: now)
        let template: String
        if sameYear {
            template = includeTime ? "MMMdhmma" : "MMMd"
        } else {
            template = includeTime ? "MMMdyyyyhmma" : "MMMdyyyy"
        }
        fmt.setLocalizedDateFormatFromTemplate(template)
        return fmt.string(from: self)
    }

    /// Convenience for the common case: an epoch-millisecond timestamp read
    /// straight off a wire model.
    static func flagshipFormatted(
        epochMs: Int64,
        now: Date = Date(),
        includeTime: Bool = false
    ) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000)
            .flagshipFormatted(now: now, includeTime: includeTime)
    }
}
