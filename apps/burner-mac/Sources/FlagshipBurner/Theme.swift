import SwiftUI

/// Compact native tokens. Deliberately small — Mac users expect dense
/// information; SwiftUI's defaults are sized for iPad-style
/// touch targets which read as oversized on a desktop window.
enum FB {
    enum Colors {
        static let bg = Color(NSColor.windowBackgroundColor)
        static let surface = Color(NSColor.controlBackgroundColor)
        static let surfaceElevated = Color(NSColor.textBackgroundColor)
        static let border = Color(NSColor.separatorColor)
        static let textMuted = Color.secondary
        static let primary = Color.accentColor
        static let danger = Color(NSColor.systemRed)
        static let success = Color(NSColor.systemGreen)
        static let warning = Color(NSColor.systemOrange)
    }

    enum Spacing {
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 20
        static let s6: CGFloat = 24
        static let s8: CGFloat = 32
    }

    enum Radius {
        static let sm: CGFloat = 6
        static let md: CGFloat = 10
        static let lg: CGFloat = 14
    }

    enum Font {
        /// 17pt rounded semibold — window title, used sparingly
        static func title() -> SwiftUI.Font {
            .system(.title3, design: .rounded, weight: .semibold)
        }
        /// 13pt medium — row title
        static func rowTitle() -> SwiftUI.Font {
            .system(.body, weight: .medium)
        }
        /// 13pt regular — row subtitle / hint
        static func rowHint() -> SwiftUI.Font {
            .system(.callout)
        }
        /// 11pt — captions, helper text
        static func caption() -> SwiftUI.Font {
            .system(.caption)
        }
        /// 11pt mono — paths, hashes, commands
        static func mono() -> SwiftUI.Font {
            .system(.caption, design: .monospaced)
        }
    }
}
