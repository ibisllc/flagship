import SwiftUI

/// Flagship design tokens for SwiftUI, in the website's hand: the values the
/// webapp's `style.css` uses (paper canvas in light, warm near-black in dark,
/// cream ink, one teal). Source of truth: `/docs/design-system.md` §2 and §5.
///
/// Usage:
///
///     ContentView()
///         .background(FS.colors.bg)
///         .foregroundColor(FS.colors.text)
///
public enum FS {
    public static var colors: FSColors { FSColors.current }
    public static let space = FSSpace.self
    public static let radius = FSRadius.self
    public static let font = FSFont.self
}

public struct FSColors {
    public let bg: Color
    public let surface: Color
    public let surfaceSunken: Color
    public let sidebar: Color
    public let border: Color
    public let text: Color
    public let textMuted: Color
    /// The teal as text, icons, links and outlines: `--accent`, deepened to
    /// #0F766E in light so it passes AA on paper.
    public let primary: Color
    public let primaryHover: Color
    /// The teal as a fill (primary buttons, selection, bars): `--teal`.
    public let primaryFill: Color
    /// Text and icons on `primaryFill`: dark ink, never white (contrast).
    public let onPrimary: Color
    public let success: Color
    public let warning: Color
    public let danger: Color
    /// Text on a `success` / `danger` fill (white in light, ink in dark).
    public let onSuccess: Color
    public let onDanger: Color

    /// `#RRGGBB` as a Color, so the tokens read like the CSS they mirror.
    static func hex(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    static let light = FSColors(
        bg: hex(0xF7F6F2),
        surface: hex(0xFFFFFF),
        surfaceSunken: hex(0xEFEDE7),
        sidebar: hex(0xF0EEE8),
        border: hex(0xDEDBD3),
        text: hex(0x14140F),
        textMuted: hex(0x555149),
        primary: hex(0x0F766E),
        primaryHover: hex(0x0B5F58),
        primaryFill: hex(0x14B8A6),
        onPrimary: hex(0x0A0A09),
        success: hex(0x15803D),
        warning: hex(0xA15C07),
        danger: hex(0xB91C1C),
        onSuccess: hex(0xFFFFFF),
        onDanger: hex(0xFFFFFF)
    )

    static let dark = FSColors(
        bg: hex(0x0A0A09),
        surface: hex(0x161512),
        surfaceSunken: hex(0x121110),
        sidebar: hex(0x14130F),
        border: hex(0x2D2B24),
        text: hex(0xECE7D6),
        textMuted: hex(0xA39D8F),
        primary: hex(0x2DD4BF),
        primaryHover: hex(0x5EEAD4),
        primaryFill: hex(0x14B8A6),
        onPrimary: hex(0x0A0A09),
        success: hex(0x4ADE80),
        warning: hex(0xFBBF24),
        danger: hex(0xF87171),
        onSuccess: hex(0x0A0A09),
        onDanger: hex(0x0A0A09)
    )

    static var current: FSColors {
        // SwiftUI dynamic resolution: ColorScheme is read in views via @Environment;
        // for the singleton we let SwiftUI handle dark mode via .colorInvert / @Environment.
        // Concrete views use FSColors.scheme(.dark) when needed.
        light
    }

    public static func scheme(_ scheme: ColorScheme) -> FSColors {
        scheme == .dark ? .dark : .light
    }
}

public enum FSSpace {
    public static let s1: CGFloat = 4
    public static let s2: CGFloat = 8
    public static let s3: CGFloat = 12
    public static let s4: CGFloat = 16
    public static let s5: CGFloat = 20
    public static let s6: CGFloat = 24
    public static let s8: CGFloat = 32
    public static let s10: CGFloat = 40
    public static let s12: CGFloat = 48
    public static let s16: CGFloat = 64
}

/// Small and square, like the site (design-system §5): 4 for buttons,
/// inputs and chips, 6 for cards and sheets.
public enum FSRadius {
    public static let sm: CGFloat = 4
    public static let md: CGFloat = 4
    public static let lg: CGFloat = 6
    public static let pill: CGFloat = 999
}

public enum FSLayout {
    /// Max width of the hero-screen reading column. On a full-width iPad
    /// content pane (or a wide regular-width window) the WhatsApp-style list
    /// rows / cards / chip row would stretch edge-to-edge and read absurdly
    /// wide; clamping to this and centering keeps a comfortable measure. On
    /// iPhone (compact) the pane is already narrower than this, so the clamp
    /// is a no-op and the layout is byte-identical to before.
    public static let readingMaxWidth: CGFloat = 640
}

public extension View {
    /// Constrain a scroll-content column to the reading measure and center it.
    /// A no-op on narrow (iPhone) panes; only bites on wide (iPad / regular)
    /// content. Apply to the inner VStack of a hero screen — the rows, cards,
    /// chip row, and announcements then never stretch past `readingMaxWidth`.
    func fsReadingColumn() -> some View {
        frame(maxWidth: FSLayout.readingMaxWidth)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

public enum FSFont {
    public static func display() -> Font { .system(size: 56, weight: .medium, design: .default) }
    public static func h1() -> Font { .system(size: 40, weight: .medium) }
    public static func h2() -> Font { .system(size: 28, weight: .medium) }
    public static func h3() -> Font { .system(size: 22, weight: .semibold) }
    public static func h4() -> Font { .system(size: 17, weight: .semibold) }
    public static func body() -> Font { .system(size: 15, weight: .regular) }
    public static func bodySm() -> Font { .system(size: 14, weight: .regular) }
    public static func caption() -> Font { .system(size: 12, weight: .medium) }
    public static func mono() -> Font { .system(size: 13, weight: .regular, design: .monospaced) }
}

/// Wrap an entire screen with this to get the Flagship background and
/// resolve `FS.colors` against the current color scheme.
public struct FSScreen<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    private let content: () -> Content
    public init(@ViewBuilder content: @escaping () -> Content) { self.content = content }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        ZStack {
            c.bg.ignoresSafeArea()
            content()
                .foregroundStyle(c.text)
        }
        .preferredColorScheme(scheme)
    }
}

public extension FSColors {
    /// The standard "icon in a soft-teal rounded square" tint — the accent
    /// at the alpha §8.6 uses for a status pill background. Mirrors the web
    /// `--teal-soft` token. Pass a semantic color to tint other leading
    /// glyphs (status icons in a list row) at the same weight.
    func softTint(_ color: Color? = nil) -> Color {
        (color ?? primary).opacity(0.12)
    }
}

/// Initials for a monogram avatar. First two alphanumeric characters of the
/// name, uppercased; falls back to "?" for an empty/symbol-only string.
/// Shared by FSProfileCard + any list-row monogram so the derivation is
/// identical everywhere.
public func fsInitials(_ name: String) -> String {
    let letters = name.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
    let prefix = String(String.UnicodeScalarView(letters.prefix(2)))
    return prefix.isEmpty ? "?" : prefix.uppercased()
}

/// Convenience for resolving the colors at any depth.
public struct FSColorReader<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    private let content: (FSColors) -> Content
    public init(@ViewBuilder content: @escaping (FSColors) -> Content) { self.content = content }
    public var body: some View { content(FSColors.scheme(scheme)) }
}
