import XCTest

/// GYM iOS button sweep (mock tier), Settings: every row and control of the
/// Settings tab is pressed from the tab and its effect checked (the screen it
/// opens, the dialog it raises, the order or request the mock received).
/// See GymSweepSupport for the launch and probe helpers.
final class GymSweepSettingsTests: GymSweepCase {

    private let rateLimited = "Too many tries from your network. Try again in about 12 minutes."
    private let otherDevice = String(repeating: "ab", count: 16)

    // MARK: - Helpers

    private func settings(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20), "Settings should render.",
                      file: file, line: line)
    }

    /// A Settings row: its label starts with the row's title.
    private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    /// Scroll either way until `el` is on screen.
    @discardableResult
    private func find(_ app: XCUIApplication, _ el: XCUIElement) -> Bool {
        if el.exists && el.isHittable { return true }
        if reveal(app, el, tries: 8), el.isHittable { return true }
        return revealUp(app, el, tries: 12)
    }

    private func open(_ app: XCUIApplication, row title: String, screen: String,
                      file: StaticString = #filePath, line: UInt = #line) {
        let r = row(app, title)
        XCTAssertTrue(find(app, r), "Settings should list \(title).", file: file, line: line)
        r.tap()
        XCTAssertTrue(app.navigationBars[screen].waitForExistence(timeout: 15), "\(title) should open \(screen).",
                      file: file, line: line)
    }

    private func back(_ app: XCUIApplication, from screen: String) {
        let b = app.navBackButton(in: screen)
        XCTAssertTrue(b.waitForExistence(timeout: 5), "\(screen) should have a back button.")
        b.tap()
        if !app.navigationBars["Settings"].waitForExistence(timeout: 4), b.exists { b.tap() }
        settings(app)
    }

    /// A dialog/alert button with this label that isn't the control which raised it.
    private func dialogButton(_ app: XCUIApplication, _ label: String, notId: String = "") -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", label, notId)).firstMatch
    }

    /// Dismiss a confirmation dialog without acting: its Cancel when it has
    /// one, else a tap outside it (iOS 26 dialogs on iPhone drop Cancel).
    private func cancelDialog(_ app: XCUIApplication) {
        let cancel = app.buttons["Cancel"]
        if cancel.waitForExistence(timeout: 2), cancel.isHittable {
            cancel.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
    }

    private func signedOut(_ app: XCUIApplication) -> Bool {
        app.buttons["Create your account"].waitForExistence(timeout: 20)
    }

    /// Flip a SwiftUI toggle by tapping its switch end.
    private func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    private func value(_ el: XCUIElement) -> String { (el.value as? String) ?? "" }

    // MARK: - Rows

    /// Every navigation row opens its screen with that screen's first control.
    func test_settingsRowsOpenTheirScreens() throws {
        let app = launch(tab: "settings")
        settings(app)
        let rows: [(String, String, String)] = [
            ("Cloud recovery", "Cloud recovery", "recovery-enroll-go"),
            ("Back up account key", "Account backup", "keyfile-export-create"),
            ("Profiles", "Profiles", ""),
            ("Remote", "Remote", "companion-dock-scan"),
            ("Companion requests", "Companion requests", "No pending requests"),
            ("Open secured sessions", "Secured sessions", ""),
            ("Process URL", "Process URL", "process-url-field"),
            ("Peer-backup", "Peer-backup", ""),
            ("Privacy", "Privacy", "privacy-push-notifications-toggle"),
            ("About Flagship", "About", "BUSL-1.1 → Apache 2.0 (2030)"),
            ("Developer", "Developer", "Use live data"),
        ]
        for (title, screen, mark) in rows {
            open(app, row: title, screen: screen)
            if !mark.isEmpty {
                let el = app.descendants(matching: .any).matching(
                    NSPredicate(format: "identifier == %@ OR label == %@", mark, mark)).firstMatch
                XCTAssertTrue(el.waitForExistence(timeout: 10), "\(screen) should show \(mark).")
            }
            shot(app, "settings-row-\(screen.lowercased().replacingOccurrences(of: " ", with: "-"))")
            back(app, from: screen)
        }
    }

    // MARK: - Browser sessions

    /// Only docked browsers (`kind: remote`) are listed, never this phone's
    /// own session; Revoke asks, Cancel keeps it, Revoke ends it on the box.
    func test_browserSessionsListOnlyRemoteAndRevoke() throws {
        let app = launch(tab: "settings")
        settings(app)
        let remote = app.staticTexts["Session f9e8d7c6"]
        XCTAssertTrue(find(app, remote), "The docked browser is listed under Browser sessions.")
        XCTAssertFalse(app.staticTexts["Session a1b2c3d4"].exists, "This phone's own session is not a browser session.")
        let revoke = app.buttons["settings-revoke-browser-f9e8d7c6"]
        XCTAssertTrue(revoke.exists)
        revoke.tap()
        XCTAssertTrue(app.staticTexts["Session f9e8d7c6 loses access to this account."].waitForExistence(timeout: 5))
        cancelDialog(app)
        XCTAssertTrue(remote.waitForExistence(timeout: 5), "Cancel keeps the session.")
        expectNoProbe(app, "revoked paired session")
        revoke.tap()
        let confirm = dialogButton(app, "Revoke", notId: "settings-revoke-browser-f9e8d7c6")
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        expectProbe(app, "revoked paired session f9e8d7c6")
        waitGone(remote)
        XCTAssertFalse(app.staticTexts["BROWSER SESSIONS"].exists, "With no browser left the section hides.")
        shot(app, "browser-sessions-revoked")
    }

    // MARK: - App section

    /// Appearance and app icon say which is chosen; each choice applies.
    func test_appearanceAndAppIconChoices() throws {
        let app = launch(tab: "settings")
        settings(app)
        let dark = app.buttons["appearance-dark"]
        XCTAssertTrue(find(app, dark))
        dark.tap()
        wait(dark, "isSelected == true")
        XCTAssertFalse(app.buttons["appearance-light"].isSelected)
        app.buttons["appearance-light"].tap()
        wait(app.buttons["appearance-light"], "isSelected == true")
        XCTAssertFalse(dark.isSelected)
        app.buttons["appearance-auto"].tap()
        wait(app.buttons["appearance-auto"], "isSelected == true")
        shot(app, "appearance-auto")

        let classic = app.buttons["appicon-classic"]
        let legacy = app.buttons["appicon-legacy"]
        XCTAssertTrue(find(app, legacy))
        wait(classic, "isSelected == true")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        legacy.tap()
        let ok = springboard.alerts.buttons["OK"]
        if ok.waitForExistence(timeout: 8) { ok.tap() }
        wait(legacy, "isSelected == true", timeout: 15)
        classic.tap()
        if ok.waitForExistence(timeout: 8) { ok.tap() }
        wait(classic, "isSelected == true", timeout: 15)
    }

    /// Privacy's three switches flip and flip back (left as they were).
    func test_privacyTogglesFlipAndRestore() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Privacy", screen: "Privacy")
        let unlock = app.switches.matching(NSPredicate(format: "label == %@", "Require unlock when the app opens")).firstMatch
        let passphrase = app.switches["privacy-require-passphrase-toggle"]
        let push = app.switches["privacy-push-notifications-toggle"]
        XCTAssertTrue(unlock.waitForExistence(timeout: 10))
        for sw in [unlock, passphrase, push] {
            let before = value(sw)
            flip(sw)
            wait(sw, "value != %@".replacingOccurrences(of: "%@", with: "'\(before)'"))
            shot(app, "privacy-flipped")
            flip(sw)
            wait(sw, "value == %@".replacingOccurrences(of: "%@", with: "'\(before)'"))
        }
    }

    /// About's version, tapped three times, unlocks the developer menu,
    /// whose screen offers the live/mock switch and the latency knob.
    func test_aboutUnlocksDeveloperAndDeveloperRenders() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "About Flagship", screen: "About")
        let version = app.staticTexts["Version"]
        XCTAssertTrue(version.waitForExistence(timeout: 10))
        for _ in 0..<3 { version.tap() }
        XCTAssertTrue(app.staticTexts["Developer menu is in Settings."].waitForExistence(timeout: 10),
                      "Three taps unlock the developer menu.")
        waitGone(app.staticTexts["Developer menu unlocked."], timeout: 10)
        back(app, from: "About")
        open(app, row: "Developer", screen: "Developer")
        XCTAssertTrue(app.switches.matching(NSPredicate(format: "label CONTAINS %@", "Use live data")).firstMatch.exists)
        XCTAssertTrue(app.sliders.firstMatch.exists, "The mock latency knob is offered.")
        XCTAssertTrue(app.buttons["Wipe identity (Keystore + session)"].exists)
    }

    // MARK: - Leaving: sign out, remove this device, delete account

    func test_signOutAsksThenSignsOut() throws {
        let app = launch(tab: "settings", ["-smoke-recovery-enrolled"])
        settings(app)
        let signOut = app.buttons["settings-sign-out-btn"]
        XCTAssertTrue(find(app, signOut))
        signOut.tap()
        XCTAssertTrue(text(app, containing: "erases this device's account key").waitForExistence(timeout: 5),
                      "Sign out says what it erases.")
        cancelDialog(app)
        settings(app)
        XCTAssertTrue(signOut.exists, "Cancel keeps the session.")
        signOut.tap()
        let confirm = dialogButton(app, "Sign out", notId: "settings-sign-out-btn")
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(signedOut(app), "Signing out lands on Welcome.")
    }

    func test_removeThisDeviceAsksThenRemoves() throws {
        let app = launch(tab: "settings", ["-smoke-recovery-enrolled"])
        settings(app)
        let remove = app.buttons["remove-from-account-btn"]
        XCTAssertTrue(find(app, remove))
        remove.tap()
        let dialog = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@",
                                                          "Remove this device from your account?",
                                                          "Permanently remove this device?")).firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 5))
        cancelDialog(app)
        settings(app)
        remove.tap()
        let confirm = button(app, "Remove this device")
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(signedOut(app), "Removing this device signs it out.")
    }

    /// Delete account: the button only fires once the account name is typed;
    /// the content switch flips; the transfer link says how to keep a server;
    /// deleting sends the admin-signed bundle and signs out.
    func test_deleteAccountNeedsTheNameTyped() throws {
        let app = launch(tab: "settings")
        settings(app)
        let delete = app.buttons["settings-delete-account-btn"]
        XCTAssertTrue(find(app, delete))
        delete.tap()
        XCTAssertTrue(app.navigationBars["Delete account"].waitForExistence(timeout: 10))
        let go = app.buttons["account-delete-confirm-btn"]
        XCTAssertTrue(reveal(app, go))
        go.tap()
        expectNoProbe(app, "deleted account")
        XCTAssertTrue(app.navigationBars["Delete account"].exists, "Nothing happens before the name is typed.")

        let link = app.buttons["account-delete-transfer-link"]
        XCTAssertTrue(revealUp(app, link))
        link.tap()
        XCTAssertTrue(text(app, containing: "choose Transfer to another account").waitForExistence(timeout: 5),
                      "The transfer link says how to keep a server.")

        let content = app.switches["account-delete-content-toggle"]
        XCTAssertTrue(reveal(app, content))
        XCTAssertEqual(value(content), "0")
        flip(content)
        wait(content, "value == '1'")

        let field = app.textFields["account-delete-confirm-field"]
        XCTAssertTrue(reveal(app, field))
        field.tap()
        field.typeText("bright-maple")
        shot(app, "delete-account-typed")
        XCTAssertTrue(reveal(app, go))
        go.tap()
        expectProbe(app, "deleted account bright-maple")
        XCTAssertTrue(signedOut(app), "A deleted account leaves this device on Welcome.")
    }

    /// A non-admin device can't delete the account: it says so instead.
    func test_deleteAccountOnANonAdminDeviceSaysWhy() throws {
        let app = launch(tab: "settings", admin: false)
        settings(app)
        let delete = app.buttons["settings-delete-account-btn"]
        XCTAssertTrue(find(app, delete))
        delete.tap()
        XCTAssertTrue(text(app, containing: "Only an admin device can delete this account.").waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Delete account"].exists)
    }

    /// A demo account: no recovery rows, and Delete offers to remove it
    /// from this device instead.
    func test_demoAccountDeleteRemovesFromThisDevice() throws {
        let app = launch(tab: "settings", ["-smoke-demo-account"])
        settings(app)
        let delete = app.buttons["settings-delete-account-btn"]
        XCTAssertTrue(find(app, delete))
        XCTAssertFalse(row(app, "Cloud recovery").exists, "A demo account has no cloud recovery row.")
        XCTAssertFalse(row(app, "Back up account key").exists)
        delete.tap()
        XCTAssertTrue(app.alerts["Demo account"].waitForExistence(timeout: 5))
        app.alerts["Demo account"].buttons["Cancel"].tap()
        settings(app)
        delete.tap()
        XCTAssertTrue(app.alerts["Demo account"].waitForExistence(timeout: 5))
        app.alerts["Demo account"].buttons["Remove from this device"].tap()
        XCTAssertTrue(signedOut(app))
    }

    // MARK: - Trusted devices

    private func menu(_ app: XCUIApplication, other: Bool) -> XCUIElement {
        let id = "trusted-device-menu-\(otherDevice)"
        return other
            ? app.buttons[id]
            : app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'trusted-device-menu-' AND identifier != %@", id)).firstMatch
    }

    /// An admin device renames the account, this device and another's
    /// managed name, and disconnects another device.
    func test_trustedDevicesAdminRenamesAndDisconnects() throws {
        let app = launch(tab: "settings", ["-smoke-trusted-devices"])
        settings(app)
        let android = app.staticTexts["Android · Device BBBB-2222"]
        XCTAssertTrue(find(app, android), "The other device is listed.")
        XCTAssertTrue(app.staticTexts["This device"].exists)

        // Account name.
        let name = app.buttons["settings-edit-account-name"]
        XCTAssertTrue(find(app, name))
        name.tap()
        XCTAssertTrue(app.navigationBars["Edit account name"].waitForExistence(timeout: 5))
        app.navigationBars["Edit account name"].buttons["Cancel"].tap()
        expectNoProbe(app, "put account profile")
        name.tap()
        let field = app.textFields["Display name"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Maple house")
        app.navigationBars["Edit account name"].buttons["Save"].tap()
        expectProbe(app, "put account profile")
        waitGone(app.navigationBars["Edit account name"])

        // This device's own name.
        let mine = menu(app, other: false)
        XCTAssertTrue(find(app, mine))
        mine.tap()
        button(app, "Rename this device").tap()
        XCTAssertTrue(app.navigationBars["Rename this device"].waitForExistence(timeout: 5))
        app.textFields["Display name"].tap()
        app.textFields["Display name"].typeText(" 2")
        app.navigationBars["Rename this device"].buttons["Save"].tap()
        expectProbe(app, "put device profile")

        // Another device's managed name, locked.
        let theirs = menu(app, other: true)
        XCTAssertTrue(find(app, theirs))
        theirs.tap()
        button(app, "Set managed name").tap()
        XCTAssertTrue(app.navigationBars["Set managed name"].waitForExistence(timeout: 5))
        let lock = app.switches["Lock managed name"]
        XCTAssertTrue(lock.exists)
        flip(lock)
        app.navigationBars["Set managed name"].buttons["Save"].tap()
        expectProbe(app, "put managed profile \(otherDevice)")

        // Disconnect: Cancel keeps it, Revoke drops it.
        theirs.tap()
        button(app, "Disconnect").tap()
        let revoke = button(app, "Revoke Android · Device BBBB-2222")
        XCTAssertTrue(revoke.waitForExistence(timeout: 5))
        cancelDialog(app)
        expectNoProbe(app, "revoked account device")
        theirs.tap()
        button(app, "Disconnect").tap()
        XCTAssertTrue(revoke.waitForExistence(timeout: 5))
        revoke.tap()
        expectProbe(app, "revoked account device \(otherDevice)")
        waitGone(android)
        shot(app, "trusted-devices-disconnected")
    }

    /// A non-admin device: no managed names and the account name doesn't
    /// open an editor (the directory takes them only under the admin root).
    func test_trustedDevicesNonAdminHasNoManagedNames() throws {
        let app = launch(tab: "settings", admin: false, ["-smoke-trusted-devices"])
        settings(app)
        let theirs = menu(app, other: true)
        XCTAssertTrue(find(app, theirs))
        theirs.tap()
        XCTAssertTrue(button(app, "Disconnect").waitForExistence(timeout: 5))
        XCTAssertFalse(button(app, "Set managed name").exists, "Only an admin device sets managed names.")
        app.swipeDown()
        if button(app, "Disconnect").exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap() }
        let name = app.buttons["settings-edit-account-name"]
        XCTAssertTrue(find(app, name))
        name.tap()
        XCTAssertFalse(app.navigationBars["Edit account name"].waitForExistence(timeout: 3))
    }

    /// Replace device asks first; `.com`'s 429 shows its own sentence. Wipe
    /// & restart asks first and Cancel does nothing.
    func test_replaceDeviceRateLimitedAndWipeCancel() throws {
        let app = launch(tab: "settings", ["-smoke-trusted-devices", "-smoke-rate-limited", "re-pair"])
        settings(app)
        let theirs = menu(app, other: true)
        XCTAssertTrue(find(app, theirs))
        theirs.tap()
        button(app, "Replace device").tap()
        XCTAssertTrue(text(app, containing: "Rotates your account's identity key").waitForExistence(timeout: 5))
        cancelDialog(app)
        theirs.tap()
        button(app, "Replace device").tap()
        let confirm = button(app, "Replace device")
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        let alert = app.alerts["Replace device"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        XCTAssertTrue(alert.staticTexts[rateLimited].exists || alert.label.contains(rateLimited)
                      || app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", rateLimited)).firstMatch.exists,
                      "A rate-limited replace shows .com's sentence.")
        shot(app, "replace-rate-limited")
        alert.buttons["OK"].tap()

        theirs.tap()
        button(app, "Wipe & restart…").tap()
        XCTAssertTrue(text(app, containing: "Every device currently on this account will be disconnected").waitForExistence(timeout: 5))
        cancelDialog(app)
        settings(app)
    }

    /// A replacement whose grace has passed: the banner's Finalize opens the
    /// finalize screen, Complete rotates the key and signs this phone out.
    func test_pendingReplaceFinalizes() throws {
        let app = launch(tab: "settings", ["-smoke-repair-pending"])
        settings(app)
        let finalize = app.buttons["pending-re-pair-finalize-btn"]
        XCTAssertTrue(find(app, finalize), "A pending replacement shows its banner.")
        wait(finalize, "isEnabled == true")
        finalize.tap()
        XCTAssertTrue(app.navigationBars["Replace device"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["replace-finalize-countdown"].label, "Ready to complete")
        let complete = app.buttons["replace-finalize-complete"]
        XCTAssertTrue(complete.waitForExistence(timeout: 5))
        shot(app, "replace-finalize")
        complete.tap()
        XCTAssertTrue(signedOut(app), "The rotated key needs a fresh pairing.")
    }

    // MARK: - Account security

    /// 2FA enrollment from Enable to Done: the code verifies, the recovery
    /// codes must be acknowledged, and the badge turns multi-device.
    func test_twoFactorEnrollToDone() throws {
        let app = launch(tab: "settings", ["-smoke-account-claimed"])
        settings(app)
        open(app, row: "Account security", screen: "Account security")
        app.buttons["account-security-enable-btn"].tap()
        let cont = app.buttons["account-security-step1-continue"]
        XCTAssertTrue(cont.waitForExistence(timeout: 10))
        cont.tap()
        let code = app.textFields["account-security-sample-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10), "Step 2 shows the code field.")
        XCTAssertTrue(app.staticTexts["account-security-manual-secret"].exists)
        let verify = app.buttons["account-security-verify-btn"]
        XCTAssertFalse(verify.isEnabled, "Verify waits for six digits.")
        code.tap()
        code.typeText("123456")
        wait(verify, "isEnabled == true")
        verify.tap()
        let codes = app.descendants(matching: .any)["account-security-recovery-codes"]
        XCTAssertTrue(codes.waitForExistence(timeout: 10), "Step 4 shows the recovery codes.")
        XCTAssertTrue(app.staticTexts["AAAA-BBBB"].exists)
        let done = app.buttons["account-security-done-btn"]
        XCTAssertTrue(reveal(app, done))
        XCTAssertFalse(done.isEnabled, "Done waits for 'I've saved these'.")
        flip(app.switches["account-security-saved-toggle"])
        wait(done, "isEnabled == true")
        shot(app, "totp-codes")
        done.tap()
        let badge = app.staticTexts["account-security-badge"]
        XCTAssertTrue(badge.waitForExistence(timeout: 10))
        wait(badge, "label == 'Multi-device + 2FA'", timeout: 15)
    }

    /// 2FA on: Disable asks for a code; a wrong code is refused with a
    /// sentence, the right one turns it off.
    func test_twoFactorDisable() throws {
        let app = launch(tab: "settings", ["-smoke-totp-enrolled"])
        settings(app)
        open(app, row: "Account security", screen: "Account security")
        let disable = app.buttons["account-security-disable-btn"]
        XCTAssertTrue(disable.waitForExistence(timeout: 15), "An enrolled account offers Disable.")
        disable.tap()
        let alert = app.alerts["Disable multi-device + 2FA?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(disable.exists, "Cancel keeps 2FA on.")
        disable.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.textFields.firstMatch.typeText("000000")
        alert.buttons["Disable"].tap()
        XCTAssertTrue(app.staticTexts.matching(identifier: "account-security-failed-msg").firstMatch.waitForExistence(timeout: 10),
                      "A wrong code says so.")
        disable.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        alert.textFields.firstMatch.typeText("123456")
        alert.buttons["Disable"].tap()
        let badge = app.staticTexts["account-security-badge"]
        wait(badge, "label == 'Single-device account'", timeout: 15)
        XCTAssertTrue(app.buttons["account-security-enable-btn"].waitForExistence(timeout: 5))
    }

    /// `.com` rate-limits 2FA enrollment: the sheet shows its sentence.
    func test_twoFactorRateLimitedShowsTheSentence() throws {
        let app = launch(tab: "settings", ["-smoke-rate-limited", "totp"])
        settings(app)
        open(app, row: "Account security", screen: "Account security")
        app.buttons["account-security-enable-btn"].tap()
        let cont = app.buttons["account-security-step1-continue"]
        XCTAssertTrue(cont.waitForExistence(timeout: 10))
        cont.tap()
        let msg = app.staticTexts.matching(NSPredicate(format: "identifier == 'account-security-failed-msg' AND label CONTAINS %@",
                                                       rateLimited)).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 10), "The sheet shows .com's sentence.")
        shot(app, "totp-rate-limited")
        app.buttons["Start over"].tap()
        XCTAssertTrue(cont.waitForExistence(timeout: 5), "Start over goes back to step 1.")
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.buttons["account-security-enable-btn"].waitForExistence(timeout: 5))
    }

    /// Quick approve from Apple Watch: on registers an admin-signed delegate
    /// grant on `.com`, off revokes it.
    func test_watchQuickApproveOnAndOff() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Account security", screen: "Account security")
        let toggle = app.switches["watch-delegate-toggle"]
        XCTAssertTrue(reveal(app, toggle))
        XCTAssertEqual(value(toggle), "0", "Off by default.")
        flip(toggle)
        expectProbe(app, "signed watch-delegate by admin-root")
        XCTAssertTrue(text(app, containing: "Active — renews by").waitForExistence(timeout: 10))
        wait(toggle, "value == '1'")
        flip(toggle)
        expectProbe(app, "signed watch-delegate-revoke by admin-root")
        wait(toggle, "value == '0'")
    }

    /// A non-admin device: no rotate card, and Watch quick approve read-only
    /// with the reason.
    func test_accountSecurityOnANonAdminDevice() throws {
        let app = launch(tab: "settings", admin: false)
        settings(app)
        open(app, row: "Account security", screen: "Account security")
        let toggle = app.switches["watch-delegate-toggle"]
        XCTAssertTrue(reveal(app, toggle))
        XCTAssertFalse(toggle.isEnabled, "A non-admin device can't sign the delegate grant.")
        XCTAssertEqual(app.staticTexts["watch-delegate-admin-only"].label,
                       "Only an admin device can turn on quick approve from Apple Watch.")
        XCTAssertFalse(app.buttons["rotate-admin-btn"].exists, "Only an admin device rotates the admin key.")
    }

    // MARK: - AI keys

    /// Flagship Inference made default, a key added from Flagship
    /// Inference's card and from Add, made default, and deleted.
    func test_aiKeysAddMakeDefaultDelete() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "AI keys", screen: "AI keys")
        // Leave nothing from an earlier run.
        while app.buttons["ai-key-delete"].firstMatch.exists { app.buttons["ai-key-delete"].firstMatch.tap() }
        XCTAssertTrue(app.otherElements["free-ai-card"].waitForExistence(timeout: 15))

        let add = app.buttons["ai-key-add"]
        XCTAssertTrue(reveal(app, add))
        add.tap()
        let key = app.secureTextFields["ai-key-field"]
        XCTAssertTrue(key.waitForExistence(timeout: 5))
        app.buttons["ai-key-add-save"].tap()
        XCTAssertTrue(app.staticTexts["Enter an API key."].waitForExistence(timeout: 5), "An empty key is refused.")
        key.tap()
        key.typeText("sk-gym-0123456789abcdef")
        app.buttons["ai-key-add-save"].tap()
        let delete = app.buttons["ai-key-delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "The saved key is listed.")
        XCTAssertTrue(app.descendants(matching: .any)["ai-key-default-model"].firstMatch.exists)

        // Whichever isn't default offers Make default.
        let freeDefault = app.buttons["free-ai-make-default"]
        let keyDefault = app.buttons.matching(NSPredicate(format: "label == 'Make default' AND identifier != 'free-ai-make-default'")).firstMatch
        if freeDefault.exists {
            freeDefault.tap()
            waitGone(freeDefault)
            XCTAssertTrue(keyDefault.waitForExistence(timeout: 5), "The key now offers Make default.")
            keyDefault.tap()
            XCTAssertTrue(freeDefault.waitForExistence(timeout: 5), "Flagship Inference offers it back.")
        } else {
            XCTAssertTrue(keyDefault.exists)
            keyDefault.tap()
            XCTAssertTrue(freeDefault.waitForExistence(timeout: 5))
            freeDefault.tap()
            waitGone(freeDefault)
        }
        shot(app, "ai-keys-default")
        delete.tap()
        waitGone(delete)
        XCTAssertTrue(app.otherElements["free-ai-card"].exists, "Flagship Inference can't be deleted.")
    }

    // MARK: - Remote (QR-first browser approval)

    /// The computer's link pasted: both screens show the code, the owner
    /// picks a server and approves; the phone mints a ticket there and seals
    /// it to the browser. A docked browser can be disconnected.
    func test_remoteApprovesAPastedLinkAndDisconnects() throws {
        let app = launch(tab: "settings", ["-smoke-companions"])
        settings(app)
        open(app, row: "Remote", screen: "Remote")
        // The scanner (a placeholder on the Simulator) can be left for the link.
        app.buttons["companion-dock-scan"].tap()
        let pasteInstead = app.buttons["Paste link instead"]
        XCTAssertTrue(pasteInstead.waitForExistence(timeout: 5))
        pasteInstead.tap()
        XCTAssertTrue(app.textFields["companion-dock-link"].waitForExistence(timeout: 5))

        let link = app.textFields["companion-dock-link"]
        link.tap()
        link.typeText("https://flagshipserver.com/remote?s=AQEBAQEBAQEBAQEBAQEBAQ&k=CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        app.buttons["Use pasted link"].tap()
        XCTAssertTrue(app.staticTexts["companion-dock-match-code"].waitForExistence(timeout: 10),
                      "The phone shows the code to compare.")
        let picker = app.buttons["companion-dock-server"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "With several servers the owner picks one.")
        picker.tap()
        button(app, "Office").tap()
        let approve = app.buttons["companion-dock-approve"]
        wait(approve, "isEnabled == true")
        approve.tap()
        let connected = app.descendants(matching: .any).matching(identifier: "companion-dock-connected").firstMatch
        XCTAssertTrue(connected.waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, containing: "Browser connected to Office").exists, "It names the server picked.")
        expectProbe(app, "minted companion ticket")
        expectProbe(app, "relay delivered sealed payload")
        shot(app, "remote-connected")

        // Disconnect the docked browser: Cancel keeps it.
        let revoke = app.buttons["companion-revoke-c0ffee12"]
        XCTAssertTrue(reveal(app, revoke))
        revoke.tap()
        XCTAssertTrue(button(app, "Disconnect").waitForExistence(timeout: 5))
        cancelDialog(app)
        expectNoProbe(app, "revoked companion")
        revoke.tap()
        button(app, "Disconnect").tap()
        expectProbe(app, "revoked companion c0ffee12")
        waitGone(revoke)
    }

    /// A link that isn't a remote code is refused with a sentence.
    func test_remoteRefusesAForeignLink() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Remote", screen: "Remote")
        let link = app.textFields["companion-dock-link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        link.typeText("https://example.com/remote?s=x&k=y")
        app.buttons["Use pasted link"].tap()
        let err = app.staticTexts["companion-dock-approval-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 5))
        XCTAssertTrue(err.label.hasPrefix("This isn't a Flagship remote code."), "Got: \(err.label)")
    }

    // MARK: - Companion requests

    /// A docked browser's writes: holding Approve signs a name release with
    /// the admin root; Deny resolves the other.
    func test_companionRequestsHoldToApproveAndDeny() throws {
        let app = launch(tab: "settings", ["-smoke-companions"])
        settings(app)
        open(app, row: "Companion requests", screen: "Companion requests")
        let approve = app.buttons["companion-req-approve-rq-release"]
        XCTAssertTrue(approve.waitForExistence(timeout: 10))
        approve.tap()
        expectNoProbe(app, "release-server-name")
        approve.press(forDuration: 2.0)
        expectProbe(app, "signed release-server-name by admin-root")
        expectProbe(app, "resolved companion request rq-release approved")
        waitGone(approve)
        let deny = app.buttons["companion-req-deny-rq-revoke"]
        XCTAssertTrue(deny.exists)
        deny.tap()
        expectProbe(app, "resolved companion request rq-revoke denied")
        XCTAssertTrue(app.staticTexts["No pending requests"].waitForExistence(timeout: 10))
    }

    // MARK: - Web access

    /// An open secured session: Refresh asks the box, Stop asks first and
    /// closes it on the box.
    func test_securedSessionRefreshAndStop() throws {
        let app = launch(tab: "settings", ["-smoke-secured-session"])
        settings(app)
        open(app, row: "Open secured sessions", screen: "Secured sessions")
        let id = String(repeating: "5e", count: 32)
        let refresh = app.buttons["secured-session-refresh-\(id)"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        refresh.tap()
        expectProbe(app, "checked secured session \(id)")
        let stop = app.buttons["secured-session-stop-\(id)"]
        stop.tap()
        XCTAssertTrue(text(app, containing: "will have to authorize again").waitForExistence(timeout: 5))
        cancelDialog(app)
        expectNoProbe(app, "closed secured session")
        stop.tap()
        button(app, "Stop session").tap()
        expectProbe(app, "closed secured session \(id)")
        XCTAssertTrue(app.descendants(matching: .any)["secured-sessions-empty"].waitForExistence(timeout: 10))
    }

    /// Process URL: an unreadable link says so; a Flagship app link opens
    /// the screen it names.
    func test_processUrlRoutesALink() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Process URL", screen: "Process URL")
        let field = app.textFields["process-url-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("not a link")
        app.buttons["process-url-open"].tap()
        XCTAssertTrue(app.staticTexts["process-url-error"].waitForExistence(timeout: 5))
        field.tap()
        field.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20))
        field.typeText("https://flagshipserver.com/app/account/security")
        app.buttons["process-url-open"].tap()
        XCTAssertTrue(app.navigationBars["Account security"].waitForExistence(timeout: 10),
                      "An app link opens the screen it names.")
    }

    // MARK: - Backups and recovery

    /// Account key backup: Create waits for a strong, matching passphrase and
    /// the acknowledgement, then offers the file to share.
    func test_keyfileBackupCreatesTheFile() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Back up account key", screen: "Account backup")
        let create = app.buttons["keyfile-export-create"]
        XCTAssertFalse(create.isEnabled)
        let pass = app.secureTextFields["keyfile-export-passphrase"]
        pass.tap()
        pass.typeText("correct horse battery")
        let confirm = app.secureTextFields["keyfile-export-confirm"]
        confirm.tap()
        confirm.typeText("correct horse battery!")
        XCTAssertTrue(app.staticTexts["Passphrases don't match."].waitForExistence(timeout: 5))
        confirm.typeText(XCUIKeyboardKey.delete.rawValue)
        let ack = app.buttons["keyfile-export-ack-control"]
        XCTAssertTrue(reveal(app, ack))
        XCTAssertFalse(create.isEnabled, "Not before the acknowledgement.")
        ack.tap()
        wait(ack, "isSelected == true")
        wait(create, "isEnabled == true")
        create.tap()
        // The system share sheet offers the file; close it.
        let share = app.otherElements["ActivityListView"].firstMatch
        let shown = share.waitForExistence(timeout: 30)
            || app.navigationBars["UIActivityContentView"].waitForExistence(timeout: 5)
        XCTAssertTrue(shown, "The backup file is offered to share.")
        shot(app, "keyfile-share")
        let close = app.buttons.matching(NSPredicate(format: "label == 'Close' OR identifier == 'Close'")).firstMatch
        if close.waitForExistence(timeout: 5) { close.tap() } else { app.swipeDown() }
        XCTAssertTrue(app.descendants(matching: .any)["keyfile-export-saved"].waitForExistence(timeout: 15),
                      "Closing the share sheet confirms the backup.")
    }

    /// Cloud recovery: the passphrases must match, then setup registers the
    /// recovery envelope and says recovery is active.
    func test_cloudRecoverySetup() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Cloud recovery", screen: "Cloud recovery")
        let p1 = app.secureTextFields["recovery-enroll-passphrase"]
        let p2 = app.secureTextFields["recovery-enroll-passphrase-2"]
        XCTAssertTrue(p1.waitForExistence(timeout: 5))
        p1.tap()
        p1.typeText("maple syrup forest")
        p2.tap()
        p2.typeText("maple syrup forests")
        app.buttons["recovery-enroll-go"].tap()
        XCTAssertTrue(text(app, containing: "match").waitForExistence(timeout: 5), "Mismatched passphrases are refused.")
        p2.tap()
        p2.typeText(XCUIKeyboardKey.delete.rawValue)
        app.buttons["recovery-enroll-go"].tap()
        XCTAssertTrue(app.staticTexts["Recovery active"].waitForExistence(timeout: 20))
    }

    /// Profiles lists this account as active; picking it keeps it active.
    func test_profilesListsTheActiveAccount() throws {
        let app = launch(tab: "settings")
        settings(app)
        open(app, row: "Profiles", screen: "Profiles")
        let me = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "@bright-maple")).firstMatch
        XCTAssertTrue(me.waitForExistence(timeout: 5))
        XCTAssertTrue(me.label.contains("ACTIVE") || app.staticTexts["ACTIVE"].exists, "This account is the active one.")
        me.tap()
        XCTAssertTrue(app.navigationBars["Profiles"].exists || app.navigationBars["Settings"].exists)
    }

    // MARK: - Add a device

    /// The new phone has scanned: both screens show the code; the admin
    /// confirms, may make it an admin, and the device is added.
    func test_addDeviceConfirmsTheCodeAndAdmits() throws {
        let app = launch(tab: "settings", ["-smoke-pairing-peer"])
        settings(app)
        let add = app.buttons["settings-add-device"]
        XCTAssertTrue(find(app, add))
        add.tap()
        XCTAssertTrue(app.navigationBars["Add a device"].waitForExistence(timeout: 10))
        let promote = app.switches["add-device-promote-admin-toggle"]
        XCTAssertTrue(promote.waitForExistence(timeout: 10), "An admin device may promote the new one.")
        flip(promote)
        wait(promote, "value == '1'")
        flip(promote)
        wait(promote, "value == '0'")
        let confirm = app.buttons["Confirm codes match"]
        XCTAssertTrue(reveal(app, confirm))
        wait(confirm, "isEnabled == true", timeout: 10)
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Device added"].waitForExistence(timeout: 15))
        app.buttons["Done"].tap()
        settings(app)
    }

    /// Scan a pairing code opens the join flow (the camera is a placeholder
    /// on the Simulator).
    func test_scanPairingCodeOpensJoin() throws {
        let app = launch(tab: "settings")
        settings(app)
        let scan = app.buttons["settings-scan-pairing-code"]
        XCTAssertTrue(find(app, scan))
        scan.tap()
        XCTAssertTrue(app.navigationBars["Join an account"].waitForExistence(timeout: 10))
    }
}
