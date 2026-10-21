import XCTest

/// GYM iOS mock tier: security notices (docs/security-notices.md section 6.6).
/// The same five scenarios as the webapp's (`tools/gym/src/suites/webNotices.ts`).
///
/// NO BACKEND. Every test launches `-smoke-mode` with `-gym-notice <names>`:
/// the mocked `.com` answers one notice per poll from the signed ones in
/// `packages/protocol/test-vectors/security-notice/vectors.json`, judged
/// against a throwaway authority (SecurityNoticeGym, Debug builds only), and
/// `-gym-notice-now <ms>` starts the app's clock. The app's own poller keeps
/// the baked pin, so a forged lock never works outside this launch.
///
/// T0 = 1792000000000 (the vectors' epoch); the update-required notice locks
/// at T0 + 14 days (1793209600000) and ends at T0 + 30 days.
final class GymNoticeTests: XCTestCase {
    private let day: Int64 = 86_400_000
    private let t0: Int64 = 1_792_000_000_000
    private var lockFrom: Int64 { t0 + 14 * day }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(_ notices: String, now: Int64, every: Int = 1, build: Int? = nil, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        var args = ["-smoke-mode", "-smoke-tab", "home", "-smoke-admin-root",
                    "-gym-notice", notices, "-gym-notice-now", String(now), "-gym-notice-every", String(every)]
        if let build { args += ["-gym-notice-build", String(build), "-gym-notice-protocol", "2"] }
        app.launchArguments = args + extra
        app.launch()
        return app
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func gone(_ el: XCUIElement, timeout: TimeInterval = 15) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if !el.exists { return true }
            usleep(250_000)
        }
        return !el.exists
    }

    private func text(_ el: XCUIElement) -> String { el.label.isEmpty ? ((el.value as? String) ?? "") : el.label }

    // 1. a maintenance notice shows a dismissible banner with the date
    func test_maintenanceNoticeShowsADismissibleBannerWithTheDate() throws {
        let app = launch("maintenance", now: t0 + day)
        let body = any(app, "notice-banner-text")
        XCTAssertTrue(body.waitForExistence(timeout: 30), "The maintenance banner should show.")
        let said = text(body)
        XCTAssertTrue(said.contains("may be briefly unavailable."), "The banner carries the signed sentence: \(said)")
        XCTAssertFalse(said.contains("{date}"), "The date is filled in, in the person's own format: \(said)")
        XCTAssertTrue(said.hasPrefix("We will update on "), said)
        XCTAssertFalse(any(app, "notice-banner-update").exists, "A maintenance banner has no Update button.")
        XCTAssertFalse(any(app, "update-lock").exists, "A maintenance notice never locks.")
        gymShot(app, "notice-banner")
        any(app, "notice-banner-dismiss").tap()
        XCTAssertTrue(gone(any(app, "notice-banner-text")), "Dismiss hides the banner.")
        XCTAssertTrue(app.buttons["home-add-server"].exists, "Home stays usable.")
    }

    // 2. a verified update-required notice locks the app
    func test_verifiedUpdateRequiredNoticeLocksTheAppUntilItIsUpdated() throws {
        // The first poll finds nothing; the lock arrives 8 s later, with the
        // Add/Restore menu open over Home: it must close.
        let app = launch("empty,lock", now: lockFrom + 3_600_000, every: 8)
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 30), "Home should render before the notice.")
        add.tap()
        XCTAssertTrue(app.buttons.matching(identifier: "home-add-new-server").firstMatch.waitForExistence(timeout: 10),
                      "The Add/Restore menu should be open before the lock.")

        let title = any(app, "update-lock-title")
        XCTAssertTrue(title.waitForExistence(timeout: 40), "The lock should show.")
        XCTAssertEqual(text(title), "Update required")
        XCTAssertEqual(text(any(app, "update-lock-kicker")).lowercased(), "security update")
        XCTAssertTrue(text(any(app, "update-lock-body")).hasPrefix("You must update Flagship by "))
        XCTAssertEqual(text(any(app, "update-lock-why")), "Why: A flaw in how a signed message is checked lets an attacker act as you.")
        XCTAssertEqual(text(any(app, "update-lock-reassure")),
                       "Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.")
        XCTAssertEqual(text(any(app, "update-lock-meta")), "Advisory FSA-2026-001 · Signed by the Flagship maintainers")
        XCTAssertEqual(app.buttons["update-lock-update"].label, "Update Flagship")
        XCTAssertEqual(app.buttons["update-lock-backup"].label, "Back up my account key")
        XCTAssertEqual(app.buttons["update-lock-signout"].label, "Sign out")
        gymShot(app, "update-lock")

        XCTAssertFalse(app.buttons.matching(identifier: "home-add-new-server").firstMatch.exists,
                       "The open menu was closed by the lock.")
        XCTAssertFalse(app.buttons["home-add-server"].isHittable, "Nothing behind the lock can be reached.")

        // The key backup stays reachable, above the lock.
        app.buttons["update-lock-backup"].tap()
        XCTAssertTrue(app.buttons["keyfile-export-create"].waitForExistence(timeout: 15),
                      "Back up my account key opens the account backup above the lock.")
        app.buttons["update-lock-backup-done"].tap()
        XCTAssertTrue(app.buttons["update-lock-update"].waitForExistence(timeout: 10), "The lock is still there.")
    }

    // 2b. Sign out above the lock asks the owner first when the account is not open
    func test_updateLockSignOutAsksTheOwnerFirstAndDoesNothingWithoutThem() throws {
        // Every prompt dismissed (`-smoke-refuse-biometric`): the account counts
        // as not open, so no question opens and the lock stays.
        var app = launch("lock", now: lockFrom + 3_600_000, extra: ["-smoke-refuse-biometric"])
        XCTAssertTrue(any(app, "update-lock-title").waitForExistence(timeout: 40), "The lock should show.")
        app.buttons["update-lock-signout"].tap()
        XCTAssertFalse(app.buttons["Cancel"].waitForExistence(timeout: 4), "A dismissed prompt must not open the question.")
        gymShot(app, "update-lock-sign-out-refused")
        XCTAssertTrue(any(app, "update-lock-title").exists, "The lock stays.")

        // An account already open this session is not asked again.
        app = launch("lock", now: lockFrom + 3_600_000)
        XCTAssertTrue(any(app, "update-lock-title").waitForExistence(timeout: 40))
        app.buttons["update-lock-signout"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), "The question opens at once.")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(any(app, "update-lock-title").exists, "Cancel keeps the lock.")
    }

    // 3. the lock lifts when the build is updated or the notice ends, and an older notice cannot bring it back
    func test_lockLiftsWhenTheBuildIsUpdatedOrTheNoticeEndsAndAnOlderNoticeCannotBringItBack() throws {
        // lock, then a signed all clear (seq 5), then the old lock replayed (seq 3).
        let app = launch("lock,clear,lock", now: lockFrom + 3_600_000, every: 6)
        XCTAssertTrue(any(app, "update-lock-title").waitForExistence(timeout: 30), "The lock should show first.")
        XCTAssertTrue(gone(any(app, "update-lock-title"), timeout: 40), "A signed all clear lifts the lock.")
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 15), "Home is back.")
        gymShot(app, "notice-lock-lifted")
        // The replayed older lock is refused as a rollback.
        sleep(9)
        XCTAssertFalse(any(app, "update-lock-title").exists, "An older notice cannot bring the lock back.")

        // A build at the minimum is not locked.
        let updated = launch("lock", now: lockFrom + 3_600_000, build: 12)
        XCTAssertTrue(updated.buttons["home-add-server"].waitForExistence(timeout: 30))
        sleep(4)
        XCTAssertFalse(any(updated, "update-lock-title").exists, "A build at the notice's minimum is not locked.")

        // A notice that has ended never locks, however stale the cache.
        let ended = launch("lock", now: t0 + 31 * day)
        XCTAssertTrue(ended.buttons["home-add-server"].waitForExistence(timeout: 30))
        sleep(4)
        XCTAssertFalse(any(ended, "update-lock-title").exists, "A notice never locks past its end.")
    }

    // 4. fails open
    func test_failsOpenForALockTheBakedPinCannotVouchForAnUnreachableEndpointAndJunk() throws {
        let app = launch("forged,failed,junk,empty", now: lockFrom + 3_600_000, every: 1)
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 30), "Home should render.")
        sleep(8)
        XCTAssertFalse(any(app, "update-lock").exists, "A lock signed by another key locks nothing.")
        XCTAssertFalse(any(app, "update-lock-title").exists)
        XCTAssertFalse(any(app, "notice-banner").exists, "No banner either.")
        XCTAssertTrue(app.buttons["home-add-server"].isHittable, "Home stays usable.")
        gymShot(app, "notice-forged-ignored")
    }

    // 5. an update-required notice nags until its lock date, then locks
    func test_updateRequiredNoticeNagsUntilItsLockDateThenLocks() throws {
        // 40 s before the lock date, on the app's own running clock.
        let app = launch("lock", now: lockFrom - 40_000)
        let body = any(app, "notice-banner-text")
        XCTAssertTrue(body.waitForExistence(timeout: 30), "The nag banner should show before the lock date.")
        XCTAssertTrue(text(body).hasPrefix("You must update Flagship by "), text(body))
        XCTAssertTrue(app.buttons["notice-banner-update"].exists, "The nag offers Update.")
        gymShot(app, "notice-grace-nag")
        XCTAssertFalse(any(app, "update-lock").exists, "Not locked yet.")
        XCTAssertTrue(any(app, "update-lock-title").waitForExistence(timeout: 90), "At the lock date the app locks by itself.")
    }
}
