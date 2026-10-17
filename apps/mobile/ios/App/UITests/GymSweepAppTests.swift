import XCTest

/// GYM iOS button sweep (mock tier), Services: every control on an app's
/// page and the screens it opens (internet access, API keys, database,
/// access control, runs on, environment, edit, address, backup, browser),
/// pressed from the Services tab and checked against what the mocks saw.
final class GymSweepAppTests: GymSweepCase {

    // MARK: helpers

    /// The button with `label` that a dialog or action sheet added: the last
    /// match, since the control that opened it often carries the same label.
    private func dialogButton(_ app: XCUIApplication, _ label: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let all = app.buttons.matching(NSPredicate(format: "label == %@", label))
        let sheet = app.sheets.buttons[label]
        if sheet.waitForExistence(timeout: 3) { return sheet }
        XCTAssertTrue(all.firstMatch.waitForExistence(timeout: 5), "No \"\(label)\" button.", file: file, line: line)
        return all.element(boundBy: max(0, all.count - 1))
    }


    private func openPlantsAccess(_ app: XCUIApplication) {
        openApp(app, named: "Plants")
        let access = app.buttons["service-detail-open-access"]
        XCTAssertTrue(reveal(app, access))
        access.tap()
        XCTAssertTrue(app.navigationBars["Access control"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["service-access-members-title"].waitForExistence(timeout: 10))
    }

    private func typeInto(_ app: XCUIApplication, _ field: XCUIElement, _ text: String) {
        XCTAssertTrue(reveal(app, field))
        field.tap()
        field.typeText(text)
    }

    // MARK: Services list

    /// The owner chips narrow the list to the user's own or shared apps; the
    /// pod switcher filters by server and names it.
    func test_servicesListChipsAndServerFilter() throws {
        let app = launch(tab: "apps")
        let plants = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "plants")).firstMatch
        let scratch = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "scratchpad")).firstMatch
        XCTAssertTrue(plants.waitForExistence(timeout: 20))
        XCTAssertTrue(scratch.exists)
        let shared = any(app, "fs-chip-shared")
        XCTAssertTrue(shared.waitForExistence(timeout: 5), "A list with someone else's app offers the owner chips.")
        shared.tap()
        waitGone(plants)
        XCTAssertTrue(scratch.exists, "Shared shows only Trent's app.")
        any(app, "fs-chip-yours").tap()
        XCTAssertTrue(plants.waitForExistence(timeout: 5))
        waitGone(scratch)
        any(app, "fs-chip-all").tap()
        XCTAssertTrue(scratch.waitForExistence(timeout: 5))
        shot(app, "services-chips")

        let switcher = app.buttons["pod-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 10))
        switcher.tap()
        let office = app.buttons.matching(NSPredicate(format: "label == %@", "Office")).firstMatch
        XCTAssertTrue(office.waitForExistence(timeout: 10), "The switcher lists the servers.")
        office.tap()
        wait(switcher, "label CONTAINS 'Office'")
        switcher.tap()
        let all = app.buttons.matching(NSPredicate(format: "label == %@", "All servers")).firstMatch
        XCTAssertTrue(all.waitForExistence(timeout: 10))
        all.tap()
        wait(switcher, "label CONTAINS 'All servers'")
    }

    /// Remove app asks first; Cancel keeps it; Remove signs the uninstall
    /// with the admin root and returns to the list.
    func test_removeAppConfirmsAndSignsTheUninstall() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let remove = app.buttons["service-detail-remove-btn"]
        XCTAssertTrue(reveal(app, remove))
        remove.tap()
        XCTAssertTrue(text(app, containing: "This uninstalls the service from").waitForExistence(timeout: 10))
        cancelDialog(app)
        XCTAssertTrue(app.navigationBars["Plants"].exists, "Cancel keeps the app.")
        expectNoProbe(app, "uninstall")
        XCTAssertTrue(reveal(app, remove))
        remove.tap()
        dialogButton(app, "Remove app").tap()
        expectProbe(app, "signed uninstall by admin-root")
        XCTAssertTrue(app.navigationBars["Services"].waitForExistence(timeout: 15), "Removing returns to the list.")
    }

    // MARK: Internet access (access list)

    /// Deny signs the list, Ignore drops the request unsigned, and the
    /// editor saves a re-signed list (Cancel saves nothing).
    func test_accessListDenyIgnoreAndEditorSave() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let deny = app.buttons["service-detail-access-deny"].firstMatch
        XCTAssertTrue(reveal(app, deny), "Plants has hosts waiting.")
        XCTAssertEqual(app.buttons.matching(identifier: "service-detail-access-deny").count, 2)
        deny.tap()
        expectProbe(app, "signed app-access by admin-root")
        let denied = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Plants won't reach")).firstMatch
        XCTAssertTrue(denied.waitForExistence(timeout: 10), "Deny says so on the page.")
        let ignore = app.buttons["service-detail-access-ignore"].firstMatch
        XCTAssertTrue(reveal(app, ignore))
        ignore.tap()
        expectProbe(app, "ignored ")
        waitGone(app.buttons["service-detail-access-ignore"].firstMatch)
        shot(app, "access-denied-ignored")

        let view = app.buttons["service-detail-access-view-list"]
        XCTAssertTrue(reveal(app, view))
        view.tap()
        let editor = app.textViews["access-list-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        app.buttons["Cancel"].tap()
        waitGone(editor)

        view.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        replaceText(editor, with: "allow example.org")
        let save = app.buttons["access-list-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        wait(save, "isEnabled == true")
        save.tap()
        waitGone(editor, timeout: 15)
        XCTAssertEqual(probe(app).components(separatedBy: "signed app-access by admin-root").count - 1, 2,
                       "The edited list is signed again: \(probe(app))")
    }

    /// A suggested list: Review opens the editor with the app's note and
    /// Save signs it; Dismiss drops the suggestion unsigned.
    func test_accessDraftReviewAndDismiss() throws {
        var app = launch(tab: "apps", ["-smoke-access-draft"])
        openApp(app, named: "Plants")
        let review = app.buttons["service-detail-access-draft-review"]
        XCTAssertTrue(reveal(app, review), "Plants' suggested list shows on its page.")
        XCTAssertTrue(any(app, "access-draft-host").exists)
        review.tap()
        let note = app.staticTexts["access-list-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertTrue((app.textViews["access-list-editor"].value as? String ?? "").contains("allow api.open-meteo.com"))
        app.buttons["access-list-save"].tap()
        expectProbe(app, "signed app-access by admin-root")
        shot(app, "access-draft-saved")

        app = launch(tab: "apps", ["-smoke-access-draft"])
        openApp(app, named: "Plants")
        let dismiss = app.buttons["service-detail-access-draft-dismiss"]
        XCTAssertTrue(reveal(app, dismiss))
        dismiss.tap()
        expectProbe(app, "dismissed draft for bright-maple--plants")
        waitGone(dismiss)
        expectNoProbe(app, "signed app-access")
    }

    /// The app-wide sheet: after an answer, View access list opens the
    /// editor in place; a suggested list's Review opens that app's editor.
    func test_accessAlertViewListAndDraftReview() throws {
        var app = launch(tab: "home", ["-smoke-access-alert"])
        let allow = app.buttons["access-alert-allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20))
        allow.tap()
        XCTAssertTrue(app.staticTexts["access-alert-done"].waitForExistence(timeout: 15))
        expectProbe(app, "signed app-access by admin-root")
        app.buttons["View access list"].tap()
        XCTAssertTrue(app.textViews["access-list-editor"].waitForExistence(timeout: 10),
                      "View access list opens the editor in the sheet.")
        shot(app, "access-alert-editor")

        app = launch(tab: "home", ["-smoke-access-alert", "-smoke-access-draft"])
        let draftTitle = app.staticTexts["access-alert-draft-title"]
        let notNow = app.buttons["access-alert-not-now"]
        // Waiting hosts may be asked first; set them aside until the suggestion shows.
        for _ in 0..<4 where !draftTitle.waitForExistence(timeout: 8) {
            if notNow.exists { notNow.tap() }
        }
        XCTAssertTrue(draftTitle.waitForExistence(timeout: 10), "The sheet offers the suggested list.")
        XCTAssertEqual(draftTitle.label, "Plants suggests an access list")
        app.buttons["access-alert-draft-review"].tap()
        let note = app.staticTexts["access-list-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 15), "Review opens the editor with the suggestion.")
    }

    // MARK: Legacy internet card (older box)

    /// Without access lists: Allow signs the egress grant; Stop access asks
    /// first, Cancel keeps it, Stop signs an empty list. A non-admin device
    /// gets neither button and sends nothing.
    func test_legacyEgressAllowAndStop() throws {
        var app = launch(tab: "apps", ["-smoke-legacy-egress"])
        openApp(app, named: "Plants")
        let allow = app.buttons["service-detail-egress-allow"]
        XCTAssertTrue(reveal(app, allow), "Plants' declared host waits for approval.")
        allow.tap()
        expectProbe(app, "signed app-egress by admin-root")
        let stop = app.buttons["service-detail-egress-stop"]
        XCTAssertTrue(reveal(app, stop), "An allowed host can be stopped.")
        stop.tap()
        XCTAssertTrue(app.staticTexts["Stop this app's internet access?"].waitForExistence(timeout: 10))
        cancelDialog(app)
        XCTAssertTrue(reveal(app, stop))
        stop.tap()
        dialogButton(app, "Stop access").tap()
        let signed = NSPredicate { _, _ in self.probe(app).components(separatedBy: "signed app-egress").count == 3 }
        expectation(for: signed, evaluatedWith: nil)
        waitForExpectations(timeout: 15)
        waitGone(stop)
        shot(app, "egress-stopped")

        app = launch(tab: "apps", admin: false, ["-smoke-legacy-egress"])
        openApp(app, named: "Wiki")
        XCTAssertTrue(reveal(app, app.buttons["service-detail-open-access"]))
        XCTAssertFalse(app.buttons["service-detail-egress-stop"].exists, "A non-admin device can't stop access.")
        expectNoProbe(app, "app-egress")
    }

    // MARK: API keys

    /// Create with each scope (Read & write shown in the sheet, Cancel and
    /// Done), Copy, then revoke with its confirm (Cancel first).
    func test_apiKeyScopeCopyDoneAndRevoke() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let create = app.buttons["service-detail-api-keys-create"]
        XCTAssertTrue(reveal(app, create))
        let rows = app.otherElements.matching(identifier: "service-detail-api-key-row")
        XCTAssertEqual(rows.count, 2)

        create.tap()
        let close = app.buttons["api-key-create-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertEqual(close.label, "Cancel")
        close.tap()
        waitGone(close)
        expectNoProbe(app, "app-api-key")

        create.tap()
        let label = app.textFields["api-key-label"]
        XCTAssertTrue(label.waitForExistence(timeout: 10))
        label.tap()
        label.typeText("Gym writer")
        let scope = app.segmentedControls["api-key-scope"]
        scope.buttons["Read & write"].tap()
        XCTAssertTrue(text(app, containing: "Can read and change anything").exists, "The scope line follows the pick.")
        scope.buttons["Read"].tap()
        XCTAssertTrue(text(app, containing: "Can only read").exists)
        scope.buttons["Read & write"].tap()
        app.buttons["api-key-create-submit"].tap()
        expectProbe(app, "signed app-api-key by admin-root")
        let copy = app.buttons["api-key-copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 10))
        copy.tap()
        wait(copy, "label == 'Copied'")
        XCTAssertEqual(close.label, "Done")
        close.tap()
        waitGone(copy)
        XCTAssertTrue(reveal(app, create))
        let writer = app.staticTexts["Gym writer"]
        XCTAssertTrue(writer.waitForExistence(timeout: 10), "The new key is listed.")
        shot(app, "api-key-listed")

        let revoke = app.buttons["service-detail-api-key-revoke"].firstMatch
        XCTAssertTrue(reveal(app, revoke))
        let before = app.buttons.matching(identifier: "service-detail-api-key-revoke").count
        revoke.tap()
        XCTAssertTrue(text(app, containing: "loses access to the app right away").waitForExistence(timeout: 10))
        cancelDialog(app)
        expectNoProbe(app, "revoked api key")
        XCTAssertTrue(reveal(app, revoke))
        revoke.tap()
        dialogButton(app, "Revoke key").tap()
        expectProbe(app, "revoked api key")
        let fewer = NSPredicate { _, _ in app.buttons.matching(identifier: "service-detail-api-key-revoke").count == before - 1 }
        expectation(for: fewer, evaluatedWith: nil)
        waitForExpectations(timeout: 10)
    }

    // MARK: Database

    /// Paging, Export CSV up to the share sheet, a read query, and a write
    /// that asks to confirm (Cancel, then Confirm and run signs it).
    func test_databasePagingExportAndSql() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let open = app.buttons["service-detail-open-database"]
        XCTAssertTrue(reveal(app, open))
        open.tap()
        let table = app.buttons["database-table-plants"]
        XCTAssertTrue(table.waitForExistence(timeout: 15))
        table.tap()
        let page = app.staticTexts["database-page-label"]
        XCTAssertTrue(page.waitForExistence(timeout: 15))
        XCTAssertEqual(page.label, "Rows 1–100 of 240")
        let next = app.buttons["database-page-next"]
        XCTAssertTrue(reveal(app, next))
        next.tap()
        wait(page, "label == 'Rows 101–200 of 240'")
        let prev = app.buttons["database-page-previous"]
        XCTAssertTrue(reveal(app, prev))
        prev.tap()
        wait(page, "label == 'Rows 1–100 of 240'")
        app.buttons["database-export-csv"].tap()
        expectProbe(app, "exported csv plants")
        let shareSheet = app.otherElements["ActivityListView"]
        let close = app.buttons["Close"]
        XCTAssertTrue(shareSheet.waitForExistence(timeout: 15) || close.waitForExistence(timeout: 5),
                      "Export opens the share sheet with the CSV.")
        if close.exists { close.tap() } else { app.swipeDown(velocity: .fast) }
        shot(app, "database-paged")

        app.navBackButton(in: "plants").tap()
        let runSql = app.buttons["database-run-sql"]
        XCTAssertTrue(runSql.waitForExistence(timeout: 10))
        runSql.tap()
        let editor = app.textViews["database-sql-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        editor.typeText("SELECT * FROM plants")
        app.buttons["database-run"].tap()
        let summary = app.staticTexts["database-query-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 15))
        XCTAssertEqual(summary.label, "SELECT · 240 rows")

        app.navBackButton(in: "Run SQL").tap()
        XCTAssertTrue(runSql.waitForExistence(timeout: 10))
        runSql.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        editor.typeText("UPDATE plants SET thirsty = false")
        app.buttons["database-run"].tap()
        let confirmWrite = app.staticTexts["database-confirm-write"]
        XCTAssertTrue(confirmWrite.waitForExistence(timeout: 15), "A write asks to confirm.")
        app.buttons["Cancel"].tap()
        waitGone(confirmWrite)
        expectNoProbe(app, "app-db-write")
        app.buttons["database-run"].tap()
        XCTAssertTrue(confirmWrite.waitForExistence(timeout: 15))
        app.buttons["database-confirm-run"].tap()
        expectProbe(app, "signed app-db-write by admin-root")
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        wait(summary, "label == 'UPDATE · 1 row'")
    }

    /// A non-admin device reads the data but a write says only an admin
    /// device can change it, and nothing is signed.
    func test_databaseWriteOnNonAdminDevice() throws {
        let app = launch(tab: "apps", admin: false)
        openApp(app, named: "Plants")
        let open = app.buttons["service-detail-open-database"]
        XCTAssertTrue(reveal(app, open))
        open.tap()
        let runSql = app.buttons["database-run-sql"]
        XCTAssertTrue(runSql.waitForExistence(timeout: 15))
        runSql.tap()
        let editor = app.textViews["database-sql-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        editor.typeText("DELETE FROM waterings")
        app.buttons["database-run"].tap()
        let err = app.staticTexts["database-query-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        XCTAssertEqual(err.label, "Only an admin device can change this app's data.")
        XCTAssertFalse(app.staticTexts["database-confirm-write"].exists)
        expectNoProbe(app, "app-db-write")
    }

    // MARK: Access control

    /// Back to Open to all after Members only, Cancel on the Members only
    /// confirm, and a member's rank changed from its menu: each signed with
    /// the admin root.
    func test_accessControlModeBackAndMemberRank() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture"])
        openPlantsAccess(app)
        let mode = app.segmentedControls["service-access-restrict-toggle"]
        mode.buttons["Members only"].tap()
        XCTAssertTrue(text(app, containing: "will be able to open it").waitForExistence(timeout: 10))
        cancelDialog(app)
        wait(mode.buttons["Open to all"], "isSelected == true")
        expectNoProbe(app, "access-mode")

        mode.buttons["Members only"].tap()
        dialogButton(app, "Members only").tap()
        wait(mode.buttons["Members only"], "isSelected == true", timeout: 15)
        expectProbe(app, "signed access-mode by admin-root")
        mode.buttons["Open to all"].tap()
        wait(mode.buttons["Open to all"], "isSelected == true", timeout: 15)
        let status = app.staticTexts["service-access-mode-status"]
        wait(status, "label BEGINSWITH 'Anyone can open it'")
        XCTAssertEqual(probe(app).components(separatedBy: "signed access-mode by admin-root").count - 1, 2)

        let rank = app.buttons["service-access-role-jordan-bright-maple--plants"]
        XCTAssertTrue(reveal(app, rank))
        XCTAssertTrue(rank.label.contains("Member"), "Got \(rank.label)")
        rank.tap()
        let manager = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Manager")).firstMatch
        XCTAssertTrue(manager.waitForExistence(timeout: 10), "The rank menu lists the ranks.")
        manager.tap()
        expectProbe(app, "signed app-rank by admin-root")
        wait(rank, "label CONTAINS 'Manager'")
        shot(app, "access-rank-changed")
    }

    /// An admin invites a person at Manager (link, Copy link) and a group
    /// with a limit and expiry; both reach the mock .com, the rank is a
    /// signed order; the add card closes.
    func test_accessControlAdminCreatesInvites() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture", "-smoke-invites-listed"])
        openPlantsAccess(app)
        let addPerson = app.buttons["service-access-add-person"]
        XCTAssertTrue(reveal(app, addPerson))
        addPerson.tap()
        typeInto(app, app.textFields["service-access-name-field"], "Robin")
        let role = app.buttons["service-access-new-role"]
        XCTAssertTrue(reveal(app, role))
        role.tap()
        let manager = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Manager")).firstMatch
        XCTAssertTrue(manager.waitForExistence(timeout: 10))
        manager.tap()
        wait(role, "label CONTAINS 'Manager'")
        let approve = app.switches["service-access-approve-toggle"]
        XCTAssertTrue(reveal(app, approve))
        let create = app.buttons["service-access-create-invite"]
        XCTAssertTrue(reveal(app, create))
        create.tap()
        expectProbe(app, "created invite for bright-maple--plants")
        expectProbe(app, "signed app-rank by admin-root")
        let url = app.staticTexts["service-access-share-url"]
        XCTAssertTrue(url.waitForExistence(timeout: 15), "The new link shows to share.")
        XCTAssertTrue(url.label.contains("/invite"), "Got \(url.label)")
        let copy = app.buttons["service-access-share-copy-btn"]
        XCTAssertTrue(reveal(app, copy))
        copy.tap()
        XCTAssertTrue(text(app, containing: "Link copied.").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["service-access-share-share-sheet"].exists)
        shot(app, "access-invite-person")
        let closeCard = app.buttons["Close"].firstMatch
        XCTAssertTrue(revealUp(app, closeCard))
        closeCard.tap()
        waitGone(app.textFields["service-access-name-field"])

        let addGroup = app.buttons["service-access-add-group"]
        XCTAssertTrue(reveal(app, addGroup))
        addGroup.tap()
        typeInto(app, app.textFields["service-access-name-field"], "Gardeners")
        let max = app.textFields["service-access-group-max"]
        XCTAssertTrue(reveal(app, max))
        max.tap()
        max.typeText("5")
        let expires = app.switches["service-access-group-expires"]
        XCTAssertTrue(reveal(app, expires))
        XCTAssertEqual(expires.value as? String, "1")
        expires.tap()
        wait(expires, "value == '0'")
        XCTAssertTrue(reveal(app, create))
        create.tap()
        expectProbe(app, "created invite for bright-maple--plants (group)")
        XCTAssertTrue(url.waitForExistence(timeout: 15))
    }

    /// A non-admin device invites at Member only (the rank is read-only and
    /// says why) and withdraws its own invite after confirming; no rank order
    /// is signed.
    func test_accessControlNonAdminInvitesAtMemberAndWithdraws() throws {
        let app = launch(tab: "apps", admin: false, ["-smoke-access-fixture", "-smoke-non-admin-device"])
        openPlantsAccess(app)
        let addPerson = app.buttons["service-access-add-person"]
        XCTAssertTrue(reveal(app, addPerson))
        addPerson.tap()
        typeInto(app, app.textFields["service-access-name-field"], "Kim")
        let reason = app.staticTexts["service-access-member-only-reason"]
        XCTAssertTrue(reveal(app, reason))
        XCTAssertFalse(app.buttons["service-access-new-role"].exists, "The rank is not a menu here.")
        let create = app.buttons["service-access-create-invite"]
        XCTAssertTrue(reveal(app, create))
        create.tap()
        expectProbe(app, "created invite for bright-maple--plants")
        XCTAssertTrue(app.staticTexts["service-access-share-url"].waitForExistence(timeout: 15))
        expectNoProbe(app, "app-rank")

        let remove = app.buttons["service-access-remove-sam-bright-maple--plants"]
        XCTAssertTrue(reveal(app, remove), "This device withdraws the invite it made.")
        remove.tap()
        XCTAssertTrue(text(app, containing: "They lose their rank").waitForExistence(timeout: 10))
        cancelDialog(app)
        expectNoProbe(app, "revoked invite")
        XCTAssertTrue(reveal(app, remove))
        remove.tap()
        dialogButton(app, "Remove").tap()
        expectProbe(app, "revoked invite sam-bright-maple--plants")
        expectProbe(app, "withdrew invite sam-bright-maple--plants on the box")
        shot(app, "access-withdrawn")
    }

    /// An admin revokes someone another device invited (from the Invited by
    /// line), after Cancel on a group's Revoke.
    func test_accessControlAdminRevokesAnInvite() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture"])
        openPlantsAccess(app)
        let family = app.buttons["service-access-revoke-family-bright-maple--plants"]
        XCTAssertTrue(reveal(app, family))
        family.tap()
        XCTAssertTrue(app.staticTexts["Revoke Family?"].waitForExistence(timeout: 10))
        cancelDialog(app)
        expectNoProbe(app, "revoked invite")
        let priya = app.buttons["service-access-revoke-priya-bright-maple--plants"]
        XCTAssertTrue(reveal(app, priya))
        priya.tap()
        XCTAssertTrue(app.staticTexts["Remove Priya?"].waitForExistence(timeout: 10))
        dialogButton(app, "Remove").tap()
        expectProbe(app, "revoked invite priya-bright-maple--plants")
        expectProbe(app, "withdrew invite priya-bright-maple--plants on the box")
    }

    // MARK: Runs on

    /// Untick a server (Cancel, then Remove signs the uninstall there); the
    /// last copy can't be unticked; tick copies the app to a server without it.
    func test_runsOnUntickRefuseAndTick() throws {
        var app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let office = app.buttons["runs-on-office.bright-maple.flagship.services"]
        XCTAssertTrue(reveal(app, office))
        XCTAssertEqual(office.label, "Runs on Office")
        office.tap()
        XCTAssertTrue(dialogButton(app, "Remove from Office").exists)
        cancelDialog(app)
        expectNoProbe(app, "uninstall")
        office.tap()
        dialogButton(app, "Remove from Office").tap()
        expectProbe(app, "signed uninstall by admin-root")
        wait(office, "label == 'Not on Office'")
        shot(app, "runs-on-unticked")

        app = launch(tab: "apps", ["-smoke-office-lacks-plants"])
        openApp(app, named: "Plants")
        let officeRow = app.buttons["runs-on-office.bright-maple.flagship.services"]
        XCTAssertTrue(reveal(app, officeRow))
        wait(officeRow, "label == 'Not on Office'")
        let home = app.buttons["runs-on-home.bright-maple.flagship.services"]
        home.tap()
        XCTAssertTrue(app.alerts["Can't remove the last copy"].waitForExistence(timeout: 10),
                      "The only copy can't be unticked.")
        app.alerts.buttons["OK"].tap()
        expectNoProbe(app, "uninstall")
        officeRow.tap()
        expectProbe(app, "signed app-copy by admin-root")
        XCTAssertTrue(text(app, containing: "Copying").waitForExistence(timeout: 15)
                      || text(app, containing: "copying").waitForExistence(timeout: 2),
                      "The ticked server shows the copy underway.")
    }

    // MARK: Environment

    /// The page menu → Configure environment: add a variable (Cancel first),
    /// then remove it; both reach the box.
    func test_environmentAddAndRemove() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let more = app.navigationBars["Plants"].buttons.element(boundBy: app.navigationBars["Plants"].buttons.count - 1)
        more.tap()
        let item = app.buttons["service-detail-env-menu-item"]
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        item.tap()
        XCTAssertTrue(app.navigationBars["Configure environment"].waitForExistence(timeout: 15))
        let add = app.buttons["service-env-add-btn"]
        add.tap()
        let name = app.textFields["service-env-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        app.buttons["Cancel"].tap()
        waitGone(name)
        add.tap()
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        let save = app.buttons["service-env-save-btn"]
        XCTAssertFalse(save.isEnabled, "Save waits for a name and a value.")
        name.tap()
        name.typeText("GYM_KEY")
        let value = app.secureTextFields["service-env-value-field"]
        value.tap()
        value.typeText("s3cret")
        save.tap()
        expectProbe(app, "set env GYM_KEY on bright-maple--plants")
        let row = app.staticTexts["service-env-row-GYM_KEY"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        shot(app, "env-added")
        app.buttons["Remove GYM_KEY"].tap()
        expectProbe(app, "unset env GYM_KEY on bright-maple--plants")
        waitGone(row)
    }

    // MARK: Address, backup, report, browser, edit

    /// Replace the address stem: Cancel, an invalid stem keeps Replace off,
    /// a valid one renames it on .com.
    func test_replaceAddressStem() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let replace = app.buttons["app-replace-stem-btn"]
        XCTAssertTrue(reveal(app, replace))
        replace.tap()
        let field = app.textFields["replace-stem-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        app.buttons["Cancel"].tap()
        waitGone(field)
        replace.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != "mynotes" {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText("-bad-")
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Replace' AND identifier != 'app-replace-stem-btn'")).firstMatch
        XCTAssertFalse(confirm.isEnabled, "An invalid stem can't be used.")
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        field.typeText("greenhouse")
        wait(confirm, "isEnabled == true")
        confirm.tap()
        expectProbe(app, "renamed bright-maple--plants to greenhouse")
        waitGone(field, timeout: 15)
    }

    /// Back up now with the data and a password: the box packs it and the
    /// page offers Save backup (the share sheet).
    func test_backUpNowWithDataAndPassword() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        let now = app.buttons["service-detail-backup-now"]
        XCTAssertTrue(reveal(app, now))
        let data = app.switches["service-detail-backup-data"]
        XCTAssertTrue(reveal(app, data))
        if (data.value as? String) != "1" { data.tap() }
        wait(data, "value == '1'")
        let password = app.secureTextFields["Password to encrypt it (optional)"]
        XCTAssertTrue(reveal(app, password))
        password.tap()
        password.typeText("hunter22")
        XCTAssertTrue(reveal(app, now))
        now.tap()
        expectProbe(app, "backup bright-maple--plants data=true encrypted=true")
        let save = app.buttons["service-detail-backup-save"]
        XCTAssertTrue(reveal(app, save), "A finished backup offers Save backup.")
        XCTAssertTrue(text(app, containing: "Ready:").exists, "The page says the backup is ready.")
        save.tap()
        let close = app.buttons["Close"]
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 15) || close.waitForExistence(timeout: 5),
                      "Save backup opens the share sheet.")
        shot(app, "backup-share")
    }

    /// An adapted app's Report a problem: Send waits for text, then reaches
    /// the store and thanks; the browser row opens the tabs and a tab's
    /// viewer with its keyboard.
    func test_adapterReportAndBrowserViewer() throws {
        let app = launch(tab: "apps", ["-smoke-app-extras"])
        openApp(app, named: "Plants")
        let report = app.buttons["service-detail-report-adapter"]
        XCTAssertTrue(reveal(app, report))
        report.tap()
        let send = app.buttons["adapter-report-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertFalse(send.isEnabled)
        let textView = app.textViews["adapter-report-text"]
        textView.tap()
        textView.typeText("The page is blank after login.")
        send.tap()
        expectProbe(app, "reported adapter for bright-maple--plants")
        XCTAssertTrue(app.staticTexts["Sent. Thank you."].waitForExistence(timeout: 10)
                      || text(app, containing: "Sent. Thank you").waitForExistence(timeout: 2))
        app.buttons["Done"].tap()
        waitGone(send)

        let browser = app.buttons["service-detail-open-browser-viewer"]
        XCTAssertTrue(reveal(app, browser))
        browser.tap()
        XCTAssertTrue(app.navigationBars["Tabs"].waitForExistence(timeout: 15))
        let tab = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tab t1")).firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "The running tab is listed.")
        tab.tap()
        XCTAssertTrue(app.navigationBars["Browser"].waitForExistence(timeout: 15))
        let keyboard = app.buttons["browser-viewer-toggle-keyboard"]
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10))
        keyboard.tap()
        XCTAssertTrue(app.textFields["browser-viewer-key-input"].waitForExistence(timeout: 10),
                      "The keyboard toggle shows the key input.")
        shot(app, "browser-viewer")
    }

    /// Edit this service: Use your IDE opens the IDE connection; Describe the
    /// change goes through the AI-key step and starts an edit session.
    func test_editServiceWithIdeAndWithAi() throws {
        let app = launch(tab: "apps", ["-smoke-app-extras"])
        openApp(app, named: "Plants")
        let edit = app.buttons["service-detail-edit"]
        XCTAssertTrue(reveal(app, edit))
        edit.tap()
        XCTAssertTrue(app.navigationBars["Edit plants"].waitForExistence(timeout: 10))
        app.buttons["edit-service-ide"].tap()
        XCTAssertTrue(app.buttons["build-mcp-create"].waitForExistence(timeout: 15), "IDE opens the MCP connection.")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let ai = app.buttons["edit-service-ai"]
        XCTAssertTrue(ai.waitForExistence(timeout: 10))
        ai.tap()
        passAiKeyStep(app)
        let prompt = app.textViews["edit-describe-prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 15))
        let start = app.buttons["edit-describe-start"]
        XCTAssertFalse(start.isEnabled)
        prompt.tap()
        prompt.typeText("Add a due date to each plant")
        start.tap()
        expectProbe(app, "started edit of bright-maple--plants")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "session vc-")).firstMatch
            .waitForExistence(timeout: 15), "Start opens the edit's build chat.")
    }

    /// The box refuses an edit: an open session offers Build sessions; a
    /// too-big app offers the IDE.
    func test_editRefusalsOfferTheWayOut() throws {
        var app = launch(tab: "apps", ["-smoke-app-extras", "-smoke-edit-refusal", "session"])
        startEdit(app)
        XCTAssertTrue(app.alerts["Already being changed"].waitForExistence(timeout: 15))
        app.alerts.buttons["Open build sessions"].tap()
        XCTAssertTrue(app.navigationBars["Build sessions"].waitForExistence(timeout: 15))

        app = launch(tab: "apps", ["-smoke-app-extras", "-smoke-edit-refusal", "toobig"])
        startEdit(app)
        XCTAssertTrue(app.alerts["Too big for the AI chat"].waitForExistence(timeout: 15))
        app.alerts.buttons["Use your IDE"].tap()
        XCTAssertTrue(app.buttons["build-mcp-create"].waitForExistence(timeout: 15))
    }

    /// An owner with no key of their own goes straight on to Describe on
    /// Flagship Inference; one with a saved key is asked first.
    private func passAiKeyStep(_ app: XCUIApplication) {
        let useFree = app.buttons["build-key-use-free-ai"]
        let prompt = app.textViews["edit-describe-prompt"]
        if useFree.waitForExistence(timeout: 4), !prompt.exists { useFree.tap() }
    }

    private func startEdit(_ app: XCUIApplication) {
        openApp(app, named: "Plants")
        let edit = app.buttons["service-detail-edit"]
        XCTAssertTrue(reveal(app, edit))
        edit.tap()
        app.buttons["edit-service-ai"].tap()
        passAiKeyStep(app)
        let prompt = app.textViews["edit-describe-prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 15))
        prompt.tap()
        prompt.typeText("Rename the title")
        app.buttons["edit-describe-start"].tap()
    }
}
