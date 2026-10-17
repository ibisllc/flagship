import XCTest
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
@testable import FlagshipUI

/// The iOS tokens are the website's (docs/design-system.md §2, the webapp's
/// style.css), and every pairing the app draws clears WCAG AA in both themes.
final class ThemeTokensTests: XCTestCase {

    private func rgb(_ c: Color) -> (Double, Double, Double) {
        #if canImport(UIKit)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(c).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r), Double(g), Double(b))
        #else
        return (0, 0, 0)
        #endif
    }

    private func hex(_ c: Color) -> String {
        let (r, g, b) = rgb(c)
        return String(format: "#%02X%02X%02X", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }

    private func contrast(_ a: Color, _ b: Color) -> Double {
        func lum(_ c: Color) -> Double {
            let (r, g, b) = rgb(c)
            func ch(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
        }
        let (x, y) = (lum(a), lum(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    func test_tokensAreTheWebsites() {
        XCTAssertEqual(hex(FSColors.light.bg), "#F7F6F2")
        XCTAssertEqual(hex(FSColors.light.text), "#14140F")
        XCTAssertEqual(hex(FSColors.light.textMuted), "#555149")
        XCTAssertEqual(hex(FSColors.light.primary), "#0F766E")
        XCTAssertEqual(hex(FSColors.light.primaryFill), "#14B8A6")
        XCTAssertEqual(hex(FSColors.dark.bg), "#0A0A09")
        XCTAssertEqual(hex(FSColors.dark.text), "#ECE7D6")
        XCTAssertEqual(hex(FSColors.dark.textMuted), "#A39D8F")
        XCTAssertEqual(hex(FSColors.dark.primary), "#2DD4BF")
        XCTAssertEqual(hex(FSColors.light.onPrimary), "#0A0A09", "text on the teal fill is dark ink, never white")
        XCTAssertEqual(hex(FSColors.light.success), "#166534")
        XCTAssertEqual(hex(FSColors.light.warning), "#944D05")
        XCTAssertEqual(hex(FSColors.light.danger), "#B91C1C")
        XCTAssertEqual(hex(FSColors.dark.success), "#4ADE80")
        XCTAssertEqual(hex(FSColors.dark.warning), "#FBBF24")
        XCTAssertEqual(hex(FSColors.dark.danger), "#F87171")
        XCTAssertEqual(hex(FSColors.light.accent), "#0E9488")
        XCTAssertEqual(hex(FSColors.dark.accent), "#2DD4BF")
        XCTAssertEqual(FSRadius.sm, 8)
        XCTAssertEqual(FSRadius.md, 12)
        XCTAssertEqual(FSRadius.lg, 16)
    }

    func test_everyPairingClearsAA_inBothThemes() {
        for (name, c) in [("light", FSColors.light), ("dark", FSColors.dark)] {
            for (label, fg, bg) in [
                ("text/bg", c.text, c.bg), ("text/surface", c.text, c.surface),
                ("muted/bg", c.textMuted, c.bg), ("muted/surface", c.textMuted, c.surface),
                ("primary/bg", c.primary, c.bg), ("primary/surface", c.primary, c.surface),
                ("onPrimary/fill", c.onPrimary, c.primaryFill),
                ("onDanger/danger", c.onDanger, c.danger), ("onSuccess/success", c.onSuccess, c.success),
                ("danger/bg", c.danger, c.bg), ("success/bg", c.success, c.bg),
            ] {
                XCTAssertGreaterThanOrEqual(contrast(fg, bg), 4.5, "\(name) \(label)")
            }
            XCTAssertGreaterThanOrEqual(contrast(c.warning, c.bg), 4.5, "\(name) warning/bg")
        }
    }

    /// Status text is read at body size, so every status colour clears 4.5:1
    /// on each surface it can sit on and on its own wash over that surface.
    func test_statusTextClearsAA_onEverySurfaceAndItsWash() {
        func over(_ top: Color, _ base: Color) -> Color {
            var tr: CGFloat = 0, tg: CGFloat = 0, tb: CGFloat = 0, ta: CGFloat = 0
            var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
            UIColor(top).getRed(&tr, green: &tg, blue: &tb, alpha: &ta)
            UIColor(base).getRed(&br, green: &bg, blue: &bb, alpha: &ba)
            return Color(red: Double(tr * ta + br * (1 - ta)), green: Double(tg * ta + bg * (1 - ta)), blue: Double(tb * ta + bb * (1 - ta)))
        }
        for (name, c) in [("light", FSColors.light), ("dark", FSColors.dark)] {
            let status: [(String, Color, Color)] = [
                ("ok", c.success, c.successWash), ("warn", c.warning, c.warningWash), ("err", c.danger, c.dangerWash),
            ]
            for (label, fg, wash) in status {
                for (surfaceName, surface) in [("bg", c.bg), ("surface", c.surface), ("sunken", c.surfaceSunken), ("sidebar", c.sidebar)] {
                    XCTAssertGreaterThanOrEqual(contrast(fg, surface), 4.5, "\(name) \(label)/\(surfaceName)")
                    XCTAssertGreaterThanOrEqual(contrast(fg, over(wash, surface)), 4.5, "\(name) \(label)/wash on \(surfaceName)")
                }
            }
        }
    }

    /// Small teal text and links use `primary` (>= 4.5); the lighter `accent`
    /// is for graphics and large or bold text, where 3:1 is the bar.
    func test_accentClearsTheGraphicsBar_inBothThemes() {
        for (name, c) in [("light", FSColors.light), ("dark", FSColors.dark)] {
            for (label, bg) in [("bg", c.bg), ("surface", c.surface), ("surfaceSunken", c.surfaceSunken)] {
                XCTAssertGreaterThanOrEqual(contrast(c.accent, bg), 3.0, "\(name) accent/\(label)")
                XCTAssertGreaterThanOrEqual(contrast(c.primary, bg), 4.5, "\(name) primary/\(label)")
            }
            XCTAssertGreaterThanOrEqual(contrast(c.onPrimary, c.primaryFill), 7.0, "\(name) onPrimary/fill")
        }
        XCTAssertLessThan(contrast(FSColors.light.accent, FSColors.light.bg), 4.5,
                          "the accent is deliberately lighter than the text teal")
    }
}
