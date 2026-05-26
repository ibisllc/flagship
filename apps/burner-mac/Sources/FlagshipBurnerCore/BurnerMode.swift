import Foundation

/// Which assembly flow the wizard runs.
///
/// - `quick`: the user supplies a *pre-personalized* custom Alpine ISO that
///   already carries the recipe baked into its trailer (server-side
///   `/api/personalize-iso`). The burner just flashes the bytes to the USB.
///   No recipe input is required.
/// - `advanced`: the user supplies a stock Ubuntu/Debian ISO + a JSON recipe;
///   the burner remasters in-place (autoinstall / preseed) and then flashes.
///   This was the only flow before the Alpine pipeline shipped; it's now
///   guarded by the "Advanced" toggle.
public enum BurnerMode: String, Sendable, CaseIterable {
    case quick
    case advanced

    /// Quick takes a pre-personalized ISO — no recipe input needed.
    /// Advanced still requires a JSON recipe to remaster the stock ISO.
    public var requiresRecipe: Bool {
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
