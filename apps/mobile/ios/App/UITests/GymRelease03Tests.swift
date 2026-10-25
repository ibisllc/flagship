import XCTest

/// GYM iOS mock tier for release 0.3's client screens: recovery checked by the passkey (SEC-REPAIR-001)
/// and its once-only update, wipe & restart's new passkey, browser access requests (SEC-BROWSER-002) and
/// an imported app's upstream sync (N12). Seams: GymSweepSeams+Release03.swift.
final class GymRelease03Tests: GymSweepCase {
    private let otherDevice = String(repeating: "ab", count: 16)

    private func box(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func launchOnboarding(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-onboarding"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["Create your account"].waitForExistence(timeout: 20))
        return app
    }

    private func restore(_ app: XCUIApplication, as name: String, passphrase: String) {
        app.buttons["welcome-connect"].tap()
        let name0 = app.textFields.matching(identifier: "connect-name-field").firstMatch
        XCTAssertTrue(name0.waitForExistence(timeout: 10))
        name0.tap()
        name0.typeText(name)
        let cont = app.buttons["connect-name-continue"]
        wait(cont, "isEnabled == true")
        cont.tap()
        let pass = app.secureTextFields["login-recovery-passphrase"]
        XCTAssertTrue(pass.waitForExistence(timeout: 15))
        pass.tap()
        pass.typeText(passphrase)
        let go = app.buttons["login-takeover-continue"]
        wait(go, "isEnabled == true")
        go.tap()
    }

    // MARK: - Recovery passkey

    /// A record holding its passkey's key: restoring signs `.com`'s challenge in the same passkey sheet
    /// that unwraps, and the fetch carries that signature.
    func test_restoreSignsComsChallenge() throws {
        let app = launchOnboarding(["-smoke-recovery-passkey"])
        restore(app, as: "sole-maple", passphrase: "maple syrup forest")
        // Onboarding has no probe: the restore getting past the fetch (the key it held moved, so it goes on
        // to the re-pair hold) is what shows the mock `.com` accepted the passkey's signature.
        let moved = any(app, "login-grace-countdown")
        let err = app.staticTexts["login-takeover-error"]
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline && !moved.exists && !err.exists { _ = moved.waitForExistence(timeout: 1) }
        if err.exists {
            XCTAssertFalse(err.label.localizedCaseInsensitiveContains("passkey"), "The passkey check passed: \(err.label)")
            XCTAssertFalse(err.label.contains("passphrase didn't match"), "The passphrase gate passed: \(err.label)")
        } else {
            XCTAssertTrue(moved.exists, "The restore went past the passkey-checked fetch.")
        }
        shot(app, "recovery-passkey-checked")
    }

    /// `.com` refuses the passkey's signature: the restore says so in its own words.
    func test_restoreRefusedPasskeySaysWhy() throws {
        let app = launchOnboarding(["-smoke-recovery-passkey", "-smoke-recovery-passkey-refused"])
        restore(app, as: "sole-maple", passphrase: "maple syrup forest")
        let err = app.staticTexts["login-takeover-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 40))
        XCTAssertEqual(err.label, "That passkey isn't the one your account recovery uses.")
        shot(app, "recovery-passkey-refused")
    }

    /// Setting up recovery sends the passkey's attestation; the passphrase hint is the shared one.
    func test_setupSendsThePasskeyAndShowsTheHint() throws {
        let app = launch(tab: "settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Cloud recovery")).firstMatch
        XCTAssertTrue(reveal(app, row))
        bringToMiddle(app, row)
        row.tap()
        let hint = app.staticTexts["recovery-enroll-hint"]
        XCTAssertTrue(hint.waitForExistence(timeout: 10))
        XCTAssertEqual(hint.label, "Longer is stronger and there is no upper limit: a whole sentence you will remember works well")
        shot(app, "recovery-passkey-setup")
        let p1 = app.secureTextFields["recovery-enroll-passphrase"]
        p1.tap()
        p1.typeText("maple syrup forest")
        let p2 = app.secureTextFields["recovery-enroll-passphrase-2"]
        p2.tap()
        p2.typeText("maple syrup forest")
        app.buttons["recovery-enroll-go"].tap()
        expectProbe(app, "recovery passkey enrolled", timeout: 30)
    }

    /// A record from before the check: Home asks once. Not now leaves a quiet Settings row, which updates
    /// it with one passkey sheet; the row is then gone.
    func test_updatePromptOnceThenSettingsRow() throws {
        let app = launch(tab: "home", ["-smoke-recovery-legacy"])
        let title = app.staticTexts["recovery-update-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25), "Home asks to update a record from before.")
        XCTAssertEqual(title.label, "Update your account recovery")
        XCTAssertEqual(app.staticTexts["recovery-update-body"].label,
                       "Account recovery can now also check your passkey, so your passphrase alone can't download your recovery copy. Enter your recovery passphrase, then confirm with your passkey once.")
        shot(app, "recovery-update-prompt")
        app.buttons["recovery-update-not-now"].tap()
        waitGone(title)

        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons["settings-update-recovery"]
        XCTAssertTrue(reveal(app, row, tries: 12), "Settings keeps a quiet Update account recovery row.")
        bringToMiddle(app, row)
        row.tap()
        let p1 = app.secureTextFields["recovery-update-passphrase"]
        XCTAssertTrue(p1.waitForExistence(timeout: 10))
        p1.tap()
        p1.typeText("maple syrup forest")
        let p2 = app.secureTextFields["recovery-update-passphrase-2"]
        p2.tap()
        p2.typeText("maple syrup forest")
        app.buttons["recovery-update-confirm"].tap()
        expectProbe(app, "recovery passkey enrolled", timeout: 30)
        waitGone(app.buttons["recovery-update-confirm"], timeout: 20)
        XCTAssertFalse(app.buttons["settings-update-recovery"].exists, "Updated: the row is gone.")
    }

    /// Asked before on this device: Home doesn't ask again.
    func test_updatePromptIsNotRepeated() throws {
        let app = launch(tab: "home", ["-smoke-recovery-legacy", "-smoke-recovery-asked"])
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["recovery-update-title"].waitForExistence(timeout: 5))
        shot(app, "recovery-update-not-repeated")
    }

    // MARK: - Wipe & restart

    /// Wipe & restart carries the new passkey's attestation beside the old key's signature.
    func test_wipeRestartAttestsTheNewPasskey() throws {
        let app = launch(tab: "settings", ["-smoke-trusted-devices"])
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        let menu = box(app, "trusted-device-menu-\(otherDevice)")
        XCTAssertTrue(reveal(app, menu, tries: 12))
        bringToMiddle(app, menu)
        menu.tap()
        button(app, "Wipe & restart…").tap()
        let go = button(app, "Wipe and start over")
        XCTAssertTrue(go.waitForExistence(timeout: 5))
        go.tap()
        expectProbe(app, "wipe-restart new passkey attested", timeout: 30)
        shot(app, "wipe-restart-passkey")
    }

    // MARK: - Browser grants

    /// Two requests wait: the one-visit ask names the app, the exact sites (a wildcard says it reaches
    /// every address under it), what it can do and the app's own words; Allow once signs it. The session
    /// ask on a local device is denied with no signature.
    func test_browserGrantAllowOnceThenDeny() throws {
        let app = launch(tab: "home", ["-smoke-browser-grant"])
        let title = app.staticTexts["browser-grant-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25), "A waiting browser request opens the sheet.")
        XCTAssertEqual(title.label, "plants wants to use this server's browser.")
        XCTAssertTrue(app.staticTexts["*.example.org"].exists)
        XCTAssertTrue(app.staticTexts["and every address under it"].exists)
        XCTAssertTrue(app.staticTexts["news.example.com"].exists)
        XCTAssertTrue(app.staticTexts["For one visit"].exists)
        XCTAssertTrue(box(app, "browser-grant-explanation").label.contains("Read today's prices"))
        XCTAssertTrue(app.buttons["browser-grant-allow"].label == "Allow once")
        shot(app, "browser-grant-once")
        app.buttons["browser-grant-allow"].tap()
        let done = app.staticTexts["browser-grant-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Allowed. plants can use the browser as asked.")
        expectProbe(app, "signed browser-grant by admin-root")
        expectProbe(app, "browser grant allow bright-maple--plants once")
        app.buttons["browser-grant-close"].tap()

        XCTAssertTrue(title.waitForExistence(timeout: 15), "The next request is asked.")
        XCTAssertEqual(title.label, "wiki wants to use this server's browser.")
        XCTAssertEqual(box(app, "browser-grant-lan").label, "These devices on your network: 192.168.1.20")
        XCTAssertEqual(app.buttons["browser-grant-allow"].label, "Allow for this session")
        app.buttons["browser-grant-deny"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        XCTAssertEqual(done.label, "Denied. wiki can't use the browser for this.")
        expectProbe(app, "browser grant deny bright-maple--wiki session")
    }

    /// The app's page: the sites approved at install, and its waiting request answered there.
    func test_browserAccessOnTheAppPage() throws {
        let app = launch(tab: "apps", ["-smoke-browser-grant-app"])
        // The request also waits in the inbox: put it off there and answer it on the app page.
        let notNow = app.buttons["browser-grant-not-now"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 25), "The inbox asks too.")
        notNow.tap()
        waitGone(notNow)
        openApp(app, named: "Plants")
        let manifest = box(app, "app-browser-manifest")
        XCTAssertTrue(reveal(app, manifest, tries: 16), "The app page lists what was approved at install.")
        XCTAssertTrue(manifest.label.contains("Approved when you installed it"))
        XCTAssertTrue(manifest.label.contains("shop.example.com"))
        let allow = app.buttons["app-browser-allow"]
        XCTAssertTrue(reveal(app, allow, tries: 6))
        XCTAssertEqual(allow.label, "Always allow")
        shot(app, "browser-access-app-page")
        bringToMiddle(app, allow)
        allow.tap()
        let note = app.staticTexts["app-browser-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        expectProbe(app, "browser grant allow bright-maple--plants service")
    }

    /// A session ask offers Allow once beside Allow for this session; Allow once signs the shorter grant.
    func test_browserGrantNarrowedToOnce() throws {
        let app = launch(tab: "home", ["-smoke-browser-grant-narrow"])
        let title = app.staticTexts["browser-grant-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 25))
        XCTAssertEqual(title.label, "wiki wants to use this server's browser.")
        let once = app.buttons["browser-grant-allow-once"]
        XCTAssertTrue(once.exists)
        XCTAssertEqual(once.label, "Allow once")
        XCTAssertEqual(app.buttons["browser-grant-allow"].label, "Allow for this session")
        XCTAssertFalse(app.buttons["browser-grant-allow-service"].exists, "Never wider than the ask.")
        shot(app, "browser-grant-narrow")
        once.tap()
        let done = app.staticTexts["browser-grant-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        expectProbe(app, "browser grant allow bright-maple--wiki once")
    }

    /// The app page lists what the owner allowed beyond the manifest; Withdraw signs the revoke and the
    /// grant is gone.
    func test_browserGrantWithdrawOnTheAppPage() throws {
        let app = launch(tab: "apps", ["-smoke-browser-grant-granted"])
        openApp(app, named: "Plants")
        let heading = app.staticTexts["app-browser-granted-title"]
        XCTAssertTrue(reveal(app, heading, tries: 16), "The app page lists the grants the owner gave.")
        XCTAssertEqual(heading.label, "Allowed by you")
        XCTAssertTrue(app.staticTexts["prices.example.net"].exists)
        let withdraw = app.buttons["app-browser-withdraw"]
        XCTAssertTrue(reveal(app, withdraw, tries: 6))
        XCTAssertEqual(withdraw.label, "Withdraw")
        shot(app, "browser-grant-granted")
        bringToMiddle(app, withdraw)
        withdraw.tap()
        let note = app.staticTexts["app-browser-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        XCTAssertEqual(note.label, "Browser access withdrawn")
        expectProbe(app, "browser grant withdrawn bright-maple--plants")
        waitGone(app.buttons["app-browser-withdraw"])
        XCTAssertFalse(app.staticTexts["prices.example.net"].exists)
    }

    // MARK: - Upstream sync

    /// An imported app checks its repo at a chosen ref: the proposal names the version, the counts, the
    /// conflict kept as the owner's, and the new permission apart; Review and deploy opens the build.
    func test_syncProposalThenReview() throws {
        let app = launch(tab: "apps", ["-smoke-upstream-sync"])
        openApp(app, named: "Plants")
        let row = app.buttons["service-detail-sync"]
        XCTAssertTrue(reveal(app, row, tries: 12))
        XCTAssertEqual(row.label, "Check for updates from github.com/ana/plants")
        bringToMiddle(app, row)
        row.tap()
        let ref = app.textFields["sync-ref"]
        XCTAssertTrue(ref.waitForExistence(timeout: 10))
        ref.tap()
        ref.typeText("v2")
        app.buttons["sync-check"].tap()
        let version = app.staticTexts["sync-version"]
        XCTAssertTrue(version.waitForExistence(timeout: 20))
        XCTAssertEqual(version.label, "Version abcdef012345")
        expectProbe(app, "sync proposal bright-maple--plants at v2")
        XCTAssertTrue(box(app, "sync-permissions").exists, "New permissions are shown apart from the code.")
        XCTAssertTrue(app.staticTexts["New permissions"].exists)
        XCTAssertTrue(app.staticTexts["Internet access"].exists)
        XCTAssertTrue(text(app, containing: "api.weather.example").exists)
        XCTAssertEqual(app.staticTexts["sync-from-upstream"].label, "3 files updated from upstream")
        XCTAssertEqual(app.staticTexts["sync-yours-kept"].label, "2 of your changes kept")
        XCTAssertEqual(app.staticTexts["sync-conflicts"].label, "1 conflicts: your version was kept")
        shot(app, "sync-proposal")
        let review = app.buttons["sync-review"]
        XCTAssertTrue(reveal(app, review))
        review.tap()
        XCTAssertTrue(app.buttons["build-git-deploy"].waitForExistence(timeout: 20),
                      "Review opens the existing git build screen for the merge, with Deploy.")
        expectNoProbe(app, "discarded build gym-sync-build")
    }

    /// Already current: it says so, and the box opened no build, so closing discards nothing.
    func test_syncUpToDateOpensNoBuild() throws {
        let app = launch(tab: "apps", ["-smoke-upstream-sync-current"])
        openApp(app, named: "Plants")
        let row = app.buttons["service-detail-sync"]
        XCTAssertTrue(reveal(app, row, tries: 12))
        bringToMiddle(app, row)
        row.tap()
        let check = app.buttons["sync-check"]
        XCTAssertTrue(check.waitForExistence(timeout: 10))
        check.tap()
        let same = box(app, "sync-up-to-date")
        XCTAssertTrue(same.waitForExistence(timeout: 20))
        XCTAssertTrue(same.label.contains("You already run the latest version from github.com/ana/plants."))
        shot(app, "sync-up-to-date")
        app.buttons["sync-close"].tap()
        waitGone(same)
        expectNoProbe(app, "discarded build")
    }

    // MARK: - Update results (docs/support/update-rollback.md §5)

    /// A failed update the floor kept in recovery reads as stuck, not "went back on its own"; the
    /// Share update results switch is off and sends the owner's choice to the box.
    func test_updateKeptInRecoveryAndShareSwitch() throws {
        let app = launch(tab: "home", ["-smoke-update-kept-in-recovery"])
        openServerPage(app, named: "Home")
        let last = app.staticTexts["sd-update-last-outcome"]
        XCTAssertTrue(reveal(app, last, tries: 14), "The card says how the last update went.")
        XCTAssertTrue(last.label.contains("recovery mode"), "Got: \(last.label)")
        XCTAssertFalse(last.label.contains("on its own"), "Got: \(last.label)")
        let toggle = app.switches["sd-update-reports"]
        XCTAssertTrue(reveal(app, toggle, tries: 6), "The update card offers Share update results.")
        XCTAssertEqual(toggle.value as? String, "0")
        XCTAssertTrue(text(app, containing: "Never your server's name, your account or anything about your apps.").exists)
        shot(app, "update-results")
        toggle.switches.firstMatch.tap()
        expectProbe(app, "update reports on")
        wait(toggle, "value == '1'")
        toggle.switches.firstMatch.tap()
        expectProbe(app, "update reports off")
    }

    /// A refusal is one whole sentence; a box that refuses the session shows no switch.
    func test_updateRefusalSentenceAndNoSwitchWhenRefused() throws {
        let app = launch(tab: "home", ["-smoke-update-refused-stale"])
        openServerPage(app, named: "Home")
        let last = app.staticTexts["sd-update-last-outcome"]
        XCTAssertTrue(reveal(app, last, tries: 14))
        XCTAssertEqual(last.label, "The server refused the last update: the request was too old. Send it again.")
        XCTAssertFalse(app.switches["sd-update-reports"].exists)
        shot(app, "update-refusal")
    }
}
