import Foundation

/// Which assembly flow the wizard runs.
///
/// - `quick`: the user supplies only a recipe (the JSON certificate). The
///   burner downloads the stock Flagship Alpine base ISO ONCE (cached), appends
///   the recipe trailer locally (AlpinePersonalize), and flashes — no per-server
///   240 MB download, no separate ISO file, no third-party flasher.
/// - `advanced`: the user supplies a stock Ubuntu/Debian ISO + a JSON recipe;
///   the burner remasters in-place (autoinstall / preseed) and then flashes.
///   This was the only flow before the Alpine pipeline shipped; it's now
///   guarded by the "Advanced" toggle.
public enum BurnerMode: String, Sendable, CaseIterable {
    case quick
    case advanced

    /// Both flows are recipe-driven now: Quick bakes the recipe into the cached
    /// Alpine base; Advanced bakes it into the stock ISO you bring.
    public var requiresRecipe: Bool {
        switch self {
        case .quick: return true
        case .advanced: return true
        }
    }

    /// Quick uses the burner's cached base ISO; only Advanced needs the user to
    /// supply a stock ISO file.
    public var requiresUserISO: Bool {
        switch self {
        case .quick: return false
        case .advanced: return true
        }
    }

    /// User-facing label for the assemble CTA.
    public var bakeCtaLabel: String {
        switch self {
        case .quick: return "Flash to USB"
        case .advanced: return "Assemble and flash"
        }
    }

    /// User-facing menu label.
    public var menuLabel: String {
        switch self {
        case .quick: return "Quick"
        case .advanced: return "Advanced"
        }
    }
}
