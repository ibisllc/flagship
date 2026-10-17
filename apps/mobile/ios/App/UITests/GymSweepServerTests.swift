import XCTest

/// GYM iOS button sweep (mock tier), the server page and creating a server:
/// see GymSweepSupport. Every order a press sends is checked at the mock by
/// the key that signed it (GymProbe lines "signed <kind> by <key>").
final class GymSweepServerTests: GymSweepCase {

    /// A fresh launch for the server page: earlier runs' lock-down policies
    /// and pending updates forgotten.
    private func launchServer(admin: Bool = true, _ extra: [String] = []) -> XCUIApplication {
        launch(tab: "home", admin: admin, ["-smoke-server-fresh"] + extra)
    }

    private func value(_ el: XCUIElement) -> String { (el.value as? String) ?? "" }

    /// The alert's confirm button: its label is the alert title minus "?".
    private func confirmAlert(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10), "An alert should ask first.", file: file, line: line)
        let title = alert.staticTexts.firstMatch.label
        let action = String(title.dropLast())
        alert.buttons[action].tap()
    }

    // ─── Apps on this server ─────────────────────────────────────────────────

    /// The server page lists its apps; tapping one opens the app's page, and
    /// "Create app here" opens the build chooser pinned to this server.
    func test_serverAppsOpenAnAppAndCreateHere() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let plants = app.buttons["server-app-bright-maple--plants"]
        XCTAssertTrue(reveal(app, plants), "The server page lists Plants.")
        plants.tap()
        XCTAssertTrue(app.navigationBars["Plants"].waitForExistence(timeout: 15), "Tapping an app opens its page.")
        shot(app, "server-app-opened")

        let app2 = launchServer()
        openServerPage(app2, named: "Home")
        let create = app2.buttons["server-create-app-here"]
        XCTAssertTrue(reveal(app2, create))
        create.tap()
        XCTAssertTrue(app2.buttons["build-src-scratch"].waitForExistence(timeout: 15), "Create app here opens the build chooser.")
        let fixed = app2.descendants(matching: .any)["runs-on-fixed"]
        XCTAssertTrue(fixed.waitForExistence(timeout: 5), "…pinned to this server (no picker).")
        XCTAssertEqual(fixed.label, "Home")
        shot(app2, "create-app-here")
    }

    // ─── Runs on (the app page) ──────────────────────────────────────────────

    /// Unticking a server asks first (Cancel keeps the app, Remove sends the
    /// admin-signed uninstall); ticking it again copies the app back (an
    /// admin-signed copy).
    func test_runsOnUntickAsksThenRemovesAndTickCopies() throws {
        let app = launch(tab: "apps", ["-smoke-server-fresh"])
        openApp(app, named: "Plants")
        let office = app.buttons["runs-on-office.bright-maple.flagship.services"]
        XCTAssertTrue(reveal(app, office), "Runs on lists Office.")
        wait(office, "isEnabled == true", timeout: 20)
        if office.label == "Runs on Office" {
            office.tap()
            let remove = button(app, "Remove from Office")
            XCTAssertTrue(remove.waitForExistence(timeout: 10), "Unticking asks before removing.")
            cancelDialog(app)
            waitGone(remove)
            expectNoProbe(app, "uninstall")
            office.tap()
            XCTAssertTrue(remove.waitForExistence(timeout: 10))
            remove.tap()
            expectProbe(app, "signed uninstall by admin-root")
            wait(office, "label == 'Not on Office'", timeout: 20)
            wait(office, "isEnabled == true", timeout: 20)
        }
        XCTAssertEqual(office.label, "Not on Office")
        office.tap()
        expectProbe(app, "signed app-copy by admin-root")
        shot(app, "runs-on-copying")
    }

    /// A device without the admin root sees Runs on read-only, with the
    /// sentence the other apps use.
    func test_runsOnIsReadOnlyOnANonAdminDevice() throws {
        let app = launch(tab: "apps", admin: false, ["-smoke-server-fresh"])
        openApp(app, named: "Plants")
        let office = app.buttons["runs-on-office.bright-maple.flagship.services"]
        XCTAssertTrue(reveal(app, office))
        XCTAssertFalse(office.isEnabled, "A non-admin device can't tick a server.")
        let note = app.staticTexts["runs-on-note"]
        XCTAssertTrue(reveal(app, note))
        XCTAssertEqual(note.label, "Only an admin device can change where this app runs.")
    }

    // ─── Front page, journal, power, lock-down, monitoring ───────────────────

    func test_frontPageSavesAnAdminSignedOrder() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let picker = app.buttons["sd-front-page-picker"]
        XCTAssertTrue(reveal(app, picker), "The front-page card offers a picker.")
        let save = app.buttons["sd-front-page-save"]
        XCTAssertFalse(save.isEnabled, "Nothing to save until another page is picked.")
        picker.tap()
        let plants = app.buttons["Plants — plants"]
        XCTAssertTrue(plants.waitForExistence(timeout: 5), "The picker lists the server's apps.")
        plants.tap()
        wait(save, "isEnabled == true")
        save.tap()
        expectProbe(app, "signed front-page by admin-root")
        XCTAssertTrue(text(app, containing: "Front page set to plants").waitForExistence(timeout: 10))
        shot(app, "front-page-saved")
    }

    func test_journalFetchesBothUnits() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let fetch = app.buttons["sd-journal-fetch"]
        XCTAssertTrue(reveal(app, fetch))
        fetch.tap()
        XCTAssertTrue(text(app, containing: "gym: flagship-daemon started").waitForExistence(timeout: 15),
                      "View journal shows the box's lines.")
        expectProbe(app, "signed journal by irk")
        app.segmentedControls["sd-journal-unit"].buttons["flagship-data-services"].tap()
        fetch.tap()
        let lines = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "gym: serving 2 apps"))
        XCTAssertTrue(lines.firstMatch.waitForExistence(timeout: 15))
        shot(app, "journal")
    }

    /// Each power button asks first; Cancel sends nothing, confirming sends
    /// the admin-signed order and the card says what the box is doing.
    func test_powerAsksFirstThenSendsTheOrder() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let restart = app.buttons["sd-power-restart"]
        XCTAssertTrue(reveal(app, restart))
        restart.tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10), "Restart asks first.")
        alert.buttons["Cancel"].tap()
        waitGone(alert)
        expectNoProbe(app, "power-off")

        app.buttons["sd-power-off"].tap()
        confirmAlert(app)
        expectProbe(app, "signed power-off by admin-root")
        XCTAssertTrue(text(app, containing: "Powering off").waitForExistence(timeout: 10))
        shot(app, "powering-off")
    }

    /// Auto lock-down: turning it on, changing the window and what a lapse
    /// does, tightening and affirming each send an admin-signed order.
    func test_deadManPolicyWindowLockoutAffirm() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let open = app.buttons["sd-deadman-open"]
        XCTAssertTrue(reveal(app, open))
        open.tap()
        let toggle = app.switches["deadman-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(value(toggle), "0", "Lock-down starts off.")
        toggle.tap()
        expectProbe(app, "signed deadman-policy by admin-root")
        let window = app.segmentedControls["deadman-window-picker"]
        XCTAssertTrue(window.waitForExistence(timeout: 10), "On shows the window.")
        window.buttons["8 hours"].tap()
        wait(window.buttons["8 hours"], "isSelected == true")
        app.buttons["deadman-tighten"].tap()
        wait(window.buttons["15 minutes"], "isSelected == true")
        let lockout = app.segmentedControls["deadman-lockout-picker"]
        lockout.buttons["Restart"].tap()
        wait(lockout.buttons["Restart"], "isSelected == true")
        let affirm = app.buttons["deadman-affirm"]
        XCTAssertTrue(reveal(app, affirm))
        affirm.tap()
        expectProbe(app, "signed deadman-affirm by admin-root")
        XCTAssertTrue(text(app, containing: "stays unlocked").waitForExistence(timeout: 10))
        shot(app, "deadman-on")
        revealUp(app, toggle)
        toggle.tap()
        waitGone(window)
    }

    func test_monitoringRowsExpand() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let cpu = app.buttons["sd-monitor-cpu"]
        XCTAssertTrue(reveal(app, cpu))
        cpu.tap()
        XCTAssertTrue(text(app, containing: "Load ").waitForExistence(timeout: 10), "CPU opens its chart and load.")
        let memory = app.buttons["sd-monitor-memory"]
        XCTAssertTrue(reveal(app, memory))
        memory.tap()
        XCTAssertTrue(text(app, containing: "in use").waitForExistence(timeout: 10), "Memory opens its chart.")
        cpu.tap()
        waitGone(text(app, containing: "Load "))
        shot(app, "monitoring")
    }

    // ─── Migrate ─────────────────────────────────────────────────────────────

    private func openMigrate(_ app: XCUIApplication) {
        openServerPage(app, named: "Home")
        let migrate = app.buttons["sd-migrate-server"]
        XCTAssertTrue(reveal(app, migrate))
        migrate.tap()
        XCTAssertTrue(app.navigationBars["Migrate server"].waitForExistence(timeout: 15))
    }

    /// Start (admin-signed), then hand off to the new box (confirm-ready and
    /// the freeze, both admin-signed).
    func test_migrateStartsAndHandsOff() throws {
        let app = launchServer(["-smoke-server-directory"])
        openMigrate(app)
        let start = app.buttons["migrate-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 15), "Migrate opens on Start migration.")
        wait(start, "isEnabled == true")
        start.tap()
        expectProbe(app, "signed server-migration by admin-root")
        let handOff = app.buttons["migrate-hand-off"]
        XCTAssertTrue(handOff.waitForExistence(timeout: 15), "Once the new box restored the backup, hand off is offered.")
        shot(app, "migrate-pre-seeded")
        handOff.tap()
        expectProbe(app, "signed server-migration-control by admin-root")
        expectProbe(app, "signed server-decommission by admin-root")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'migrate-step-'"))
            .firstMatch.exists, "The timeline shows its steps.")
        app.navigationBars["Migrate server"].buttons["Done"].tap()
    }

    /// Abort before take-over: the old server stays with all its data.
    func test_migrateAbortKeepsTheOldServer() throws {
        let app = launchServer(["-smoke-server-directory"])
        openMigrate(app)
        let start = app.buttons["migrate-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 15))
        wait(start, "isEnabled == true")
        start.tap()
        let abort = app.buttons["migrate-abort"]
        XCTAssertTrue(abort.waitForExistence(timeout: 15))
        abort.tap()
        expectProbe(app, "signed server-migration-control by admin-root")
        XCTAssertTrue(text(app, containing: "Migration aborted").waitForExistence(timeout: 15))
        shot(app, "migrate-aborted")
    }

    /// Without a backup the server can't migrate: Start stays off and says why.
    func test_migrateWithoutABackupIsBlocked() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let migrate = app.buttons["sd-migrate-server"]
        XCTAssertTrue(reveal(app, migrate))
        migrate.tap()
        XCTAssertTrue(app.navigationBars["Migrate server"].waitForExistence(timeout: 15))
        // No directory entry for the box in the default fixture: it says it
        // can't read the box's key rather than offering a doomed start.
        XCTAssertTrue(text(app, containing: "Couldn't read this box's current key").waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["migrate-start"].exists)
    }

    // ─── Backup/clone ────────────────────────────────────────────────────────

    /// The passcode step (suggested or your own), then the backup is made,
    /// downloaded and offered to save.
    func test_backupPasscodeStartDownloadShare() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let backup = app.buttons["sd-backup-server"]
        XCTAssertTrue(reveal(app, backup))
        backup.tap()
        let suggested = app.staticTexts["backup-suggested-passcode"]
        XCTAssertTrue(suggested.waitForExistence(timeout: 10))
        button(app, "Copy").tap()
        XCTAssertTrue(button(app, "Copied").waitForExistence(timeout: 5))

        app.buttons["backup-use-own-passcode"].tap()
        XCTAssertTrue(app.secureTextFields["backup-own-passcode"].waitForExistence(timeout: 5))
        button(app, "Use the suggested passcode").tap()
        XCTAssertTrue(suggested.waitForExistence(timeout: 5), "Back to the suggested passcode.")

        let start = app.buttons["backup-start"]
        XCTAssertFalse(start.isEnabled)
        app.switches["backup-passcode-saved"].tap()
        wait(start, "isEnabled == true")
        start.tap()
        expectProbe(app, "backup started with 2 slots")
        let download = app.buttons["backup-download"]
        XCTAssertTrue(download.waitForExistence(timeout: 20), "The mock box reports the backup ready.")
        download.tap()
        let share = app.descendants(matching: .any)["backup-share"]
        XCTAssertTrue(share.waitForExistence(timeout: 20), "Downloaded: offer to save both files.")
        expectProbe(app, "backup forgotten")
        shot(app, "backup-saved")
        button(app, "Done").tap()
        waitGone(share)
    }

    // ─── Import a backup ─────────────────────────────────────────────────────

    /// Home's waiting server → the fixture backup is picked for it → it's this account's,
    /// so it opens at once → send it there → restored → Done.
    func test_importBackupSendsToTheWaitingServer() throws {
        let app = launchServer(["-smoke-awaiting-backup", "-smoke-import-archive"])
        let pill = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Waiting for its backup")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 15))
        pill.tap()
        let send = app.buttons["import-backup-send-existing"]
        XCTAssertTrue(send.waitForExistence(timeout: 20), "This account's backup opens without a passcode.")
        XCTAssertTrue(button(app, "Create a new server instead").exists)
        shot(app, "import-choose-target")
        send.tap()
        expectProbe(app, "restore committed", timeout: 30)
        let done = app.buttons["import-backup-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "The server says it's restored.")
        done.tap()
        waitGone(done)
    }

    /// Add/Import → Import a backup → the backup suggests its saved name →
    /// rename → Create the server hands over to the create screen.
    func test_importBackupAsANewServerReachesTheCreateScreen() throws {
        let app = launchServer(["-smoke-import-archive"])
        app.buttons["home-add-server"].tap()
        let importBackup = app.buttons.matching(identifier: "home-import-backup").firstMatch
        XCTAssertTrue(importBackup.waitForExistence(timeout: 10))
        importBackup.tap()
        let name = app.textFields["import-backup-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 20), "A backup no server waits for asks for a name.")
        XCTAssertEqual(value(name), "attic", "It suggests the saved server's name.")
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "Home")
        XCTAssertTrue(text(app, containing: "You already have a server called").waitForExistence(timeout: 5),
                      "A name the account uses is refused.")
        XCTAssertFalse(app.buttons["import-backup-create"].isEnabled)
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "cellar")
        let create = app.buttons["import-backup-create"]
        wait(create, "isEnabled == true")
        create.tap()
        XCTAssertTrue(app.buttons["cs-delivery-pair"].waitForExistence(timeout: 15),
                      "Create the server opens the create screen at its delivery step.")
        shot(app, "import-create")
    }

    /// Another account's backup: the account key doesn't open it, so it asks
    /// for the passcode and says when that one doesn't work.
    func test_importBackupFromAnotherAccountAsksForItsPasscode() throws {
        let app = launchServer(["-smoke-import-archive", "other"])
        app.buttons["home-add-server"].tap()
        app.buttons.matching(identifier: "home-import-backup").firstMatch.tap()
        let passcode = app.secureTextFields["import-backup-passcode"]
        XCTAssertTrue(passcode.waitForExistence(timeout: 20), "Another account's backup asks for its passcode.")
        let unlock = app.buttons["import-backup-unlock"]
        XCTAssertFalse(unlock.isEnabled, "Not until a passcode is typed.")
        passcode.tap()
        passcode.typeText("wrong passcode")
        unlock.tap()
        XCTAssertTrue(app.staticTexts["import-backup-error"].waitForExistence(timeout: 20), "It says the passcode didn't open it.")
        shot(app, "import-passcode")
    }

    // ─── Update ──────────────────────────────────────────────────────────────

    /// Advanced refuses a malformed commit; Update to latest sends the
    /// admin-signed order and the card then shows it on its way.
    func test_updateLatestSendsAnAdminSignedOrder() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let update = app.buttons["sd-update-server"]
        XCTAssertTrue(reveal(app, update))
        update.tap()
        XCTAssertTrue(app.navigationBars["Update server"].waitForExistence(timeout: 15))
        let latest = app.buttons["update-latest-btn"]
        XCTAssertTrue(latest.waitForExistence(timeout: 15), "The sheet offers the latest endorsed release.")

        button(app, "Advanced").tap()
        let target = app.textFields["update-target-field"]
        XCTAssertTrue(reveal(app, target))
        target.tap()
        target.typeText("abc")
        XCTAssertTrue(text(app, containing: "full 40-character commit hash").waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["update-order-btn"].isEnabled)

        XCTAssertTrue(revealUp(app, latest))
        latest.tap()
        expectProbe(app, "signed server-update by admin-root")
        XCTAssertTrue(app.descendants(matching: .any)["sd-update-pending"].waitForExistence(timeout: 15),
                      "The sheet says the update is on its way.")
        app.navigationBars["Update server"].buttons["Done"].tap()
        let pending = app.descendants(matching: .any)["sd-update-pending"]
        XCTAssertTrue(reveal(app, pending), "The card shows the pending update instead of the button.")
        XCTAssertFalse(app.buttons["sd-update-server"].exists)
        shot(app, "update-pending")
    }

    /// An update sent 31 minutes ago with no outcome: Send again re-sends
    /// it, Forget it brings the button back.
    func test_staleUpdateSendAgainThenForget() throws {
        let app = launchServer(["-smoke-update-stale"])
        openServerPage(app, named: "Home")
        let again = app.buttons["sd-update-send-again"]
        XCTAssertTrue(reveal(app, again), "A stale order offers Send again.")
        XCTAssertTrue(app.staticTexts["sd-update-stale"].exists)
        again.tap()
        expectProbe(app, "signed server-update by admin-root")
        XCTAssertTrue(revealUp(app, app.activityIndicators["sd-update-pending"]) || revealUp(app, any(app, "sd-update-pending")),
                      "Sending again makes the order fresh again (no Forget it until it is stale).")

        let app2 = launchServer(["-smoke-update-stale"])
        openServerPage(app2, named: "Home")
        let forget = app2.buttons["sd-update-forget"]
        XCTAssertTrue(reveal(app2, forget), "A stale order can be forgotten.")
        wait(forget, "isEnabled == true")
        forget.tap()
        XCTAssertTrue(reveal(app2, app2.buttons["sd-update-server"]), "Forget it brings back the update button.")
    }

    // ─── Danger zone ─────────────────────────────────────────────────────────

    /// Revoke: Cancel sends nothing; a reason plus a long hold revokes (the
    /// IRK signs it); Un-revoke (the admin root) restores it.
    func test_revokeHoldThenUnrevoke() throws {
        let app = launchServer()
        openServerPage(app, named: "Office")
        let revoke = app.buttons["sd-revoke-server"]
        XCTAssertTrue(reveal(app, revoke))
        revoke.tap()
        let hold = app.buttons["revoke-confirm-hold"]
        XCTAssertTrue(hold.waitForExistence(timeout: 10))
        button(app, "Cancel").tap()
        waitGone(hold)
        expectNoProbe(app, "server-revoke")

        revoke.tap()
        XCTAssertTrue(hold.waitForExistence(timeout: 10))
        let reasons = app.segmentedControls["revoke-reason-picker"]
        reasons.buttons["Lost"].tap()
        wait(reasons.buttons["Lost"], "isSelected == true")
        hold.tap()
        XCTAssertTrue(hold.exists, "A short tap doesn't revoke.")
        hold.press(forDuration: 2.2)
        expectProbe(app, "signed server-revoke by irk")
        let unrevoke = app.buttons["sd-unrevoke-server"]
        XCTAssertTrue(reveal(app, unrevoke), "A revoked server offers Un-revoke.")
        shot(app, "revoked")
        unrevoke.tap()
        expectProbe(app, "signed server-unrevoke by admin-root")
        XCTAssertTrue(reveal(app, app.buttons["sd-revoke-server"]), "Restored: Revoke is offered again.")
    }

    /// Delete: armed only by the server's name; then the erase order and the
    /// name release go out (both admin-signed) and the server leaves Home.
    func test_deleteNeedsTheNameThenErasesAndReleases() throws {
        let app = launchServer(["-smoke-server-identity"])
        openServerPage(app, named: "Office")
        let delete = app.buttons["sd-delete-server"]
        XCTAssertTrue(reveal(app, delete))
        delete.tap()
        let field = app.textFields["delete-server-name-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let confirm = app.buttons["delete-server-confirm"]
        XCTAssertFalse(confirm.isEnabled, "Not armed until the name is typed.")
        button(app, "Cancel").tap()
        waitGone(field)

        delete.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("offic")
        XCTAssertFalse(confirm.isEnabled, "A partial name doesn't arm it.")
        field.typeText("e")
        wait(confirm, "isEnabled == true")
        confirm.tap()
        expectProbe(app, "signed server-decommission by admin-root")
        expectProbe(app, "signed release-server-name by admin-root")
        XCTAssertTrue(app.staticTexts["YOUR SERVERS"].waitForExistence(timeout: 15), "Deleting returns to Home.")
        waitGone(podRow(app, named: "Office"))
    }

    /// Transfer: the address arms it, the offer is admin-signed, and the
    /// page shows the code for the new owner.
    func test_transferOfferShowsTheCode() throws {
        let app = launchServer()
        openServerPage(app, named: "Home")
        let transfer = app.buttons["sd-transfer-server"]
        XCTAssertTrue(reveal(app, transfer))
        transfer.tap()
        let field = app.textFields["transfer-confirm-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        app.buttons["transfer-start"].tap()
        expectNoProbe(app, "transfer-offer")
        field.tap()
        field.typeText("home.bright-maple.flagship.services")
        app.buttons["transfer-start"].tap()
        expectProbe(app, "signed transfer-offer by admin-root")
        XCTAssertTrue(text(app, containing: "Have the new owner scan this").waitForExistence(timeout: 15))
        shot(app, "transfer-qr")
        app.navigationBars["Transfer box"].buttons["Done"].tap()
    }

    /// Make leader on a demo account (the smoke account is one): the order
    /// is kept on the device, never signed or posted (ServerOrderTests cover
    /// the signed path for a real account).
    func test_makeLeaderOnADemoAccountKeepsTheOrderOnThePhone() throws {
        let app = launchServer()
        openServerPage(app, named: "Office")
        let make = app.buttons["sd-make-leader"]
        XCTAssertTrue(reveal(app, make))
        make.tap()
        XCTAssertTrue(app.staticTexts["sd-is-leader"].waitForExistence(timeout: 15))
        expectNoProbe(app, "server-order")
    }

    /// A device without the admin root sees the server read-only: one line
    /// says only an admin device can change it, and none of the page's
    /// orders (revoke and backup included, as in the webapp) is offered.
    func test_nonAdminServerPageIsReadOnly() throws {
        let app = launchServer(admin: false)
        openServerPage(app, named: "Office")
        let note = app.staticTexts["sd-admin-only"]
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        XCTAssertEqual(note.label, "Only an admin device can change this server. This device can see it.")
        XCTAssertTrue(reveal(app, app.buttons["sd-journal-fetch"]), "Reading the journal stays open.")
        let danger = app.staticTexts["sd-danger-admin-only"]
        XCTAssertTrue(reveal(app, danger))
        XCTAssertEqual(danger.label, note.label)
        for id in ["sd-power-off", "sd-power-restart", "sd-deadman-open", "sd-front-page-save", "sd-update-server",
                   "sd-backup-server", "sd-migrate-server", "sd-make-leader", "sd-transfer-server",
                   "sd-revoke-server", "sd-delete-server"] {
            XCTAssertFalse(app.buttons[id].exists, "\(id) is an admin device's.")
        }
        XCTAssertTrue(reveal(app, any(app, "sd-backups-admin-only")), "The Backups section says why it is read-only.")
        XCTAssertFalse(probe(app).contains("signed"), "Nothing was sent: \(probe(app))")
        shot(app, "non-admin-server-page")
    }

    /// A revoked server on a non-admin device: no Un-revoke, the same line.
    func test_nonAdminRevokedServerOffersNoUnrevoke() throws {
        let app = launchServer(admin: false, ["-smoke-revoked"])
        openServerPage(app, named: "Garage")
        let danger = app.staticTexts["sd-danger-admin-only"]
        XCTAssertTrue(reveal(app, danger))
        XCTAssertFalse(app.buttons["sd-unrevoke-server"].exists)
        XCTAssertFalse(app.buttons["sd-delete-server"].exists)
    }

    // ─── App sandbox notice ──────────────────────────────────────────────────

    func test_sandboxNoticeNamesTheFirewall() throws {
        let app = launchServer(["-smoke-sandbox-firewall-down"])
        openServerPage(app, named: "Home")
        let notice = app.staticTexts["sd-app-sandbox-notice"]
        XCTAssertTrue(reveal(app, notice))
        XCTAssertEqual(notice.label, "Apps can't start on this server: the internet firewall that keeps them to their allowed hosts isn't running (nftables isn't installed). The server tries again every 30 seconds.")
    }

    func test_sandboxNoticeNamesGvisor() throws {
        let app = launchServer(["-smoke-sandbox-gvisor-down"])
        openServerPage(app, named: "Home")
        let notice = app.staticTexts["sd-app-sandbox-notice"]
        XCTAssertTrue(reveal(app, notice))
        XCTAssertEqual(notice.label, "Apps can't start on this server: the sandbox they run in isn't working (runsc failed its test container). The server tries again every 10 minutes.")
    }

    // ─── Create a server ─────────────────────────────────────────────────────

    private func openCreate(_ app: XCUIApplication) {
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 15))
        add.tap()
        app.chooseAddNewServer()
    }

    /// The wizard: name + description + recipe expiry, Next / Back, then
    /// Copy recipe mints it (admin-signed install code); Cancel order frees
    /// the name and drops the new server from Home.
    func test_createServerCopyRecipeThenCancelOrder() throws {
        let app = launchServer()
        openCreate(app)
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        replaceText(name, with: "cellar")
        XCTAssertTrue(app.staticTexts["cs-fqdn-preview"].label.hasPrefix("cellar."), "The address follows the name.")
        let desc = app.textFields["cs-description-field"]
        desc.tap()
        desc.typeText("Basement box")
        let slider = app.sliders["cs-ttl-slider"]
        XCTAssertTrue(slider.exists)
        slider.adjust(toNormalizedSliderPosition: 0)
        XCTAssertEqual(app.staticTexts["cs-ttl-label"].label, "30 min", "The recipe expiry follows the slider.")
        app.buttons["cs-next-button"].tap()
        XCTAssertTrue(app.switches["cs-encrypt-disk-toggle"].waitForExistence(timeout: 10))
        app.buttons["cs-back-button"].tap()
        XCTAssertEqual(value(app.textFields["cs-name-field"]), "cellar", "Back keeps what was typed.")
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-next-button"].tap()
        let cont = app.buttons["cs-continue-button"]
        XCTAssertTrue(cont.waitForExistence(timeout: 10))
        cont.tap()
        let copy = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Copy recipe to clipboard")).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 10))
        copy.tap()
        expectProbe(app, "signed auth-code-admin by admin-root")
        let cancel = app.buttons["cs-cancel-order-button"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 20), "The recipe is out: the delivered page.")
        XCTAssertTrue(app.buttons["cs-done-button"].exists)
        shot(app, "create-delivered")
        cancel.tap()
        expectProbe(app, "signed release-server-name by admin-root")
        expectProbe(app, "auth code revoked")
        XCTAssertTrue(app.staticTexts["YOUR SERVERS"].waitForExistence(timeout: 15))
        XCTAssertFalse(podRow(app, named: "Cellar").exists || podRow(app, named: "cellar").exists,
                       "A cancelled order leaves Home.")
    }

    /// Done on the delivered page keeps the new server on Home, pending.
    func test_createServerCopyRecipeDoneAddsItToHome() throws {
        let app = launchServer()
        openCreate(app)
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        replaceText(name, with: "loft")
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-continue-button"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Copy recipe to clipboard")).firstMatch.tap()
        let done = app.buttons["cs-done-button"]
        XCTAssertTrue(done.waitForExistence(timeout: 20))
        done.tap()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "loft")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The new server is on Home.")
    }

    /// Pair with the builder by its typed code (a scripted Studio peer): the
    /// security code shows, "They match" mints and sends the recipe, Done
    /// lands on the delivered page.
    func test_builderPairByCodeDeliversTheRecipe() throws {
        let app = launchServer(["-smoke-builder-peer"])
        openCreate(app)
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        replaceText(name, with: "den")
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-continue-button"].tap()
        app.buttons["cs-delivery-pair"].tap()
        let byCode = button(app, "Enter the code instead")
        XCTAssertTrue(byCode.waitForExistence(timeout: 10))
        byCode.tap()
        let connect = button(app, "Connect")
        XCTAssertTrue(connect.waitForExistence(timeout: 5))
        XCTAssertFalse(connect.isEnabled, "Not until a code is typed.")
        button(app, "Scan the QR instead").tap()
        XCTAssertTrue(byCode.waitForExistence(timeout: 5), "Back to the scanner.")
        byCode.tap()
        let field = app.textFields.firstMatch
        field.tap()
        field.typeText("ABCD-EFGH")
        wait(connect, "isEnabled == true")
        connect.tap()
        expectProbe(app, "builder connected")
        let match = button(app, "They match — pair & send")
        XCTAssertTrue(match.waitForExistence(timeout: 15), "The security code shows.")
        wait(match, "isEnabled == true")
        match.tap()
        expectProbe(app, "recipe delivered to the builder")
        expectProbe(app, "signed auth-code-admin by admin-root")
        XCTAssertTrue(text(app, containing: "Sent — you can close this screen").waitForExistence(timeout: 15))
        button(app, "Done").tap()
        XCTAssertTrue(app.buttons["cs-done-button"].waitForExistence(timeout: 15), "The delivered page follows.")
    }

    /// The pairing sheet's Cancel on the security code returns to the
    /// delivery choices with nothing sent.
    func test_builderPairCancelSendsNothing() throws {
        let app = launchServer(["-smoke-builder-peer"])
        openCreate(app)
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        replaceText(name, with: "shed")
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-next-button"].tap()
        app.buttons["cs-continue-button"].tap()
        app.buttons["cs-delivery-pair"].tap()
        button(app, "Enter the code instead").tap()
        let field = app.textFields.firstMatch
        field.tap()
        field.typeText("ABCDEFGH")
        button(app, "Connect").tap()
        let cancel = button(app, "Cancel")
        XCTAssertTrue(button(app, "They match — pair & send").waitForExistence(timeout: 15))
        cancel.tap()
        XCTAssertTrue(app.buttons["cs-delivery-pair"].waitForExistence(timeout: 10), "Cancel returns to the delivery choices.")
        expectNoProbe(app, "recipe delivered")
    }

    // ─── Backups section, import and restore ────────────────────────────────

    private let older = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
    private let adminOnly = "Only an admin device can change this server. This device can see it."

    /// Home → Home's server page, scrolled to the Backups section.
    private func openBackups(_ app: XCUIApplication, _ seam: String) {
        openServerPage(app, named: "Home")
        XCTAssertTrue(reveal(app, any(app, "sd-backups-status"), tries: 14), "The server page should show the Backups section.")
    }

    // 1. No backups yet, admin device: keys are deposited with one approval, then "Next backup".
    func test_backupsFreshAdminDepositsKeysThenShowsNextBackup() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-fresh"])
        openBackups(app, "-smoke-backups-fresh")
        expectProbe(app, "deposited 400 backup keys")
        expectProbe(app, "signed server-archive-keys by admin-root")
        XCTAssertEqual(any(app, "sd-backups-status").label, "No backups yet.")
        let next = any(app, "sd-backups-next")
        XCTAssertTrue(next.waitForExistence(timeout: 10), "Once keys are in, the next scheduled backup shows.")
        XCTAssertTrue(next.label.hasPrefix("Next backup: "), "Got: \(next.label)")
        XCTAssertTrue(any(app, "sd-backups-policy").label.contains("Not chosen yet"))
        shot(app, "backups-fresh-admin")
    }

    // A full app is named on the Backups section.
    func test_aFullAppIsNamedOnTheBackupsSection() throws {
        let app = launch(tab: "home", admin: false, ["-smoke-backups-ready"])
        openBackups(app, "-smoke-backups-ready")
        let note = any(app, "sd-backups-storage-0")
        XCTAssertTrue(reveal(app, note), "Wiki's files folder is full, so the section says so.")
        XCTAssertEqual(note.label, "Wiki is full: new data is refused until you free space or raise the limit.")
        shot(app, "backups-app-full")
    }

    // 2. A non-admin device with an empty pool: the box's reason; the controls are admin-only.
    func test_backupsNonAdminShowsTheBoxReasonAndAdminOnlyControls() throws {
        let app = launch(tab: "home", admin: false, ["-smoke-backups-waiting"])
        openBackups(app, "-smoke-backups-waiting")
        let next = any(app, "sd-backups-next")
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(next.label.hasPrefix("An admin device of your account hasn't approved backups for this server yet"), "Got: \(next.label)")
        XCTAssertFalse(any(app, "sd-backups-approve").exists, "A non-admin device never offers the approval.")
        XCTAssertTrue(reveal(app, any(app, "sd-backups-admin-only")))
        XCTAssertEqual(any(app, "sd-backups-admin-only").label, adminOnly)
        XCTAssertFalse(app.buttons["sd-backups-run"].isEnabled, "Back up now is admin-only.")
        XCTAssertFalse(app.buttons["sd-backups-schedule-change"].isEnabled, "Changing the schedule is admin-only.")
        XCTAssertFalse(app.buttons["sd-backups-policy-change"].isEnabled, "Changing the policy is admin-only.")
        let delete = app.buttons["sd-backup-delete-\(older)"]
        XCTAssertTrue(reveal(app, delete))
        XCTAssertFalse(delete.isEnabled, "Delete is admin-only.")
        XCTAssertTrue(app.buttons["sd-backup-download-\(older)"].isEnabled, "Any device of the owner may download.")
        expectNoProbe(app, "deposited")
        shot(app, "backups-non-admin")
    }

    // 3. Back up now: running progress, then the new backup is listed.
    func test_backUpNowShowsProgressThenListsTheBackup() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-ready"])
        openBackups(app, "-smoke-backups-ready")
        let run = app.buttons["sd-backups-run"]
        XCTAssertTrue(reveal(app, run))
        run.tap()
        expectProbe(app, "backup now ")
        let status = any(app, "sd-backups-status")
        XCTAssertTrue(revealUp(app, status))
        wait(status, "label BEGINSWITH 'Backing up…'", timeout: 10)
        shot(app, "backups-running")
        wait(status, "label BEGINSWITH 'Last backup: '", timeout: 20)
        let rows = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'sd-backup-row-'"))
        XCTAssertEqual(rows.count, 2, "The new backup joins the list.")
        XCTAssertTrue(rows.element(boundBy: 0).label.contains("Back up now"), "Newest first, marked Back up now: \(rows.element(boundBy: 0).label)")
        shot(app, "backups-listed")
    }

    // 4. The last run failed: a red line with the box's sentence.
    func test_aFailedRunShowsTheBoxSentence() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-failed"])
        openBackups(app, "-smoke-backups-failed")
        let failed = any(app, "sd-backups-failed")
        XCTAssertTrue(failed.waitForExistence(timeout: 10))
        XCTAssertEqual(failed.label, "The last backup failed: needs about 4.0 GB, has 1.0 GB.")
        shot(app, "backups-failed")
    }

    // 5. Weekly on a local weekday: the PUT names the right UTC minute and weekday.
    func test_weeklyScheduleInLocalTimeIsSentInUtc() throws {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", "home", "-smoke-username", "bright-maple", "-smoke-admin-root", "-smoke-backups-ready"]
        // 03:00 UTC is Saturday evening in Chicago; Sunday evening there is Monday 03:00 UTC.
        app.launchEnvironment["TZ"] = "America/Chicago"
        app.launch()
        openBackups(app, "-smoke-backups-ready")
        let change = app.buttons["sd-backups-schedule-change"]
        XCTAssertTrue(reveal(app, change))
        change.tap()
        let weekly = app.segmentedControls["backup-schedule-frequency"].buttons["Weekly"]
        XCTAssertTrue(weekly.waitForExistence(timeout: 10))
        weekly.tap()
        let day = any(app, "backup-schedule-weekday")
        XCTAssertTrue(day.waitForExistence(timeout: 5))
        day.tap()
        let sunday = button(app, "Sunday")
        XCTAssertTrue(sunday.waitForExistence(timeout: 5))
        sunday.tap()
        shot(app, "backups-schedule-editor")
        app.buttons["backup-schedule-save"].tap()
        expectProbe(app, "put backup schedule weekly minute 180 weekday 1 keep 7/4")
        let line = any(app, "sd-backups-schedule")
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertTrue(line.label.hasPrefix("Weekly on Sunday at "), "Got: \(line.label)")
    }

    // 6. Download a saved backup (one .flagship file) and delete one after confirming.
    func test_downloadOneFileAndDeleteWithConfirmation() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-ready"])
        openBackups(app, "-smoke-backups-ready")
        let download = app.buttons["sd-backup-download-\(older)"]
        XCTAssertTrue(reveal(app, download))
        download.tap()
        expectProbe(app, "downloaded backup \(older)")
        XCTAssertTrue(any(app, "sd-backup-save-\(older)").waitForExistence(timeout: 15), "The downloaded file can be saved.")
        XCTAssertTrue(reveal(app, any(app, "sd-backups-note")))
        XCTAssertTrue(any(app, "sd-backups-note").label.hasPrefix("Each backup is one .flagship file."))
        shot(app, "backups-downloaded")

        app.buttons["sd-backup-delete-\(older)"].tap()
        let confirm = app.alerts.buttons["Delete"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Delete asks first.")
        XCTAssertTrue(app.alerts.staticTexts["Delete this backup from the server?"].exists)
        confirm.tap()
        expectProbe(app, "deleted backup \(older)")
        waitGone(any(app, "sd-backup-row-\(older)"))
        expectNoProbe(app, "server-archive-forget")
    }

    // 7. The create form's policy picker: the new words and the reserve.
    func test_createFormOffersThePoliciesWithTheReserve() throws {
        let app = launch(tab: "home", admin: true)
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.chooseAddNewServer()
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        replaceText(name, with: "lab")
        app.buttons["cs-next-button"].tap()
        XCTAssertTrue(app.switches["cs-encrypt-disk-toggle"].waitForExistence(timeout: 10))
        app.buttons["cs-next-button"].tap()
        let phone = any(app, "cs-backup-policy-phone-only")
        XCTAssertTrue(phone.waitForExistence(timeout: 10), "The create form offers the backup policies.")
        // The draft persists between runs (the last run left it on "No backups").
        phone.tap()
        XCTAssertTrue(text(app, containing: "this phone keeps a copy, over Wi-Fi while charging").exists)
        XCTAssertTrue(reveal(app, any(app, "cs-backup-policy-reserve"), tries: 4), "Phone-side asks how much this phone keeps.")
        XCTAssertTrue(text(app, containing: "free.").exists, "It says how much the phone has free.")
        any(app, "cs-backup-policy-none").tap()
        XCTAssertTrue(text(app, containing: "If this server's disk fails, its apps and data are gone.").exists)
        XCTAssertFalse(any(app, "cs-backup-policy-reserve").exists, "The reserve is for phone-side only.")
        shot(app, "create-backup-policy")
    }

    // 8a. Policy: Phone → Peer is a signed POST.
    func test_changePolicyPhoneToPeerIsSigned() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-ready"])
        openBackups(app, "-smoke-backups-ready")
        let policy = any(app, "sd-backups-policy")
        XCTAssertTrue(revealUp(app, policy))
        XCTAssertEqual(policy.label, "Backup policy: Phone-side backups · up to 32.0 GB")
        XCTAssertTrue(any(app, "sd-backups-usage").label.hasPrefix("Apps use 3.2 GB of 32.0 GB"))
        let change = app.buttons["sd-backups-policy-change"]
        XCTAssertTrue(reveal(app, change))
        change.tap()
        let peer = any(app, "backup-policy-peer")
        if !peer.waitForExistence(timeout: 5) {
            XCTAssertTrue(reveal(app, change))
            change.tap()
        }
        XCTAssertTrue(peer.waitForExistence(timeout: 10))
        peer.tap()
        app.buttons["backup-policy-save"].tap()
        expectProbe(app, "signed backup-policy by admin-root")
        expectProbe(app, "set backup-policy peer 0")
        wait(any(app, "sd-backups-policy"), "label BEGINSWITH 'Backup policy: Peer-distributed backups'", timeout: 10)
    }

    // 8b. Over the limit, peer status, and a refused change with the box's sentence.
    func test_overLimitPeerStatusAndARefusedChange() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-peer-over"])
        openBackups(app, "-smoke-backups-peer-over")
        let over = any(app, "sd-backups-over-limit")
        XCTAssertTrue(revealUp(app, over))
        XCTAssertTrue(over.label.hasPrefix("This server holds 150 GB of app data, over its backup limit of 120 GB"), "Got: \(over.label)")
        let peer = any(app, "sd-backups-peer")
        XCTAssertTrue(peer.exists)
        XCTAssertTrue(peer.label.contains("3 of 5 pieces safe"), "Got: \(peer.label)")
        XCTAssertTrue(peer.label.contains("Holds 12.0 GB for other servers"), "Got: \(peer.label)")
        shot(app, "backups-peer-over")
        app.buttons["sd-backups-policy-change"].tap()
        let phone = any(app, "backup-policy-phone-only")
        XCTAssertTrue(phone.waitForExistence(timeout: 10))
        phone.tap()
        app.buttons["backup-policy-save"].tap()
        let err = any(app, "backup-policy-error")
        XCTAssertTrue(err.waitForExistence(timeout: 10), "The box's refusal shows in the editor.")
        XCTAssertTrue(err.label.hasPrefix("This server holds 150 GB of app data, more than the"), "Got: \(err.label)")
        expectProbe(app, "refused backup-policy over limit")
        shot(app, "backup-policy-refused")
    }

    // 8c. Not chosen yet → Choose.
    func test_notChosenYetOffersChoose() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-backups-fresh"])
        openBackups(app, "-smoke-backups-fresh")
        let choose = app.buttons["sd-backups-policy-change"]
        XCTAssertTrue(revealUp(app, choose))
        XCTAssertEqual(choose.label, "Choose")
        choose.tap()
        let none = any(app, "backup-policy-none")
        XCTAssertTrue(none.waitForExistence(timeout: 10))
        none.tap()
        app.buttons["backup-policy-save"].tap()
        expectProbe(app, "set backup-policy none 0")
        wait(any(app, "sd-backups-policy"), "label == 'Backup policy: No backups'", timeout: 10)
        XCTAssertFalse(any(app, "sd-backups-schedule").exists, "No backups: the schedule is hidden.")
        XCTAssertTrue(app.buttons["sd-backups-run"].exists, "Back up now stays.")
    }

    // Restore: one .flagship file, every app tried, one failed and named with the box's reason.
    func test_restoreOneFileNamesTheAppThatFailed() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-restore-one-failed"])
        let pill = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Waiting for its backup")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 15))
        pill.tap()
        let send = app.buttons["import-backup-send-existing"]
        XCTAssertTrue(send.waitForExistence(timeout: 30), "The picked file opens with the account key and checks out.")
        send.tap()
        let restored = any(app, "import-backup-restored")
        XCTAssertTrue(restored.waitForExistence(timeout: 60), "The restore ends.")
        XCTAssertEqual(restored.label, "Restored 1 app")
        let failed = any(app, "import-backup-failed-app")
        XCTAssertEqual(failed.label, "Couldn't restore: Notes: its image didn't build")
        shot(app, "restore-one-failed")
        app.buttons["import-backup-done"].tap()
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Waiting for its backup")).firstMatch
            .waitForExistence(timeout: 3), "Home shows the server as normal once the restore is done.")
    }

    // Restore from other servers: the lost server's backup comes back from the
    // pieces other servers keep; every app is tried and the failed one is named.
    func test_restoreFromOtherServersGetsTheBackupFromPeers() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-restore-from-peers"])
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let door = app.buttons.matching(identifier: "home-restore-from-peers").firstMatch
        XCTAssertTrue(door.waitForExistence(timeout: 10), "Add/Import a server offers Restore from other servers.")
        door.tap()
        let lost = app.textFields["restore-peers-lost"]
        XCTAssertTrue(lost.waitForExistence(timeout: 10))
        lost.tap()
        lost.typeText("lost.bright-maple.flagship.services")
        app.buttons["restore-peers-find"].tap()
        let summary = any(app, "restore-peers-summary")
        XCTAssertTrue(summary.waitForExistence(timeout: 30), "The lost server's record opens with the account key.")
        shot(app, "restore-peers-found")
        let send = app.buttons["import-backup-send-existing"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.tap()
        let restored = any(app, "import-backup-restored")
        XCTAssertTrue(restored.waitForExistence(timeout: 60), "The restore ends.")
        XCTAssertEqual(restored.label, "Restored 1 app")
        XCTAssertEqual(any(app, "import-backup-failed-app").label, "Couldn't restore: Notes: its image didn't build")
        shot(app, "restore-peers-done")
    }

    // A server that holds nothing of the lost one's: the record isn't found, in words.
    func test_restoreFromOtherServersSaysWhenNothingIsFound() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-restore-from-peers"])
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        app.buttons.matching(identifier: "home-restore-from-peers").firstMatch.tap()
        let lost = app.textFields["restore-peers-lost"]
        XCTAssertTrue(lost.waitForExistence(timeout: 10))
        lost.tap()
        lost.typeText("nobody.bright-maple.flagship.services")
        app.buttons["restore-peers-find"].tap()
        XCTAssertTrue(app.staticTexts["No peer backup of that server was found."].waitForExistence(timeout: 30)
                      || app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'No peer backup'")).firstMatch.waitForExistence(timeout: 5))
        shot(app, "restore-peers-not-found")
    }

    // The v2 peer-backup page: state, the servers holding the pieces (never named), what this one keeps.
    func test_peerBackupPageShowsTheStateAndHolders() throws {
        let app = launch(tab: "settings", admin: true, ["-smoke-peer-status"])
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Peer backup'")).firstMatch
        XCTAssertTrue(reveal(app, row), "Settings lists Peer backup.")
        row.tap()
        XCTAssertTrue(any(app, "peer-backup-state-protected").waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Server 1"].waitForExistence(timeout: 5), "Holders are Server 1..n, never named.")
        XCTAssertTrue(app.staticTexts["Server 2"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Offline · no proof yet'")).firstMatch.exists)
        XCTAssertTrue(reveal(app, any(app, "peer-backup-hosting")))
        shot(app, "peer-backup-v2")
    }

    // Import refuses a cut-short .flagship file with the sentence.
    func test_importRefusesACutShortFile() throws {
        let app = launch(tab: "home", admin: true, ["-smoke-restore-damaged"])
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let importBackup = app.buttons.matching(identifier: "home-import-backup").firstMatch
        XCTAssertTrue(importBackup.waitForExistence(timeout: 10))
        importBackup.tap()
        let err = any(app, "import-backup-error")
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertEqual(err.label, "This backup is cut short: it ends before its data.")
        shot(app, "import-cut-short")
    }
}
