import XCTest

/// GYM iOS button sweep (mock tier), Server: see GymSweepSupport.
/// The Backups section on the server page (docs/server-backup-and-clone.md,
/// "Backup policy" and "Scheduled backups"), against the mock box, which
/// answers the box's routes with its shapes, sentences and signature checks.
final class GymSweepServerTests: GymSweepCase {

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
        name.tap()
        name.typeText("lab")
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
        app.buttons["sd-backups-policy-change"].tap()
        let peer = any(app, "backup-policy-peer")
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
