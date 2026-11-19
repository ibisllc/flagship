import Foundation

/// Release switches from release/version.json, kept in step by
/// `scripts/check-versions.mjs --write`.
public enum ProductFeatures {
    /// Off in 0.4 (owner, 2026-11-19); 0.5 turns it on. While false no screen
    /// links to the marketplace and its deep links are ignored.
    public static let marketplace = false
}
