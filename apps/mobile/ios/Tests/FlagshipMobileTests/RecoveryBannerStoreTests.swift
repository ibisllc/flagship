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

    // MARK: - Snooze and the backup file card (owner, 2026-11-21)

    func test_dismissSnoozesForAWeek_thenTheCardComesBack() {
        let d = freshDefaults()
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let store = RecoveryBannerStore(defaults: d, now: { clock })
        store.dismissed = true
        clock += RecoveryBannerStore.snooze - 60
        XCTAssertTrue(RecoveryBannerStore(defaults: d, now: { clock }).dismissed, "Still snoozed within the week.")
        clock += 120
        XCTAssertFalse(RecoveryBannerStore(defaults: d, now: { clock }).dismissed, "Back after a week.")
    }

    func test_anOldForeverDismissal_becomesASnoozeFromToday() {
        let d = freshDefaults()
        d.set(true, forKey: "flagship.recoveryBanner.dismissed.v1")
        let day0 = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(RecoveryBannerStore(defaults: d, now: { day0 }).dismissed)
        XCTAssertNil(d.object(forKey: "flagship.recoveryBanner.dismissed.v1"))
        let later = day0 + RecoveryBannerStore.snooze + 1
        XCTAssertFalse(RecoveryBannerStore(defaults: d, now: { later }).dismissed)
    }

    func test_backupFileCard_onlyAfterTheCloudCardWasPutOff() {
        XCTAssertFalse(RecoveryBannerStore.shouldShowBackupFile(hasCloudRecovery: false, recoverySnoozed: false, hasBackupFile: false, dismissed: false),
                       "The cloud card comes first.")
        XCTAssertTrue(RecoveryBannerStore.shouldShowBackupFile(hasCloudRecovery: false, recoverySnoozed: true, hasBackupFile: false, dismissed: false))
        XCTAssertFalse(RecoveryBannerStore.shouldShowBackupFile(hasCloudRecovery: true, recoverySnoozed: true, hasBackupFile: false, dismissed: false),
                       "Cloud recovery is enough.")
        XCTAssertFalse(RecoveryBannerStore.shouldShowBackupFile(hasCloudRecovery: false, recoverySnoozed: true, hasBackupFile: true, dismissed: false),
                       "A saved file is enough.")
        XCTAssertFalse(RecoveryBannerStore.shouldShowBackupFile(hasCloudRecovery: false, recoverySnoozed: true, hasBackupFile: false, dismissed: true))
    }

    func test_backupFileSnoozePersists() {
        let d = freshDefaults()
        let clock = Date(timeIntervalSince1970: 1_800_000_000)
        let a = RecoveryBannerStore(defaults: d, now: { clock })
        XCTAssertFalse(a.backupFileDismissed)
        a.backupFileDismissed = true
        XCTAssertTrue(RecoveryBannerStore(defaults: d, now: { clock }).backupFileDismissed)
        XCTAssertFalse(RecoveryBannerStore(defaults: d, now: { clock + RecoveryBannerStore.snooze + 1 }).backupFileDismissed)
    }
}
