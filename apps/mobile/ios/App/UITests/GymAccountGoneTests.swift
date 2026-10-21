import XCTest

/// GYM iOS mock tier: a removed account (docs/account-gone.md) and the
/// admin-key warnings (the removal warning and Settings Sign out). The same
/// scenarios as the webapp's (`tools/gym/src/suites/webGone.ts`,
/// `webAccount.ts`), plus the confirm paths.
///
/// NO BACKEND. The mock clients have no `.com`, so `-gym-account-gone <s>`
/// feeds the REAL detector the answer `.com` would send (a 404
/// account-not-found for this device's own account) after `s` seconds
/// (AccountGoneGym, Debug builds only). `-smoke-admin-root` makes this device
/// hold the admin root (it is warned); without it the device holds no key and
/// removes at once.
final class GymAccountGoneTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(tab: String = "home", _ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab] + extra
        app.launch()
        return app
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func text(_ el: XCUIElement) -> String { el.label.isEmpty ? ((el.value as? String) ?? "") : el.label }

    private func gone(_ el: XCUIElement, timeout: TimeInterval = 15) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if !el.exists { return true }
            usleep(250_000)
        }
        return !el.exists
    }

    /// The alert's message text (long labels cannot be used as identifiers).
    private func message(_ alert: XCUIElement) -> String {
        let el = alert.staticTexts.element(matching: NSPredicate(format: "label BEGINSWITH %@", "Signing out removes"))
        return el.waitForExistence(timeout: 5) ? el.label : ""
    }

    private func screenShows(_ app: XCUIApplication) {
        XCTAssertTrue(any(app, "account-gone-title").waitForExistence(timeout: 40), "This account was removed should show.")
    }

    // 0. removing a key that can still save a server's data asks the owner first
    func test_removingTheKeyAsksTheOwnerFirstAndDoesNothingWithoutThem() throws {
        // Every prompt dismissed (`-smoke-refuse-biometric`): the account counts
        // as not open, so "Remove anyway" changes nothing.
        let app = launch(["-smoke-admin-root", "-gym-account-gone", "10", "-smoke-refuse-biometric"])
        screenShows(app)
        app.buttons["account-gone-remove"].tap()
        XCTAssertTrue(app.buttons["account-gone-remove-anyway"].waitForExistence(timeout: 10), "The warning asks first.")
        app.buttons["account-gone-remove-anyway"].tap()
        sleep(3)
        gymShot(app, "account-gone-remove-refused")
        XCTAssertTrue(any(app, "account-gone-title").exists, "The screen stays: nothing was removed.")
        XCTAssertFalse(app.buttons["Create your account"].exists, "Not signed out.")
    }

    // 1. the screen takes over and stops the asking
    func test_removedAccountShowsTheScreenAndClosesWhatWasOpen() throws {
        let app = launch(["-smoke-admin-root", "-gym-account-gone", "10"])
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 30), "Home should render first.")
        add.tap()
        XCTAssertTrue(app.buttons.matching(identifier: "home-add-new-server").firstMatch.waitForExistence(timeout: 10),
                      "The Add/Restore menu should be open before the answer.")
        screenShows(app)
        XCTAssertEqual(text(any(app, "account-gone-title")), "This account was removed")
        XCTAssertEqual(text(any(app, "account-gone-body")), "This account no longer exists on Flagship. This can happen after a reset.")
        XCTAssertEqual(text(any(app, "account-gone-name")), "Account: smoketest")
        XCTAssertEqual(text(any(app, "account-gone-restore-hint")), "If you saved a backup of your servers, you can restore it into a new account.")
        XCTAssertFalse(any(app, "account-gone-save").exists, "No rescue button in this build.")
        XCTAssertEqual(app.buttons["account-gone-create"].label, "Create a new account")
        XCTAssertEqual(app.buttons["account-gone-remove"].label, "Remove it from this device")
        XCTAssertFalse(app.buttons.matching(identifier: "home-add-new-server").firstMatch.exists, "The open menu was closed.")
        XCTAssertFalse(app.buttons["home-add-server"].isHittable, "Nothing behind the screen can be reached.")
        gymShot(app, "account-gone")
    }

    // 2. not mine
    func test_anotherAccountsNotFoundOrANotFoundWithNoCodeChangesNothing() throws {
        let other = launch(["-gym-account-gone", "5", "-gym-account-gone-mode", "other"])
        XCTAssertTrue(other.buttons["home-add-server"].waitForExistence(timeout: 30) || other.tabBars.firstMatch.waitForExistence(timeout: 30))
        sleep(10)
        XCTAssertFalse(any(other, "account-gone").exists, "Another account's 404 changes nothing.")
        let nocode = launch(["-gym-account-gone", "5", "-gym-account-gone-mode", "nocode"])
        XCTAssertTrue(nocode.tabBars.firstMatch.waitForExistence(timeout: 30))
        sleep(10)
        XCTAssertFalse(any(nocode, "account-gone").exists, "A 404 with no code changes nothing.")
        gymShot(nocode, "account-gone-not-mine")
    }

    // 3. Remove on an admin device warns first; Save my account key first removes nothing; Remove anyway removes
    func test_removeOnAnAdminDeviceWarnsFirstAndOnlyRemoveAnywayRemoves() throws {
        let app = launch(["-smoke-admin-root", "-gym-account-gone", "6"])
        screenShows(app)
        app.buttons["account-gone-remove"].tap()
        XCTAssertEqual(text(any(app, "account-gone-warning-title")), "Remove this account from this device?")
        XCTAssertEqual(text(any(app, "account-gone-warning-message")),
                       "This also removes this device's admin key, which you need to sign in to your servers. Save a backup of your account key first, or remove anyway.")
        XCTAssertEqual(app.buttons["account-gone-save-first"].label, "Save my account key first")
        XCTAssertEqual(app.buttons["account-gone-remove-anyway"].label, "Remove anyway")
        XCTAssertFalse(app.buttons["Create your account"].exists, "Nothing was removed by asking.")
        gymShot(app, "account-gone-warning")

        // Save my account key first opens the account-key backup and removes nothing.
        app.buttons["account-gone-save-first"].tap()
        XCTAssertTrue(app.buttons["keyfile-export-create"].waitForExistence(timeout: 15), "It opens the account backup.")
        app.buttons["account-gone-backup-done"].tap()
        XCTAssertTrue(app.buttons["account-gone-remove-anyway"].waitForExistence(timeout: 10), "The warning asks again afterwards.")

        app.buttons["account-gone-remove-anyway"].tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 20), "Remove anyway lands on Welcome.")
        XCTAssertFalse(any(app, "account-gone").exists)
        gymShot(app, "account-gone-removed")
    }

    // 4. Create a new account on an admin device warns, then opens the create flow
    func test_createANewAccountOnAnAdminDeviceWarnsThenOpensTheCreateFlow() throws {
        let app = launch(["-smoke-admin-root", "-gym-account-gone", "6"])
        screenShows(app)
        app.buttons["account-gone-create"].tap()
        XCTAssertTrue(any(app, "account-gone-warning-title").waitForExistence(timeout: 5))
        app.buttons["account-gone-remove-anyway"].tap()
        XCTAssertTrue(any(app, "suggest-username-name").waitForExistence(timeout: 20), "The create flow's name step is open.")
        gymShot(app, "account-gone-create")
    }

    // 5. a device with no key removes at once
    func test_aDeviceThatHoldsNoKeyRemovesAtOnce() throws {
        let app = launch(["-gym-account-gone", "6"])
        screenShows(app)
        app.buttons["account-gone-remove"].tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 20), "No key to lose: it removes without asking.")
        XCTAssertFalse(any(app, "account-gone-warning-title").exists)
    }

    // 6. Settings Sign out on an admin device whose key is not backed up
    func test_signOutOnAnAdminDeviceWarnsAndSaveMyDataFirstSignsNothingOut() throws {
        let app = launch(tab: "settings", ["-smoke-admin-root", "-smoke-recovery-enrolled"])
        let signOut = app.buttons["settings-sign-out-btn"]
        for _ in 0..<10 where !signOut.exists { app.swipeUp() }
        XCTAssertTrue(signOut.waitForExistence(timeout: 20))
        signOut.tap()
        let alert = app.alerts["Sign out?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertEqual(message(alert), "Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway.")
        XCTAssertTrue(alert.buttons["Save my account key first"].exists)
        XCTAssertTrue(alert.buttons["Sign out anyway"].exists)
        gymShot(app, "signout-admin-warning")
        alert.buttons["Save my account key first"].tap()
        XCTAssertTrue(app.buttons["keyfile-export-create"].waitForExistence(timeout: 15), "Save my account key first opens the account backup.")
        XCTAssertFalse(app.buttons["Create your account"].exists, "Nothing was signed out.")
    }

    // 7. ... and once a key file was written it says what to keep
    func test_signOutAfterAKeyBackupSaysWhatToKeep() throws {
        let app = launch(tab: "settings", ["-smoke-admin-root", "-smoke-recovery-enrolled", "-smoke-key-backed-up"])
        let signOut = app.buttons["settings-sign-out-btn"]
        for _ in 0..<10 where !signOut.exists { app.swipeUp() }
        XCTAssertTrue(signOut.waitForExistence(timeout: 20))
        signOut.tap()
        let alert = app.alerts["Sign out?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertEqual(message(alert), "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe.")
        XCTAssertTrue(alert.buttons["Cancel"].exists)
        XCTAssertFalse(alert.buttons["Save my account key first"].exists)
        gymShot(app, "signout-backed-up")
        alert.buttons["Sign out"].tap()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 20), "Sign out then signs out.")
    }

    // 8. Settings Remove this device warns the same way
    func test_removeThisDeviceInSettingsWarnsOnAnAdminDevice() throws {
        let app = launch(tab: "settings", ["-smoke-admin-root", "-smoke-recovery-enrolled"])
        let remove = app.buttons["remove-from-account-btn"]
        for _ in 0..<12 where !remove.exists { app.swipeUp() }
        XCTAssertTrue(remove.waitForExistence(timeout: 20))
        remove.tap()
        let alert = app.alerts["Remove this account from this device?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.buttons["Save my account key first"].exists)
        XCTAssertTrue(alert.buttons["Remove anyway"].exists)
    }

    // 9. a device that only holds a server session is warned too
    func test_aDeviceThatOnlyHoldsAServerSessionIsWarned() throws {
        let app = launch(["-gym-account-gone", "6", "-smoke-server-session"])
        screenShows(app)
        app.buttons["account-gone-remove"].tap()
        XCTAssertTrue(any(app, "account-gone-warning-title").waitForExistence(timeout: 5), "A server session is a key that can still open a server.")
        XCTAssertFalse(app.buttons["Create your account"].exists)
    }
}
