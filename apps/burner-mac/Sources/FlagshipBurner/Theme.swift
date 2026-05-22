import SwiftUI
import AppKit

/// Flagship design tokens — mirrors apps/web/public/tokens.css 1:1.
///
/// Every color is a dynamic light/dark pair via NSColor's appearance-
/// aware provider, so the app follows the user's macOS appearance
/// automatically (matching the website's `:root` light default +
/// `[data-theme="dark"]` and the iOS app's system-following theme).
///
/// Palette: warm off-white canvas / near-black canvas, teal accent,
/// warm-neutral inks + rules. NOT the system accent blue — the brand
/// accent is teal #14B8A6.
enum FB {
    enum Colors {
        // Surfaces
        static let bg            = dyn(light: 0xF7F6F2, dark: 0x0A0A09)
        static let bgTinted      = dyn(light: 0xF0EEE8, dark: 0x14130F)
        static let surface       = dyn(light: 0xFFFFFF, dark: 0x1A1916)
        static let surfaceElev   = dyn(light: 0xFFFFFF, dark: 0x232118)
        static let surfaceSunken = dyn(light: 0xEFEDE7, dark: 0x14130F)

        // Ink
        static let ink           = dyn(light: 0x000000, dark: 0xECE7D6)
        static let inkSoft       = dyn(light: 0x1F1E1A, dark: 0xC8C2B0)
        static let textMuted     = dyn(light: 0x555149, dark: 0x8A8478)
        static let inkFaint      = dyn(light: 0x8A8478, dark: 0x565249)

        // Rules / borders
        static let border        = dyn(light: 0xE5E3DC, dark: 0x25231C)
        static let borderStrong  = dyn(light: 0xC8C5BB, dark: 0x3A372F)

        // Teal accent — same in both schemes (brand constant)
        static let primary       = dyn(light: 0x14B8A6, dark: 0x14B8A6)
        static let primaryBright = dyn(light: 0x2DD4BF, dark: 0x2DD4BF)
        static let primaryDeep   = dyn(light: 0x0F8B7E, dark: 0x0F8B7E)

        // Status
        static let success       = dyn(light: 0x16A34A, dark: 0x4ADE80)
        static let warning       = dyn(light: 0xCA8A04, dark: 0xFBBF24)
        static let danger        = dyn(light: 0xDC2626, dark: 0xF87171)

        /// Appearance-aware color from two hex literals.
        private static func dyn(light: UInt32, dark: UInt32) -> Color {
            Color(nsColor: NSColor(name: nil) { appearance in
                let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                return nsColor(hex: isDark ? dark : light)
            })
        }

        private static func nsColor(hex: UInt32) -> NSColor {
            NSColor(
                srgbRed: CGFloat((hex >> 16) & 0xFF) / 255.0,
                green:   CGFloat((hex >> 8) & 0xFF) / 255.0,
                blue:    CGFloat(hex & 0xFF) / 255.0,
                alpha: 1.0
            )
        }
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
        static let sm: CGFloat = 4
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
    }

    enum Font {
        /// 17pt rounded semibold — window title
        static func title() -> SwiftUI.Font {
            .system(.title3, design: .rounded, weight: .semibold)
        }
        static func rowTitle() -> SwiftUI.Font { .system(.body, weight: .medium) }
        static func rowHint() -> SwiftUI.Font { .system(.callout) }
        static func caption() -> SwiftUI.Font { .system(.caption) }
        static func mono() -> SwiftUI.Font { .system(.caption, design: .monospaced) }
    }
}

/// The Flagship mark, redrawn in SwiftUI from logo.svg: a rounded
/// square frame with a ring + teal core.
struct FlagshipLogo: View {
    var size: CGFloat = 22
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // Light: dark frame, teal core.  Dark: teal frame, white core.
        // No ring — at small sizes the sub-pixel white band rendered
        // unevenly (a partial arc in one corner), so the mark is just a
        // solid frame + core.
        let isDark = scheme == .dark
        let frame = isDark ? FB.Colors.primary : FB.Colors.ink
        let core  = isDark ? Color.white : FB.Colors.primary
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(frame)
            Circle()
                .fill(core)
                .frame(width: size * 0.52, height: size * 0.52)
        }
        .frame(width: size, height: size)
    }
}
