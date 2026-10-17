import XCTest

/// GYM iOS button sweep (mock tier), Share a server: see GymSweepSupport.
///
/// `-smoke-shares -smoke-share-flows` runs the share screens' real flows over
/// the gym's share transport (GymShareTransport): the owner's grant, revoke,
/// offer and start-up copy must verify under the admin root, the second
/// account's sign-in, update, start-up push and leave under that share's
/// member key. Owner fixtures: Sam active (Can manage, approves start-ups,
/// no start-up copy yet), Alex accepted and waiting for the owner. Second
/// account: Garage (Can manage), Photos (Can view), an invitation to Cabin.
final class GymSweepShareTests: GymSweepCase {

    private let alex = String(repeating: "a1", count: 16)
    private let sam = String(repeating: "b2", count: 16)
    private let garage = String(repeating: "d4", count: 16)
    private let photos = String(repeating: "f6", count: 16)
    private let shareLink = "https://flagshipserver.com/share#s=\(String(repeating: "ab", count: 16))&k=\(String(repeating: "5e", count: 32))"

    private func launchShares(admin: Bool = true, _ extra: [String] = []) -> XCUIApplication {
        launch(tab: "home", admin: admin, ["-smoke-shares", "-smoke-share-flows"] + extra)
    }

    /// How many times the mocks noted `line`.
    private func probeCount(_ app: XCUIApplication, _ line: String) -> Int {
        probe(app).components(separatedBy: line).count - 1
    }

    private func waitProbeCount(_ app: XCUIApplication, _ line: String, atLeast n: Int,
                                file: StaticString = #filePath, callLine: UInt = #line) {
        let el = any(app, "gym-probe")
        let exp = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.probeCount(app, line) >= n }, object: el)
        XCTAssertEqual(XCTWaiter().wait(for: [exp], timeout: 15), .completed,
                       "Expected \(n)× \"\(line)\"; the mocks saw: \(probe(app))", file: file, line: callLine)
    }

    /// The text field an FSField with this identifier draws (the identifier
    /// lands on the field itself or on its container).
    /// The text field of the form `el` names: FSField puts the identifier on
    /// its label, so fall back to the screen's only text field.
    private func textField(in el: XCUIElement, _ app: XCUIApplication) -> XCUIElement {
        if el.elementType == .textField { return el }
        let inside = el.textFields.firstMatch
        return inside.exists ? inside : app.textFields.firstMatch
    }

    /// Flip a SwiftUI Toggle by tapping its switch (the label side doesn't toggle).
    private func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    /// Home → the Home server's page → its "Shared with" card.
    private func openOwnerCard(_ app: XCUIApplication) {
        openServerPage(app, named: "Home")
        XCTAssertTrue(reveal(app, any(app, "share-server-card")), "The owner's server page has the Shared with card.")
        XCTAssertTrue(any(app, "share-row-\(sam)").waitForExistence(timeout: 15), "The box lists Sam's share.")
    }

    /// Home → Shared with me → that server's page.
    private func openShared(_ app: XCUIApplication, _ shareId: String, title: String) {
        let row = app.buttons["home-shared-\(shareId)"]
        XCTAssertTrue(reveal(app, row), "Home lists the server under Shared with me.")
        row.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 15), "\(title)'s shared page opens.")
    }

    // ─── Owner ──────────────────────────────────────────────────────────────

    /// The card lists the box's shares first; "Show invitations" reads the
    /// waiting ones from `.com` (signed by the account key) and shows Alex's
    /// code; Confirm signs the grant with the admin root and Alex becomes an
    /// active co-manager. Sam's missing start-up copy is set up the same way.
    func test_ownerReadsInvitationsAndConfirmsTheCode() throws {
        let app = launchShares()
        openOwnerCard(app)
        XCTAssertFalse(any(app, "share-sas-\(alex)").exists, "Invitations wait until the owner asks for them.")
        let show = app.buttons["share-show-invitations"]
        XCTAssertTrue(reveal(app, show))
        show.tap()
        expectProbe(app, "signed share-list by irk")
        let sas = any(app, "share-sas-\(alex)")
        XCTAssertTrue(reveal(app, sas), "Alex accepted: the owner compares the code.")
        XCTAssertNotNil(sas.label.range(of: #"^\d{3} \d{3}$"#, options: .regularExpression), "Got: \(sas.label)")
        shot(app, "share-owner-code")

        let setup = app.buttons["share-startup-setup-\(sam)"]
        XCTAssertTrue(reveal(app, setup), "Sam approves start-ups but has no start-up copy yet.")
        setup.tap()
        expectProbe(app, "signed share-unlock by admin-root")
        waitGone(setup, timeout: 15)

        let confirm = app.buttons["share-confirm-\(alex)"]
        XCTAssertTrue(reveal(app, confirm))
        confirm.tap()
        expectProbe(app, "signed share-grant by admin-root")
        waitGone(any(app, "share-sas-\(alex)"), timeout: 15)
        XCTAssertTrue(reveal(app, app.segmentedControls["share-level-\(alex)"]), "Alex is now an active co-manager.")
        shot(app, "share-owner-confirmed")
    }

    /// Sam's level, start-up approval and app data each sign a new grant
    /// (and the start-up copy follows the opt-in); Remove asks first, Cancel
    /// does nothing, Remove revokes on the box and on `.com`.
    func test_ownerChangesAccessAndRemoves() throws {
        let app = launchShares()
        openOwnerCard(app)
        let level = app.segmentedControls["share-level-\(sam)"]
        XCTAssertTrue(reveal(app, level))
        XCTAssertTrue(level.buttons["Can manage"].isSelected)
        level.buttons["Can view"].tap()
        expectProbe(app, "signed share-grant by admin-root")
        wait(level.buttons["Can view"], "isSelected == true")

        let unlock = app.switches["share-unlock-\(sam)"]
        XCTAssertTrue(reveal(app, unlock))
        XCTAssertEqual(unlock.value as? String, "1")
        flip(unlock)
        expectProbe(app, "signed share-unlock by admin-root")
        wait(unlock, "value == '0'", timeout: 15)
        flip(unlock)
        waitProbeCount(app, "signed share-unlock by admin-root", atLeast: 2)
        wait(unlock, "value == '1'", timeout: 15)

        let data = app.switches["share-data-\(sam)"]
        XCTAssertTrue(reveal(app, data))
        XCTAssertEqual(data.value as? String, "0")
        flip(data)
        waitProbeCount(app, "signed share-grant by admin-root", atLeast: 4)
        wait(data, "value == '1'", timeout: 15)
        shot(app, "share-owner-changed")

        let remove = app.buttons["share-remove-\(sam)"]
        XCTAssertTrue(reveal(app, remove))
        remove.tap()
        XCTAssertTrue(app.staticTexts["Sam loses access to this server at once."].waitForExistence(timeout: 10))
        cancelDialog(app)
        XCTAssertTrue(any(app, "share-row-\(sam)").exists, "Cancel keeps Sam.")
        expectNoProbe(app, "share-revoke")
        remove.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Remove'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        waitProbeCount(app, "signed share-revoke by admin-root", atLeast: 2)
        waitGone(any(app, "share-row-\(sam)"), timeout: 15)
    }

    /// Share this server: Cancel leaves without an offer; then a named link
    /// at Can manage with both opt-ins is signed by the admin root, shown as
    /// a link and QR, copied; the card lists the invitation, whose Cancel
    /// withdraws it.
    func test_ownerCreatesALinkAndCancelsIt() throws {
        let app = launchShares()
        openOwnerCard(app)
        let open = app.buttons["share-server-open"]
        XCTAssertTrue(reveal(app, open))
        open.tap()
        let label = any(app, "share-label")
        XCTAssertTrue(label.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["share-create"].isEnabled, "A share needs a name.")
        app.navigationBars["Share this server"].buttons["Cancel"].tap()
        waitGone(label)
        expectNoProbe(app, "share-offer")

        open.tap()
        XCTAssertTrue(label.waitForExistence(timeout: 10))
        let field = textField(in: label, app)
        field.tap()
        field.typeText("Kim")
        dismissKeyboard(app)
        app.buttons["share-level-manage"].tap()
        flip(app.switches["share-draft-unlock"])
        flip(app.switches["share-draft-data"])
        wait(app.switches["share-draft-unlock"], "value == '1'")
        wait(app.switches["share-draft-data"], "value == '1'")
        let create = app.buttons["share-create"]
        XCTAssertTrue(reveal(app, create))
        create.tap()
        let link = any(app, "share-link")
        XCTAssertTrue(link.waitForExistence(timeout: 15), "Create shows the link.")
        XCTAssertTrue(link.label.contains("/share#s="), "Got: \(link.label)")
        XCTAssertTrue(any(app, "share-qr").exists, "…and its QR code.")
        XCTAssertTrue(any(app, "share-sheet").exists, "…and the system share button.")
        expectProbe(app, "signed share-offer by admin-root")
        app.buttons["share-copy-link"].tap()
        shot(app, "share-link")
        app.navigationBars["Share this server"].buttons["Done"].tap()
        waitGone(link)

        let waiting = app.staticTexts["Waiting for Kim to open the link"]
        XCTAssertTrue(reveal(app, waiting), "The card lists the open invitation.")
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'share-row-'"))
            .containing(NSPredicate(format: "label == 'Waiting for Kim to open the link'")).firstMatch
        let cancel = row.exists ? row.buttons["Cancel"] : app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.exists)
        cancel.tap()
        expectProbe(app, "signed share-revoke by admin-root")
        waitGone(waiting, timeout: 15)
    }

    /// A device without the admin root sees who has access, read-only: no
    /// Share this server, no Confirm, no level, opt-ins or Remove, and the
    /// sentence that says why. Reading the invitations (account key) works.
    func test_nonAdminDeviceSeesSharesReadOnly() throws {
        let app = launchShares(admin: false)
        openOwnerCard(app)
        let note = app.staticTexts["share-admin-only"]
        XCTAssertTrue(reveal(app, note))
        XCTAssertEqual(note.label, "Only an admin device can share this server.")
        XCTAssertFalse(app.buttons["share-server-open"].exists)
        XCTAssertFalse(app.segmentedControls["share-level-\(sam)"].exists)
        XCTAssertFalse(app.switches["share-unlock-\(sam)"].exists)
        XCTAssertFalse(app.buttons["share-remove-\(sam)"].exists)
        let show = app.buttons["share-show-invitations"]
        XCTAssertTrue(reveal(app, show))
        show.tap()
        XCTAssertTrue(reveal(app, any(app, "share-sas-\(alex)")), "The code still shows.")
        XCTAssertFalse(app.buttons["share-confirm-\(alex)"].exists, "Only an admin device confirms it.")
        expectNoProbe(app, "refused")
        shot(app, "share-owner-non-admin")
    }

    /// `-smoke-share-route sheet`: the server page opens the share sheet on
    /// its own and creates a link through the real flow.
    func test_sheetRouteCreatesALink() throws {
        let app = launchShares(["-smoke-share-route", "sheet"])
        XCTAssertTrue(any(app, "share-link").waitForExistence(timeout: 25), "The sheet opens on the link step.")
        expectProbe(app, "signed share-offer by admin-root")
    }

    // ─── The second account ─────────────────────────────────────────────────

    /// Add/Import → Co-manage a running server: a bad paste says so, the
    /// scanner opens and cancels, the demo link opens the invitation;
    /// Accept shows the code to read, then (once the owner confirms) the
    /// server under Shared with me.
    func test_coManageAcceptsALink() throws {
        let app = launchShares()
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 15))
        add.tap()
        let coManage = app.buttons.matching(identifier: "home-co-manage").firstMatch
        XCTAssertTrue(coManage.waitForExistence(timeout: 10), "Add/Import offers Co-manage a running server.")
        coManage.tap()
        XCTAssertTrue(app.navigationBars["Shared server"].waitForExistence(timeout: 15))

        let paste = any(app, "share-accept-paste")
        XCTAssertTrue(paste.waitForExistence(timeout: 10))
        let field = textField(in: paste, app)
        field.tap()
        field.typeText("not a link")
        app.buttons["share-accept-open"].tap()
        XCTAssertTrue(text(app, containing: "That isn't a share link.").waitForExistence(timeout: 10))

        app.buttons["share-accept-scan"].tap()
        let scanBar = app.navigationBars["Scan the share code"]
        XCTAssertTrue(scanBar.waitForExistence(timeout: 10), "Scan a code opens the scanner.")
        scanBar.buttons["Cancel"].tap()
        waitGone(scanBar)

        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 14))
        field.typeText(shareLink)
        app.buttons["share-accept-open"].tap()
        XCTAssertTrue(text(app, containing: "shared a server with you").waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Cabin"].exists, "The invitation names the server.")
        shot(app, "share-accept-invitation")

        app.buttons["share-accept"].tap()
        let sas = app.staticTexts["share-accept-sas"]
        XCTAssertTrue(sas.waitForExistence(timeout: 15), "Accept shows the code to read to the owner.")
        XCTAssertNotNil(sas.label.range(of: #"^\d{3} \d{3}$"#, options: .regularExpression), "Got: \(sas.label)")
        shot(app, "share-accept-code")
        let open = app.buttons["share-accept-done-open"]
        XCTAssertTrue(open.waitForExistence(timeout: 20), "Once the owner confirms, the server opens.")
        expectProbe(app, "signed share-session by share")
        open.tap()
        XCTAssertTrue(app.navigationBars["Cabin"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["shared-leave"].waitForExistence(timeout: 10))
    }

    /// Garage (Can manage, approves start-ups): notices on and off sign the
    /// start-up push with the share key; Update asks, then signs the update
    /// order with the share key; Leave asks, Cancel keeps it, Leave signs
    /// the leave and the server drops off Home.
    func test_coManagerNotifyUpdateAndLeave() throws {
        let app = launchShares()
        openShared(app, garage, title: "Garage")
        XCTAssertTrue(app.staticTexts["Can manage"].waitForExistence(timeout: 15))

        let notify = app.switches["shared-startup-notify"]
        XCTAssertTrue(reveal(app, notify), "A co-manager who approves start-ups can be notified.")
        XCTAssertEqual(notify.value as? String, "0")
        flip(notify)
        expectProbe(app, "signed share-push by share")
        wait(notify, "value == '1'", timeout: 15)
        flip(notify)
        waitProbeCount(app, "signed share-push by share", atLeast: 2)
        wait(notify, "value == '0'", timeout: 15)

        let update = app.buttons["shared-update"]
        XCTAssertTrue(revealUp(app, update) || reveal(app, update), "Can manage offers the endorsed release.")
        update.tap()
        let go = app.buttons.matching(NSPredicate(format: "label == 'Update'")).firstMatch
        XCTAssertTrue(go.waitForExistence(timeout: 10), "Update asks first.")
        go.tap()
        expectProbe(app, "signed share-update by share")
        XCTAssertTrue(text(app, containing: "Updating Garage").waitForExistence(timeout: 15))
        shot(app, "shared-update-sent")

        let leave = app.buttons["shared-leave"]
        XCTAssertTrue(reveal(app, leave))
        leave.tap()
        XCTAssertTrue(app.staticTexts["Leave this server?"].waitForExistence(timeout: 10))
        cancelDialog(app)
        XCTAssertTrue(app.navigationBars["Garage"].exists, "Cancel stays on the server.")
        expectNoProbe(app, "share-leave")
        leave.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Leave'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        expectProbe(app, "signed share-leave by share")
        XCTAssertTrue(reveal(app, app.buttons["home-shared-\(photos)"]), "Back on Home, Photos is still shared.")
        XCTAssertFalse(app.buttons["home-shared-\(garage)"].exists, "Garage is gone.")
    }

    /// Photos is shared at Can view: no Update, no start-up notices (it
    /// doesn't approve start-ups), never Delete or Revoke; Leave stays.
    func test_viewLevelHasNoUpdate() throws {
        let app = launchShares()
        openShared(app, photos, title: "Photos")
        XCTAssertTrue(app.staticTexts["Can view"].waitForExistence(timeout: 15))
        XCTAssertTrue(reveal(app, app.buttons["shared-leave"]))
        XCTAssertFalse(app.buttons["shared-update"].exists, "Can view can't update the server.")
        XCTAssertFalse(app.switches["shared-startup-notify"].exists)
        XCTAssertFalse(app.buttons["sd-delete-server"].exists)
        XCTAssertFalse(app.buttons["sd-revoke-server"].exists)
        shot(app, "shared-view-level")
    }

    /// On Garage's apps a members-only app tells a co-manager they can open
    /// it; an app page answers a waiting internet request with the share key
    /// (Can manage) and opens its database (app data shared).
    func test_coManagerOpensAppsAndDatabase() throws {
        let app = launchShares()
        openShared(app, garage, title: "Garage")
        let wiki = app.buttons["shared-app-bright-maple--wiki"]
        XCTAssertTrue(reveal(app, wiki))
        XCTAssertTrue(wiki.label.contains("Members only. As a co-manager you can open it."), "Got: \(wiki.label)")
        wiki.tap()
        let membersOnly = app.staticTexts["shared-app-members-only"]
        XCTAssertTrue(membersOnly.waitForExistence(timeout: 15))
        XCTAssertEqual(membersOnly.label, "Members only. As a co-manager you can open it.")
        app.navBackButton(in: "Wiki").tap()

        let plants = app.buttons["shared-app-bright-maple--plants"]
        XCTAssertTrue(reveal(app, plants))
        plants.tap()
        XCTAssertTrue(app.navigationBars["Plants"].waitForExistence(timeout: 15))
        let allow = app.buttons["service-detail-access-allow"].firstMatch
        XCTAssertTrue(reveal(app, allow), "Can manage answers the app's internet requests.")
        allow.tap()
        expectProbe(app, "signed app-access by share")

        let db = app.buttons["shared-app-database"]
        XCTAssertTrue(reveal(app, db), "App data is shared: the database opens.")
        db.tap()
        let table = app.buttons["database-table-plants"]
        XCTAssertTrue(table.waitForExistence(timeout: 15))
        table.tap()
        XCTAssertTrue(any(app, "database-grid").waitForExistence(timeout: 15))
        shot(app, "shared-app-database")
    }

    /// `-smoke-share-route member`: a start-up waiting for its disk key shows
    /// on the shared server; Not now hides it; Unlock answers it.
    func test_coManagerStartupApproval() throws {
        var app = launch(tab: "home", ["-smoke-shares", "-smoke-share-route", "member"])
        let approve = app.buttons["shared-approve-startup"]
        XCTAssertTrue(approve.waitForExistence(timeout: 20))
        app.buttons["shared-startup-not-now"].tap()
        waitGone(approve, timeout: 5)

        app = launch(tab: "home", ["-smoke-shares", "-smoke-share-route", "member"])
        let again = app.buttons["shared-approve-startup"]
        XCTAssertTrue(again.waitForExistence(timeout: 20))
        again.tap()
        XCTAssertTrue(text(app, containing: "Unlocking. The server will be back").waitForExistence(timeout: 10))
        shot(app, "shared-startup-approved")
    }
}
