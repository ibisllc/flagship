import Foundation

/// Which assembly flow the wizard runs.
///
/// - `simple`: the user supplies only a recipe (the JSON certificate). The
///   burner fetches a stock Debian netinst base ISO that the SERVER names via
///   the ISO-manifest endpoint (cached in ~/Library/Caches), remasters it with
///   a generated preseed (the same remaster+flash path Advanced uses), and
///   flashes — no separate ISO file to bring, no third-party flasher. This is
///   the default.
/// - `advanced`: the user supplies a stock Ubuntu/Debian ISO + a JSON recipe;
///   the burner remasters that ISO in-place (autoinstall / preseed) and flashes.
public enum BurnerMode: String, Sendable, CaseIterable {
    case simple
    case advanced

    /// Both flows are recipe-driven: Simple bakes the recipe into the
    /// server-named Debian base; Advanced bakes it into the stock ISO you bring.
    public var requiresRecipe: Bool {
        switch self {
        case .simple: return true
        case .advanced: return true
        }
    }

    /// Simple uses the server-manifest base ISO the burner caches; only Advanced
    /// needs the user to supply a stock ISO file.
    public var requiresUserISO: Bool {
        switch self {
        case .simple: return false
        case .advanced: return true
        }
    }

    /// User-facing label for the assemble CTA.
    public var bakeCtaLabel: String {
        switch self {
        case .simple: return "Flash to USB"
        case .advanced: return "Assemble and flash"
        }
    }

    /// User-facing menu label.
    public var menuLabel: String {
        switch self {
        case .simple: return "Simple"
        case .advanced: return "Advanced"
        }
    }
}
