import Foundation
import Observation

/// Persistent dismissal flag for the Home post-creation backup-reminder
/// banner. Mirrors the webapp's `flagship.recovery.banner.dismissed.v1`
/// localStorage key (apps/web/public/webapp/views/home.js). UI is a
/// preference, not a security decision — the source of truth that
/// recovery isn't enrolled lives in AppState.hasCloudRecovery, and a
/// real enrolment clears the warn signal there. This flag only quiets
/// a still-unenrolled reminder the user has already acknowledged.
@Observable
@MainActor
public final class RecoveryBannerStore {
    private let defaults: UserDefaults
    private let dismissedKey = "flagship.recoveryBanner.dismissed.v1"

    public var dismissed: Bool {
        didSet { defaults.set(dismissed, forKey: dismissedKey) }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.dismissed = defaults.bool(forKey: dismissedKey)
    }

    /// Pure predicate — show the banner iff cloud recovery is not yet
    /// enrolled AND the user hasn't persistently dismissed. Extracted
    /// from the view so the truth-table is testable without a DOM /
    /// SwiftUI hosting controller.
    public static func shouldShow(hasCloudRecovery: Bool, dismissed: Bool) -> Bool {
        return !hasCloudRecovery && !dismissed
    }
}
