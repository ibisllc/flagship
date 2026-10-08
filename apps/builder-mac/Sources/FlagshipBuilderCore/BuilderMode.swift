import Foundation

/// Which assembly flow the wizard runs.
///
/// - `simple`: the user supplies only a recipe (the JSON certificate). The
///   builder fetches a stock Debian netinst base ISO that the SERVER names via
///   the ISO-manifest endpoint (cached in ~/Library/Caches), remasters it with
///   a generated preseed (the same remaster+flash path Advanced uses), and
///   flashes — no separate ISO file to bring, no third-party flasher. This is
///   the default.
/// - `advanced`: the user supplies a stock Ubuntu/Debian ISO + a JSON recipe;
///   the builder remasters that ISO in-place (autoinstall / preseed) and flashes.
/// - `quick` (Alpine, parked): the user supplies only a recipe. The builder
///   downloads the stock Flagship Alpine base ISO ONCE (cached), appends the
///   recipe trailer locally (AlpinePersonalize), and flashes — no remaster.
public enum BuilderMode: String, Sendable, CaseIterable {
    case simple
    case quick
    case advanced

    /// Both flows are recipe-driven: Simple bakes the recipe into the
    /// server-named Debian base; Advanced bakes it into the stock ISO you bring.
    public var requiresRecipe: Bool {
        switch self {
        case .simple: return true
        case .quick: return true
        case .advanced: return true
        }
    }

    /// Simple and Quick use the server-manifest base ISO the builder caches; only Advanced
    /// needs the user to supply a stock ISO file.
    public var requiresUserISO: Bool {
        switch self {
        case .simple: return false
        case .quick: return false
        case .advanced: return true
        }
    }

    /// User-facing label for the assemble CTA.
    public var bakeCtaLabel: String {
        switch self {
        case .simple: return "Flash to USB"
        case .quick: return "Flash to USB"
        case .advanced: return "Assemble and flash"
        }
    }

    /// User-facing menu label.
    public var menuLabel: String {
        switch self {
        case .simple: return "Simple"
        case .quick: return "Quick"
        case .advanced: return "Advanced"
        }
    }
}
