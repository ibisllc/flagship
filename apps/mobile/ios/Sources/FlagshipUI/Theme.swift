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
    /// The brand teal (#14B8A6) for graphics and fills only: icons beside a
    /// label, section markers, rings, spinners, switches, progress, selected
    /// borders, large display headings. About 2.3:1 on paper, so it never
    /// colours body-size text and no icon-only control relies on it (they
    /// carry accessibility labels). Small teal text is `primary`, for inline
    /// links only; every other label is ink with a teal marker.
    public let accent: Color
    public let primaryHover: Color
    /// The teal as a fill (primary buttons, selection, bars): `--teal`.
    public let primaryFill: Color
    /// Text and icons on `primaryFill`: dark ink, never white (contrast).
    public let onPrimary: Color
    public let success: Color
    public let warning: Color
    public let danger: Color
    /// Soft washes behind status text (pills, banners): the status colour
    /// at 6 to 8 percent, composited over the surface it sits on.
    public let successWash: Color
    public let warningWash: Color
    public let dangerWash: Color
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
        accent: hex(0x14B8A6),
        primaryHover: hex(0x0B5F58),
        primaryFill: hex(0x14B8A6),
        onPrimary: hex(0x0A0A09),
        success: hex(0x166534),
        warning: hex(0x944D05),
        danger: hex(0xB91C1C),
        successWash: hex(0x166534).opacity(0.08),
        warningWash: hex(0x944D05).opacity(0.08),
        dangerWash: hex(0xB91C1C).opacity(0.06),
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
        accent: hex(0x2DD4BF),
        primaryHover: hex(0x5EEAD4),
        primaryFill: hex(0x14B8A6),
        onPrimary: hex(0x0A0A09),
        success: hex(0x4ADE80),
        warning: hex(0xFBBF24),
        danger: hex(0xF87171),
        successWash: hex(0x4ADE80).opacity(0.08),
        warningWash: hex(0xFBBF24).opacity(0.08),
        dangerWash: hex(0xF87171).opacity(0.08),
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

/// Continuous-corner radii, as on iOS itself: 8 for inputs and small tiles,
/// 12 for buttons and cards, 16 for sheets and hero surfaces.
public enum FSRadius {
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
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

/// Type scale. Every role maps to a system text style so it follows the
/// reader's Dynamic Type setting (a fixed point size ignores it). The sizes
/// at the default setting match the old fixed ones to within a point.
public enum FSFont {
    public static func display() -> Font { .system(.largeTitle, weight: .semibold) }
    public static func h1() -> Font { .system(.largeTitle, weight: .semibold) }
    public static func h2() -> Font { .system(.title, weight: .semibold) }
    public static func h3() -> Font { .system(.title2, weight: .semibold) }
    public static func h4() -> Font { .system(.headline) }
    public static func body() -> Font { .system(.subheadline) }
    public static func bodySm() -> Font { .system(.footnote) }
    public static func caption() -> Font { .system(.caption, weight: .medium) }
    public static func mono() -> Font { .system(.footnote, design: .monospaced) }

    /// The text style whose default size is nearest `size`. Sizes from 36 up
    /// (the big pairing and unlock digits) stay fixed.
    public static func style(for size: CGFloat) -> Font.TextStyle? {
        switch size {
        case ..<11.5: return .caption2
        case ..<12.5: return .caption
        case ..<13.5: return .footnote
        case ..<15.5: return .subheadline
        case ..<16.5: return .callout
        case ..<17.5: return .body
        case ..<20.5: return .title3
        case ..<22.5: return .title2
        case ..<28.5: return .title
        case ..<36: return .largeTitle
        default: return nil
        }
    }

    /// A glyph that keeps its size at every text size (radio dots, check marks
    /// beside wrapping text), so it never crowds the words at accessibility sizes.
    public static func glyph(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    /// A drop-in for `.system(size:weight:design:)` that scales with Dynamic Type.
    public static func scaled(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        guard let style = style(for: size) else { return .system(size: size, weight: weight, design: design) }
        return .system(style, design: design, weight: weight)
    }
}

/// A section's label: ink, semibold, with a small brand-teal marker (the
/// teal is a graphic here, so the text stays ink and passes AA).
public struct FSSectionLabel: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let id: String?
    public init(_ title: String, id: String? = nil) { self.title = title; self.id = id }
    public var body: some View {
        let c = FSColors.scheme(scheme)
        HStack(spacing: 7) {
            Capsule().fill(c.accent).frame(width: 3, height: 13)
                .accessibilityHidden(true)
            label(c)
        }
    }
}

public extension FSSectionLabel {
    @ViewBuilder
    func label(_ c: FSColors) -> some View {
        let text = Text(title)
            .font(FS.font.scaled(13, weight: .semibold))
            .foregroundColor(c.text)
            .accessibilityAddTraits(.isHeader)
        if let id { text.accessibilityIdentifier(id) } else { text }
    }
}

public extension View {
    /// A leading icon tile that grows with the text size, but only so far:
    /// past ~1.4x it would crowd the text out at the largest sizes.
    func fsTile(_ scaled: CGFloat, base: CGFloat) -> some View {
        frame(width: min(scaled, base * 1.4), height: min(scaled, base * 1.4))
    }
}

/// Side by side at ordinary text sizes, stacked at the accessibility sizes,
/// where a row of icon + text + chevron has no room to wrap.
public struct FSAdaptiveStack<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let alignment: VerticalAlignment
    let spacing: CGFloat
    let content: () -> Content
    public init(alignment: VerticalAlignment = .top, spacing: CGFloat = FS.space.s3, @ViewBuilder content: @escaping () -> Content) {
        self.alignment = alignment; self.spacing = spacing; self.content = content
    }
    public var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: spacing))
            : AnyLayout(HStackLayout(alignment: alignment, spacing: spacing))
        layout { content() }
    }
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
        (color ?? accent).opacity(0.12)
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
