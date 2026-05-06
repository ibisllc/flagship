import SwiftUI

/// Flagship design tokens for SwiftUI. Mirrors `tokens.css` and the
/// Compose `Tokens.kt`. Source of truth: `/docs/design-system.md`.
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
    public let border: Color
    public let text: Color
    public let textMuted: Color
    public let primary: Color
    public let primaryHover: Color
    public let success: Color
    public let warning: Color
    public let danger: Color

    static let light = FSColors(
        bg: Color(red: 0.980, green: 0.980, blue: 0.969),
        surface: .white,
        surfaceSunken: Color(red: 0.949, green: 0.945, blue: 0.925),
        border: Color(red: 0.902, green: 0.894, blue: 0.867),
        text: Color(red: 0.078, green: 0.078, blue: 0.059),
        textMuted: Color(red: 0.420, green: 0.416, blue: 0.388),
        primary: Color(red: 0.231, green: 0.357, blue: 1.000),
        primaryHover: Color(red: 0.173, green: 0.275, blue: 0.878),
        success: Color(red: 0.122, green: 0.541, blue: 0.298),
        warning: Color(red: 0.722, green: 0.396, blue: 0.102),
        danger: Color(red: 0.784, green: 0.227, blue: 0.227)
    )

    static let dark = FSColors(
        bg: Color(red: 0.055, green: 0.059, blue: 0.071),
        surface: Color(red: 0.086, green: 0.094, blue: 0.110),
        surfaceSunken: Color(red: 0.110, green: 0.122, blue: 0.141),
        border: Color(red: 0.165, green: 0.176, blue: 0.200),
        text: Color(red: 0.949, green: 0.945, blue: 0.925),
        textMuted: Color(red: 0.604, green: 0.604, blue: 0.576),
        primary: Color(red: 0.494, green: 0.588, blue: 1.000),
        primaryHover: Color(red: 0.659, green: 0.722, blue: 1.000),
        success: Color(red: 0.310, green: 0.745, blue: 0.478),
        warning: Color(red: 0.898, green: 0.627, blue: 0.314),
        danger: Color(red: 0.910, green: 0.392, blue: 0.392)
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
    public static let s6: CGFloat = 24
    public static let s8: CGFloat = 32
    public static let s12: CGFloat = 48
    public static let s16: CGFloat = 64
}

public enum FSRadius {
    public static let sm: CGFloat = 6
    public static let md: CGFloat = 10
    public static let lg: CGFloat = 16
    public static let pill: CGFloat = 999
}

public enum FSFont {
    public static func display() -> Font { .system(size: 56, weight: .medium, design: .default) }
    public static func h1() -> Font { .system(size: 40, weight: .medium) }
    public static func h2() -> Font { .system(size: 28, weight: .medium) }
    public static func h3() -> Font { .system(size: 22, weight: .semibold) }
    public static func h4() -> Font { .system(size: 17, weight: .semibold) }
    public static func body() -> Font { .system(size: 16, weight: .regular) }
    public static func bodySm() -> Font { .system(size: 14, weight: .regular) }
    public static func caption() -> Font { .system(size: 13, weight: .medium) }
    public static func mono() -> Font { .system(size: 14, weight: .regular, design: .monospaced) }
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

/// Convenience for resolving the colors at any depth.
public struct FSColorReader<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    private let content: (FSColors) -> Content
    public init(@ViewBuilder content: @escaping (FSColors) -> Content) { self.content = content }
    public var body: some View { content(FSColors.scheme(scheme)) }
}
