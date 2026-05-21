import SwiftUI

/// Lightweight mirror of the iOS `FlagshipUI` token set. We deliberately
/// don't import FlagshipUI itself — that target depends on the full
/// Flagship/FlagshipAPI/FlagshipCore stack we don't need here. This file
/// re-states only the tokens the burner wizard actually touches, in
/// system fonts + system materials, matching the visual at a high level.
enum FB {
    enum Colors {
        static let bg = Color(NSColor.windowBackgroundColor)
        static let surface = Color(NSColor.controlBackgroundColor)
        static let textMuted = Color.secondary
        static let primary = Color(red: 0.231, green: 0.357, blue: 1.000)
        static let danger = Color(red: 0.784, green: 0.227, blue: 0.227)
        static let success = Color(red: 0.122, green: 0.541, blue: 0.298)
    }

    enum Spacing {
        static let s2: CGFloat = 8
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s6: CGFloat = 24
        static let s8: CGFloat = 32
    }

    enum Radius {
        static let md: CGFloat = 10
        static let lg: CGFloat = 16
    }

    enum Font {
        static func h2() -> SwiftUI.Font { .system(size: 28, weight: .medium) }
        static func h3() -> SwiftUI.Font { .system(size: 22, weight: .semibold) }
        static func h4() -> SwiftUI.Font { .system(size: 17, weight: .semibold) }
        static func body() -> SwiftUI.Font { .system(size: 14, weight: .regular) }
        static func mono() -> SwiftUI.Font { .system(size: 12, weight: .regular, design: .monospaced) }
    }
}
