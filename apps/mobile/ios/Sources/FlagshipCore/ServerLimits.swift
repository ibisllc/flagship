import Foundation

/// Repo-wide limits for user-authored server metadata.
///
/// The one-line server description is phone-held display text (it never
/// reaches flagshipserver.com — that's the privacy model). It surfaces
/// in tight rows (pod picker, Home cards, app-detail "where it runs"),
/// so an over-long string wraps and breaks the layout. Capping it at a
/// short length keeps every surface single-line.
///
/// Mirror constant on Android: `ServerLimits.MAX_DESCRIPTION`.
public enum ServerLimits {
    public static let maxDescription = 30
}

public extension String {
    /// Trim to `ServerLimits.maxDescription` characters. Safe to call
    /// on every keystroke — it's a no-op once already within bounds.
    func clampedServerDescription() -> String {
        count <= ServerLimits.maxDescription
            ? self
            : String(prefix(ServerLimits.maxDescription))
    }
}
