import XCTest

/// GYM iOS mock tier — the October 2026 features (docs/ui-test-gym.md §6):
/// app access requests (the app-wide sheet and the service page), access
/// control with ranks, server order + "Make leader", Flagship Inference
/// credits, API keys, the Database browser, where an app runs, the update
/// card, un-revoke, and sharing a server (owner and co-manager).
///
/// NO BACKEND: every test launches `-smoke-mode` (DemoFixtures + the mock
/// clients). The smoke session's account root is a fixed gym seed
/// (GymSeams.accountRootSeed), so signed orders reach the mock clients, which
/// accept any signature. Destructive actions stop at their confirm stage,
/// except the reversible ones the mock applies (access answers, un-revoke).
///
/// `-smoke-username bright-maple` makes the demo pods' FQDNs match the mock
/// box (`<label>.bright-maple.flagship.services`), which the server page's
/// per-server cards (order, runs on, apps) look the pod up by.
final class GymOctoberTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(tab: String, _ extra: [String] = [], username: String = "bright-maple") -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab, "-smoke-username", username] + extra
        app.launch()
        return app
    }

    @discardableResult
    private func reveal(_ app: XCUIApplication, _ el: XCUIElement, tries: Int = 10) -> Bool {
        for _ in 0..<tries where !(el.exists && el.isHittable) { app.swipeUp() }
        return el.waitForExistence(timeout: 5)
    }

    private func podRow(_ app: XCUIApplication, named name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", name, name)).firstMatch
    }

    private func openServerPage(_ app: XCUIApplication, named name: String) {
        let row = podRow(app, named: name)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "The \(name) server row should be on Home.")
        row.tap()
        XCTAssertTrue(app.serverPageBackButton(named: name).waitForExistence(timeout: 15),
                      "Tapping \(name) should open its server page.")
    }

    /// Services → the demo Plants app's page.
    private func openPlants(_ app: XCUIApplication) {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "plants")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "The demo Plants app should be listed.")
        row.tap()
        XCTAssertTrue(app.navigationBars["Plants"].waitForExistence(timeout: 15), "Plants' page should open.")
    }

    private func label(_ el: XCUIElement) -> String { el.label }

    // ─── App access requests: the app-wide sheet ─────────────────────────────

    /// The box has two hosts waiting for Plants. The sheet asks about each in
    /// turn; Allow and Deny sign the edited list and say what happened, and
    /// once both are answered nothing covers Home any more.
    func test_appAccessAlertAllowThenDeny() throws {
        let app = launch(tab: "home", ["-smoke-access-alert", "-smoke-admin-root"])
        let title = app.staticTexts["access-alert-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 20), "A waiting request should open the access sheet.")
        XCTAssertTrue(title.label.hasPrefix("Plants wants to reach "), "Got: \(title.label)")
        let firstHost = String(title.label.dropFirst("Plants wants to reach ".count))
        gymShot(app, "access-alert-ask")

        app.buttons["access-alert-allow"].tap()
        let done = app.staticTexts["access-alert-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15), "Allow should sign the list and confirm.")
        XCTAssertEqual(done.label, "Plants can now reach \(firstHost)")
        gymShot(app, "access-alert-allowed")
        app.buttons["Close"].tap()

        XCTAssertTrue(title.waitForExistence(timeout: 15), "The second waiting host should be asked next.")
        let secondHost = String(title.label.dropFirst("Plants wants to reach ".count))
        XCTAssertNotEqual(secondHost, firstHost)
        app.buttons["access-alert-deny"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 15), "Deny should sign the list and confirm.")
        XCTAssertEqual(done.label, "Plants won't reach \(secondHost)")
        app.buttons["Close"].tap()

        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 10))
        XCTAssertFalse(title.waitForExistence(timeout: 3), "No request is left to ask about.")
        XCTAssertTrue(app.buttons["home-add-server"].isHittable, "Home is usable once every request is answered.")
    }

    /// Without `-smoke-access-alert` the same waiting requests never cover the
    /// app (the gym's default), and "Not now" with it closes the sheet.
    func test_appAccessAlertNotNowCloses() throws {
        let app = launch(tab: "home", ["-smoke-access-alert", "-smoke-admin-root"])
        let title = app.staticTexts["access-alert-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 20))
        app.buttons["access-alert-not-now"].tap()
        // The next waiting host follows; not-now it too.
        if title.waitForExistence(timeout: 5) { app.buttons["access-alert-not-now"].tap() }
        XCTAssertFalse(title.waitForExistence(timeout: 3), "Not now should close the sheet.")
        XCTAssertTrue(app.buttons["home-add-server"].isHittable)
        gymShot(app, "access-alert-closed")
    }

    // ─── App access list on the service page ─────────────────────────────────

    func test_serviceAccessPendingAllowFromServicePage() throws {
        let app = launch(tab: "apps", ["-smoke-admin-root"])
        openPlants(app)
        let allow = app.buttons["service-detail-access-allow"].firstMatch
        XCTAssertTrue(reveal(app, allow), "Plants' Internet access section should list its waiting hosts.")
        let pendingBefore = app.buttons.matching(identifier: "service-detail-access-allow").count
        XCTAssertEqual(pendingBefore, 2, "The mock box has two hosts waiting for Plants.")
        gymShot(app, "service-access-pending")
        allow.tap()
        let answered = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Plants can now reach")).firstMatch
        XCTAssertTrue(answered.waitForExistence(timeout: 15), "Allowing should confirm on the page.")
        let gone = NSPredicate { _, _ in app.buttons.matching(identifier: "service-detail-access-allow").count == 1 }
        expectation(for: gone, evaluatedWith: nil)
        waitForExpectations(timeout: 10)
        gymShot(app, "service-access-allowed")

        let view = app.buttons["service-detail-access-view-list"]
        XCTAssertTrue(reveal(app, view))
        view.tap()
        let editor = app.textViews["access-list-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10), "The list editor should open.")
        let host = String(answered.label.dropFirst("Plants can now reach ".count))
        XCTAssertTrue((editor.value as? String ?? "").contains("allow \(host)"),
                      "The signed list should now allow \(host).")
    }

    // ─── Access control: Open to all / Members only, ranks ───────────────────

    func test_accessControlModeAndRanks() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture"])
        openPlants(app)
        let access = app.buttons["service-detail-open-access"]
        XCTAssertTrue(reveal(app, access), "Plants' page should offer Access control.")
        access.tap()
        XCTAssertTrue(app.navigationBars["Access control"].waitForExistence(timeout: 15))
        let mode = app.segmentedControls["service-access-restrict-toggle"]
        XCTAssertTrue(mode.waitForExistence(timeout: 15))
        XCTAssertTrue(mode.buttons["Open to all"].isSelected, "The fixture app starts open to all.")
        let members = app.staticTexts["service-access-members-title"]
        XCTAssertTrue(members.waitForExistence(timeout: 10))
        XCTAssertTrue(members.label.uppercased().contains("MEMBERS (4)"), "Got: \(members.label)")
        let samRank = app.buttons["service-access-role-sam-bright-maple--plants"]
        XCTAssertTrue(samRank.waitForExistence(timeout: 10), "Each member shows a rank.")
        XCTAssertTrue(samRank.label.contains("Manager"), "Sam is a manager; got \(samRank.label)")
        gymShot(app, "access-control-open")

        mode.buttons["Members only"].tap()
        let confirm = app.sheets.buttons["Members only"].firstMatch
        let confirmAlt = app.buttons.matching(NSPredicate(format: "label == %@", "Members only")).element(boundBy: 1)
        if confirm.waitForExistence(timeout: 5) { confirm.tap() } else {
            XCTAssertTrue(confirmAlt.waitForExistence(timeout: 5), "Switching to Members only asks first.")
            confirmAlt.tap()
        }
        let selected = NSPredicate(format: "isSelected == true")
        expectation(for: selected, evaluatedWith: mode.buttons["Members only"])
        waitForExpectations(timeout: 15)
        let status = app.staticTexts["service-access-mode-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(status.label.hasPrefix("Only members and you can open it"), "Got: \(status.label)")
        gymShot(app, "access-control-members-only")
    }

    // ─── Who can invite: admins rank, any device invites at Member ───────────

    private func openPlantsAccess(_ app: XCUIApplication) {
        openPlants(app)
        let access = app.buttons["service-detail-open-access"]
        XCTAssertTrue(reveal(app, access), "Plants' page should offer Access control.")
        access.tap()
        XCTAssertTrue(app.navigationBars["Access control"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["service-access-members-title"].waitForExistence(timeout: 10))
    }

    func test_accessControlRankLockedOnNonAdminDevice() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture", "-smoke-non-admin-device"])
        openPlantsAccess(app)
        let samRank = app.descendants(matching: .any)["service-access-role-sam-bright-maple--plants"]
        XCTAssertTrue(reveal(app, samRank), "Each member still shows a rank.")
        XCTAssertTrue(samRank.label.contains("Manager"), "Got: \(samRank.label)")
        XCTAssertFalse(app.buttons["service-access-role-sam-bright-maple--plants"].exists,
                       "A non-admin device shows ranks read-only.")
        XCTAssertTrue(app.buttons["service-access-remove-sam-bright-maple--plants"].exists,
                      "This device may withdraw the member invite it made.")
        XCTAssertFalse(app.buttons["service-access-remove-priya-bright-maple--plants"].exists,
                       "It may not withdraw an admin's invite.")
        gymShot(app, "access-control-non-admin-list")

        let add = app.buttons["service-access-add-person"]
        XCTAssertTrue(reveal(app, add), "A Manager device may invite.")
        add.tap()
        let reason = app.staticTexts["service-access-member-only-reason"]
        XCTAssertTrue(reveal(app, reason), "The locked picker says why.")
        XCTAssertEqual(reason.label, "Only an admin device can give a higher rank")
        let newRank = app.descendants(matching: .any)["service-access-new-role"]
        XCTAssertTrue(newRank.exists)
        XCTAssertTrue(newRank.label.contains("Member"), "Got: \(newRank.label)")
        XCTAssertFalse(app.buttons["service-access-new-role"].exists, "The rank can't be picked.")
        gymShot(app, "access-control-rank-locked")
    }

    // ─── Account members: the account's devices and co-managers ─────────────

    private let thisDevice = String(repeating: "d0", count: 16)
    private let ipad = String(repeating: "1a", count: 16)
    private let unnamed = String(repeating: "2b", count: 16)
    private let mumShare = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"

    func test_accessControlAccountMembersAdminRanksAndRefuses() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture"])
        openPlantsAccess(app)
        let title = app.staticTexts["service-access-account-members-title"]
        XCTAssertTrue(reveal(app, title), "Access control lists the account's members.")
        XCTAssertTrue(title.label.uppercased().contains("ACCOUNT MEMBERS (4)"), "Got: \(title.label)")
        XCTAssertEqual(app.staticTexts["service-access-account-name-\(thisDevice)"].label, "Harry's iPhone")
        XCTAssertEqual(app.staticTexts["service-access-account-detail-\(thisDevice)"].label, "Admin device · This device")
        XCTAssertEqual(app.staticTexts["service-access-account-name-\(ipad)"].label, "Harry's iPad",
                       "Device names come from the directory decrypted on the phone.")
        XCTAssertEqual(app.staticTexts["service-access-account-name-\(unnamed)"].label, "Device 2B2B2B")
        XCTAssertEqual(app.staticTexts["service-access-account-name-\(mumShare)"].label, "Mum")
        XCTAssertEqual(app.staticTexts["service-access-account-detail-\(mumShare)"].label, "Co-manages this server")

        let refusedRank = app.buttons["service-access-account-rank-\(unnamed)"]
        XCTAssertTrue(refusedRank.exists, "An admin device gets a rank menu on every row.")
        XCTAssertTrue(refusedRank.label.contains("Refused"), "Got: \(refusedRank.label)")
        let ipadRank = app.buttons["service-access-account-rank-\(ipad)"]
        XCTAssertTrue(ipadRank.label.contains("Master"), "Got: \(ipadRank.label)")
        gymShot(app, "access-control-account-members")

        let mumRank = app.buttons["service-access-account-rank-\(mumShare)"]
        XCTAssertTrue(reveal(app, mumRank))
        XCTAssertTrue(mumRank.label.contains("Manager"), "Got: \(mumRank.label)")
        mumRank.tap()
        func item(_ title: String) -> XCUIElement {
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        }
        let refuse = app.buttons.matching(NSPredicate(
            format: "identifier == %@ OR label BEGINSWITH %@", "service-access-account-refuse-\(mumShare)", "Refuse")).firstMatch
        XCTAssertTrue(refuse.waitForExistence(timeout: 5), "The menu offers Refuse.")
        XCTAssertTrue(item("Member").exists && item("Manager").exists && item("Master").exists,
                      "The menu offers Member, Manager and Master.")
        XCTAssertFalse(item("Owner").exists, "There is no owner rank.")
        refuse.tap()
        let refused = NSPredicate(format: "label CONTAINS %@", "Refused")
        expectation(for: refused, evaluatedWith: app.buttons["service-access-account-rank-\(mumShare)"])
        waitForExpectations(timeout: 15)
        gymShot(app, "access-control-account-refused")
    }

    func test_accessControlAccountMembersReadOnlyOnNonAdminDevice() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture", "-smoke-non-admin-device"])
        openPlantsAccess(app)
        let mine = app.descendants(matching: .any)["service-access-account-rank-\(thisDevice)"]
        XCTAssertTrue(reveal(app, mine))
        XCTAssertTrue(mine.label.contains("Manager"), "A non-admin device is a Manager by default; got \(mine.label)")
        XCTAssertFalse(app.buttons["service-access-account-rank-\(thisDevice)"].exists, "Ranks are read-only here.")
        XCTAssertEqual(app.staticTexts["service-access-account-detail-\(thisDevice)"].label, "Device · This device")
        app.swipeDown(); app.swipeDown()
        let mode = app.segmentedControls["service-access-restrict-toggle"]
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        XCTAssertFalse(mode.isEnabled, "Only an admin device changes who may open it.")
        XCTAssertTrue(app.staticTexts["service-access-mode-admin-only"].exists)
        gymShot(app, "access-control-account-read-only")
    }

    func test_accessControlMemberRankDeviceSaysWhyItCannotInvite() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture", "-smoke-member-rank-device"])
        openPlantsAccess(app)
        let why = app.staticTexts["service-access-invite-why"]
        XCTAssertTrue(reveal(app, why), "A Member device sees why it can't invite.")
        XCTAssertEqual(why.label, "Only an admin can let you invite people to this app.")
        XCTAssertFalse(app.buttons["service-access-add-person"].exists)
        XCTAssertFalse(app.buttons["service-access-add-group"].exists)
        XCTAssertFalse(app.buttons["service-access-remove-sam-bright-maple--plants"].exists,
                       "Below Manager it can't withdraw even its own invite.")
        gymShot(app, "access-control-member-why")
    }

    func test_accessControlMembersShowInvitedBy() throws {
        let app = launch(tab: "apps", ["-smoke-access-fixture"])
        openPlantsAccess(app)
        let expected = [
            "sam": "Invited by this device",
            "priya": "Invited by Harry's iPad",
            "family": "Invited by another device",
        ]
        for (who, line) in expected {
            let by = app.staticTexts["service-access-invited-by-\(who)-bright-maple--plants"]
            XCTAssertTrue(reveal(app, by), "\(who)'s row says who invited them.")
            XCTAssertEqual(by.label, line)
            XCTAssertTrue(app.buttons["service-access-revoke-\(who)-bright-maple--plants"].exists,
                          "An admin device revokes \(who) in one tap.")
        }
        XCTAssertFalse(app.staticTexts["service-access-invited-by-jordan-bright-maple--plants"].exists,
                       "An invite from before attribution shows nothing.")
        gymShot(app, "access-control-invited-by")
    }

    // ─── Server order: Make leader stays gray until the box confirms ─────────

    func test_makeLeaderWaitsForTheServerToConfirm() throws {
        let app = launch(tab: "home")
        openServerPage(app, named: "Office")
        let make = app.buttons["sd-make-leader"]
        XCTAssertTrue(reveal(app, make), "A server that doesn't lead offers Make leader.")
        gymShot(app, "server-order-card")
        make.tap()
        let pending = app.descendants(matching: .any)["sd-leader-pending"]
        XCTAssertTrue(pending.waitForExistence(timeout: 15),
                      "Until the new leader acknowledges, the page says it is waiting to confirm.")
        gymShot(app, "server-order-pending")

        // The "now first in your order" toast sits over the back button for
        // a moment; retry the tap until Home is back.
        let office = podRow(app, named: "Office")
        for _ in 0..<4 where !office.exists {
            app.serverPageBackButton(named: "Office").tap()
            _ = office.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(office.exists, "Back from Office's page should return to Home.")
        let grayBadge = app.descendants(matching: .any)["leader-badge-pending"]
        XCTAssertTrue(
            grayBadge.waitForExistence(timeout: 10) || office.label.contains("waiting for the server to confirm"),
            "Home shows Office as leader in gray until it confirms; got \(office.label)"
        )
        XCTAssertFalse(podRow(app, named: "Home").label.contains("Leader,"),
                       "Home is no longer shown as the leader.")
        gymShot(app, "server-order-home-gray")
    }

    // ─── Flagship Inference ──────────────────────────────────────────────────

    func test_flagshipInferenceCreditsInAiKeys() throws {
        let app = launch(tab: "settings")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "AI keys")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "Settings should list AI keys.")
        row.tap()
        let card = app.otherElements["free-ai-card"]
        XCTAssertTrue(card.waitForExistence(timeout: 15), "Flagship Inference is always listed first.")
        let status = app.staticTexts["free-ai-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        XCTAssertEqual(status.label, "1,840 free credits left · 500 added each week")
        gymShot(app, "flagship-inference-credits")
    }

    // ─── API keys + Database ─────────────────────────────────────────────────

    func test_apiKeyCreateShowsTheSecretOnce() throws {
        let app = launch(tab: "apps", ["-smoke-admin-root"])
        openPlants(app)
        let create = app.buttons["service-detail-api-keys-create"]
        XCTAssertTrue(reveal(app, create), "Plants' page should have an API keys section.")
        XCTAssertEqual(app.otherElements.matching(identifier: "service-detail-api-key-row").count, 2,
                       "The mock lists Plants' two keys.")
        create.tap()
        let labelField = app.textFields["api-key-label"]
        XCTAssertTrue(labelField.waitForExistence(timeout: 10))
        labelField.tap()
        labelField.typeText("Gym sensor")
        app.buttons["api-key-create-submit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["api-key-secret"].waitForExistence(timeout: 15),
                      "A new key shows its secret.")
        XCTAssertTrue(app.descendants(matching: .any)["api-key-shown-once-warning"].exists,
                      "…with the warning that it is shown only once.")
        gymShot(app, "api-key-created")
    }

    func test_databaseBrowsesATable() throws {
        let app = launch(tab: "apps")
        openPlants(app)
        let open = app.buttons["service-detail-open-database"]
        XCTAssertTrue(reveal(app, open), "Plants' page should open its database.")
        open.tap()
        let table = app.buttons["database-table-plants"]
        XCTAssertTrue(table.waitForExistence(timeout: 15), "The database lists its tables.")
        table.tap()
        XCTAssertTrue(app.descendants(matching: .any)["database-grid"].waitForExistence(timeout: 15),
                      "A table opens as a grid.")
        let page = app.staticTexts["database-page-label"]
        XCTAssertTrue(page.waitForExistence(timeout: 5))
        XCTAssertTrue(page.label.contains("240"), "The page line counts the table's rows; got \(page.label)")
        gymShot(app, "database-grid")
    }

    // ─── Where an app runs ───────────────────────────────────────────────────

    func test_runsOnListsServersAndServerPageListsApps() throws {
        var app = launch(tab: "apps")
        openPlants(app)
        let home = app.descendants(matching: .any)["runs-on-home.bright-maple.flagship.services"]
        XCTAssertTrue(reveal(app, home), "Plants' page lists the servers it can run on.")
        XCTAssertTrue(app.descendants(matching: .any)["runs-on-office.bright-maple.flagship.services"].exists)
        gymShot(app, "runs-on")

        app = launch(tab: "home")
        openServerPage(app, named: "Home")
        let plants = app.buttons["server-app-bright-maple--plants"]
        XCTAssertTrue(reveal(app, plants), "A server's page lists the apps on it.")
        XCTAssertTrue(app.buttons["server-create-app-here"].exists, "…and offers Create app here.")
        gymShot(app, "server-apps")
    }

    // ─── Update this server ──────────────────────────────────────────────────

    func test_updateCardOffersTheNewRelease() throws {
        let app = launch(tab: "home")
        openServerPage(app, named: "Home")
        let available = app.descendants(matching: .any)["sd-update-available"]
        XCTAssertTrue(reveal(app, available), "The update card names the newer release.")
        XCTAssertTrue(available.label.contains("v0.0.0-2026-10-11-4b1e0c9d"), "Got: \(available.label)")
        let last = app.staticTexts["sd-update-last-outcome"]
        XCTAssertTrue(last.exists, "The card says how the last update went.")
        XCTAssertTrue(last.label.hasPrefix("Last update: "), "Got: \(last.label)")
        XCTAssertTrue(app.buttons["sd-update-server"].exists)
        gymShot(app, "update-card")
    }

    // ─── Debug access ────────────────────────────────────────────────────────

    /// An admin device turns debug access on with a pasted SSH key for an
    /// hour (with the warning shown), the page shows the banner, then turns
    /// it off and the banner goes.
    func test_debugAccessOnBannerOff() throws {
        let app = launch(tab: "home", ["-smoke-admin-root"])
        openServerPage(app, named: "Home")
        let on = app.buttons["sd-debug-access-on"]
        XCTAssertTrue(reveal(app, on, tries: 16), "An admin device can turn debug access on.")
        on.tap()

        let warning = app.staticTexts["sd-debug-access-warning"]
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        XCTAssertEqual(warning.label, "Anyone with this key can read everything on this server while it's on.")
        let field = app.descendants(matching: .any)["sd-debug-access-key-field"]
        XCTAssertTrue(reveal(app, field))
        field.tap()
        field.typeText("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3 gym@laptop")
        app.buttons["1 hour"].tap()
        gymShot(app, "debug-access-form")
        let submit = app.buttons["sd-debug-access-submit"]
        XCTAssertTrue(reveal(app, submit))
        submit.tap()

        let off = app.buttons["sd-debug-access-off"]
        XCTAssertTrue(off.waitForExistence(timeout: 15), "Once on, it can be turned off.")
        XCTAssertTrue(app.buttons["sd-debug-access-renew"].exists, "Once on, it can be renewed.")
        XCTAssertTrue(app.staticTexts["sd-debug-access-key"].label.hasPrefix("Key SHA256:"))
        let banner = app.descendants(matching: .any)["sd-debug-access-banner"]
        for _ in 0..<12 where !banner.exists { app.swipeDown() }
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "The server page shows the banner while it's on.")
        XCTAssertTrue(banner.label.hasPrefix("Debug access is on until "), "Got: \(banner.label)")
        gymShot(app, "debug-access-on")

        XCTAssertTrue(reveal(app, off, tries: 16))
        off.tap()
        let confirm = app.buttons["sd-debug-access-confirm-off"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(app.buttons["sd-debug-access-on"].waitForExistence(timeout: 15), "Turned off, it offers Turn on again.")
        for _ in 0..<12 { app.swipeDown() }
        XCTAssertFalse(app.descendants(matching: .any)["sd-debug-access-banner"].exists, "The banner goes when it's off.")
        gymShot(app, "debug-access-off")
    }

    /// A device without the admin root sees the state but can't change it.
    func test_debugAccessReadOnlyOnANonAdminDevice() throws {
        let app = launch(tab: "home")
        openServerPage(app, named: "Home")
        let note = app.staticTexts["sd-debug-access-admin-only"]
        XCTAssertTrue(reveal(app, note, tries: 16))
        XCTAssertEqual(note.label, "Only an admin device can turn debug access on or off.")
        XCTAssertFalse(app.buttons["sd-debug-access-on"].exists)
    }

    // ─── Offline server ──────────────────────────────────────────────────────

    /// A server that stopped reporting (Music) doesn't answer: its page says
    /// so honestly instead of "Connecting…", and still offers Revoke.
    func test_offlineServerPageSaysOffline() throws {
        let app = launch(tab: "home")
        openServerPage(app, named: "Music")
        let offline = app.descendants(matching: .any)["server-detail-offline"]
        XCTAssertTrue(offline.waitForExistence(timeout: 20), "An offline server's page says it's offline.")
        XCTAssertFalse(app.staticTexts["Connecting…"].exists)
        XCTAssertTrue(reveal(app, app.buttons["sd-revoke-server"]), "It can still be revoked.")
        gymShot(app, "server-offline")
    }

    // ─── Un-revoke ───────────────────────────────────────────────────────────

    func test_unrevokeRestoresARevokedServer() throws {
        // The default demo user: un-revoke is the one order here the guardrail
        // counts as destructive, so it runs against an allowed demo identity.
        let app = launch(tab: "home", ["-smoke-revoked", "-smoke-admin-root"], username: "smoketest")
        openServerPage(app, named: "Garage")
        XCTAssertTrue(app.descendants(matching: .any)["server-detail-revoked"].waitForExistence(timeout: 15),
                      "A revoked server's page says so.")
        let unrevoke = app.buttons["sd-unrevoke-server"]
        XCTAssertTrue(reveal(app, unrevoke), "…and offers Un-revoke.")
        XCTAssertFalse(app.buttons["sd-revoke-server"].exists, "A revoked server can't be revoked again.")
        gymShot(app, "revoked")
        unrevoke.tap()
        let revokeAgain = app.buttons["sd-revoke-server"]
        XCTAssertTrue(revokeAgain.waitForExistence(timeout: 15), "Once restored the page offers Revoke again.")
        XCTAssertFalse(app.buttons["sd-unrevoke-server"].exists)
        gymShot(app, "unrevoked")
    }

    // ─── Share this server ───────────────────────────────────────────────────

    func test_shareServerOwnerSeesSharesAndConfirmsCode() throws {
        let app = launch(tab: "home", ["-smoke-shares", "-smoke-share-route", "owner"])
        let card = app.descendants(matching: .any)["share-server-card"]
        XCTAssertTrue(reveal(app, card), "The owner's server page has the Shared with card.")
        let alex = String(repeating: "a1", count: 16)
        let sam = String(repeating: "b2", count: 16)
        XCTAssertTrue(app.descendants(matching: .any)["share-sas-\(alex)"].exists, "Alex accepted: compare the code.")
        XCTAssertTrue(app.descendants(matching: .any)["share-sas-\(alex)"].label.contains("482 913"))
        XCTAssertTrue(app.descendants(matching: .any)["share-row-\(sam)"].exists, "Sam's share is active.")
        XCTAssertTrue(app.buttons["share-server-open"].exists, "The owner can share it again.")
        gymShot(app, "share-owner")
        app.buttons["share-server-open"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["share-level-manage"].waitForExistence(timeout: 10),
                      "The share sheet offers Can view / Can manage.")
        XCTAssertTrue(app.buttons["share-create"].exists)
        gymShot(app, "share-sheet")
    }

    func test_sharedServerCoManagerView() throws {
        var app = launch(tab: "home", ["-smoke-shares", "-smoke-share-route", "home"])
        let section = app.descendants(matching: .any)["home-shared-with-me"]
        XCTAssertTrue(reveal(app, section), "Home lists the servers shared with me.")
        XCTAssertTrue(app.descendants(matching: .any)["home-shared-\(String(repeating: "d4", count: 16))"].exists)
        gymShot(app, "shared-with-me")

        app = launch(tab: "home", ["-smoke-shares", "-smoke-share-route", "member"])
        let approve = app.buttons["shared-approve-startup"]
        XCTAssertTrue(approve.waitForExistence(timeout: 20), "A co-manager can approve the shared server's start-up.")
        XCTAssertTrue(reveal(app, app.buttons["shared-leave"]), "…and can leave the share.")
        XCTAssertFalse(app.buttons["sd-delete-server"].exists, "A co-manager can never delete the server.")
        XCTAssertFalse(app.buttons["sd-revoke-server"].exists, "…nor revoke it.")
        gymShot(app, "shared-server-member")
    }

    // ─── Admin-only orders on a non-admin device (MVP sweep) ────────────────

    /// A device without the admin root sees Plants' page read-only: no Allow,
    /// no Create key, no Remove, the "Runs on" boxes locked, each with the
    /// sentence that says why. An admin device gets the controls.
    func test_servicePageAdminOnlyOrdersOnANonAdminDevice() throws {
        var app = launch(tab: "apps")
        openPlants(app)
        let accessNote = app.staticTexts["service-detail-access-read-only"]
        XCTAssertTrue(reveal(app, accessNote), "The access list says why it can't be changed here.")
        XCTAssertEqual(accessNote.label, "Only an admin device can change this app's internet access.")
        XCTAssertFalse(app.buttons["service-detail-access-allow"].exists, "No Allow on a non-admin device.")
        let keysNote = app.staticTexts["service-detail-api-keys-read-only"]
        XCTAssertTrue(reveal(app, keysNote))
        XCTAssertEqual(keysNote.label, "Only an admin device can create or revoke API keys.")
        XCTAssertFalse(app.buttons["service-detail-api-keys-create"].exists)
        let runsOn = app.staticTexts["runs-on-note"]
        XCTAssertTrue(reveal(app, runsOn))
        XCTAssertEqual(runsOn.label, "Only an admin device can change where this app runs.")
        let removeNote = app.staticTexts["service-detail-remove-admin-only"]
        XCTAssertTrue(reveal(app, removeNote))
        XCTAssertEqual(removeNote.label, "Only an admin device can remove an app.")
        XCTAssertFalse(app.buttons["service-detail-remove-btn"].exists)
        gymShot(app, "service-page-non-admin")

        app = launch(tab: "apps", ["-smoke-admin-root"])
        openPlants(app)
        XCTAssertTrue(reveal(app, app.buttons["service-detail-access-allow"].firstMatch), "An admin device answers.")
        XCTAssertTrue(reveal(app, app.buttons["service-detail-api-keys-create"]))
        XCTAssertTrue(reveal(app, app.buttons["service-detail-remove-btn"]))
        XCTAssertEqual(app.buttons["service-detail-remove-btn"].label, "Remove app")
        XCTAssertFalse(app.staticTexts["service-detail-remove-admin-only"].exists)
    }

    /// An AI-needs-you alert names the server it came from; tapping it opens
    /// the build chat bound to that server, not the one the app shows.
    func test_aiNeedsYouOpensTheChatOnItsServer() throws {
        let app = launch(tab: "home", ["-smoke-ops", "-smoke-ops-on-server"])
        let opsBar = app.buttons["global-operations-bar"]
        XCTAssertTrue(opsBar.waitForExistence(timeout: 15) || app.otherElements["global-operations-bar"].exists,
                      "The waiting build shows in the operations sliver.")
        if opsBar.exists { opsBar.tap() } else { app.otherElements["global-operations-bar"].tap() }
        XCTAssertTrue(app.staticTexts["session gym-smoke"].waitForExistence(timeout: 15),
                      "The sliver opens the chat on the server the alert named.")
        gymShot(app, "ai-needs-you-on-server")
    }
}
