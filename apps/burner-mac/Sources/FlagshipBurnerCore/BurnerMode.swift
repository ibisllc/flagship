import Foundation

/// Which assembly flow the wizard runs.
///
/// - `advanced`: the user supplies a stock Ubuntu/Debian ISO + a JSON recipe;
///   the burner remasters in-place (autoinstall / preseed) and then flashes.
///   This is currently the only flow; a Debian "Simple" mode is added later.
public enum BurnerMode: String, Sendable, CaseIterable {
    case advanced

    /// The flow is recipe-driven: Advanced bakes the recipe into the stock ISO
    /// you bring.
    public var requiresRecipe: Bool {
        switch self {
        case .advanced: return true
        }
    }

    /// Advanced needs the user to supply a stock ISO file.
    public var requiresUserISO: Bool {
        switch self {
        case .advanced: return true
        }
    }

    /// User-facing label for the assemble CTA.
    public var bakeCtaLabel: String {
        switch self {
        case .advanced: return "Assemble and flash"
        }
    }

    /// User-facing menu label.
    public var menuLabel: String {
        switch self {
        case .advanced: return "Advanced"
        }
    }
}
