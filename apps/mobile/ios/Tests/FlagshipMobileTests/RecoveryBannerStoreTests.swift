import XCTest
@testable import FlagshipCore

/// Mirror of the webapp's `shouldShowRecoveryBanner` predicate in
/// apps/web/public/webapp/views/home.js. Pins the truth-table so
/// banner regressions show up as a named failure rather than a stale
/// nudge in the simulator. Also exercises the UserDefaults round-trip
/// so a fresh launch picks up a previous-session dismiss.
@MainActor
final class RecoveryBannerStoreTests: XCTestCase {

    private func freshDefaults() -> UserDefaults {
        let name = "flagship.tests.recoveryBanner." + UUID().uuidString
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func test_shouldShow_whenNotEnrolledAndNotDismissed() {
        XCTAssertTrue(RecoveryBannerStore.shouldShow(
            hasCloudRecovery: false,
            dismissed: false
        ))
    }

    func test_hidden_whenEnrolled() {
        XCTAssertFalse(RecoveryBannerStore.shouldShow(
            hasCloudRecovery: true,
            dismissed: false
        ))
    }

    func test_hidden_afterDismiss_evenIfStillNotEnrolled() {
        XCTAssertFalse(RecoveryBannerStore.shouldShow(
            hasCloudRecovery: false,
            dismissed: true
        ))
    }

    func test_hidden_whenEnrolledEvenIfDismissed() {
        // Defensive: real enrolment clears the underlying warn signal
        // (hasCloudRecovery flips true), so the banner stays gone
        // regardless of the persistent dismiss flag.
        XCTAssertFalse(RecoveryBannerStore.shouldShow(
            hasCloudRecovery: true,
            dismissed: true
        ))
    }

    func test_defaultDismissedIsFalse_onFreshInstall() {
        let store = RecoveryBannerStore(defaults: freshDefaults())
        XCTAssertFalse(store.dismissed)
    }

    func test_dismissPersistsAcrossInstances() {
        let d = freshDefaults()
        let a = RecoveryBannerStore(defaults: d)
        XCTAssertFalse(a.dismissed)
        a.dismissed = true
        // A new store reading the same defaults sees the flip — this
        // is the next-launch behaviour the banner relies on.
        let b = RecoveryBannerStore(defaults: d)
        XCTAssertTrue(b.dismissed)
    }
}
