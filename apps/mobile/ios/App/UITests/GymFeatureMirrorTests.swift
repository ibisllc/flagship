import XCTest

/// GYM iOS feature-coverage mirrors (Tier-1, NO-BACKEND) — the iOS twins of the
/// webapp's feature tranche (web-total-transfer-offer / -box-inbox /
/// -pod-switcher / -cs-advanced-toggles / -admin-root-state /
/// -rotate-admin-ceremony / -promote-admin-toggle in tools/gym/src/suites/web.ts).
///
/// Same discipline as GymTotalTests / GymTotalDetailTests: every test launches
/// `-smoke-mode` (DemoFixtures + the mock client), the deterministic verdict is
/// the Layer-1 assertion, screenshots are advisory. Destructive/danger controls
/// are asserted at their CONFIRM stage only — a transfer is never created, a
/// rotation is never fired (Cancel), a device is never admitted.
///
/// The Slice-D admin surfaces ride the `-smoke-admin-root` launch arg
/// (GymSeams.forceAdminRoot): a demo session never mints a real admin master
/// root, so without the seed the admin-gated UI is (correctly) absent — which
/// is itself asserted (the non-admin half of the state pair).
///
/// NOT mirrored here: the acquirer take-over claim (web-total-transfer-claim).
/// On mobile that flow is deep-link/QR-only (no in-app entry point) and its
/// verify stage needs a REAL signed offer, which would take a signed-offer
/// fixture seam — disproportionate for a render assert (skipped, see ios.ts).
final class GymFeatureMirrorTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(tab: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab] + extra
        app.launch()
        return app
    }

    /// Match a Home pod ROW by name (label = name + subtitle + pill), excluding
    /// the tab bar's bare-name button. Same helper as GymTotalTests.
    private func podRow(_ app: XCUIApplication, named name: String) -> XCUIElement {
        return app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", name, name))
            .firstMatch
    }

    private func openPodDetail(_ app: XCUIApplication, named name: String) {
        let row = podRow(app, named: name)
        for _ in 0..<3 where !row.exists { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The \(name) pod row should be present.")
        row.tap()
        XCTAssertTrue(
            app.navigationBars["Server"].waitForExistence(timeout: 15),
            "Tapping \(name) should push the server-detail screen."
        )
    }

    @discardableResult
    private func revealBySwipe(_ app: XCUIApplication, _ el: XCUIElement, tries: Int = 8) -> Bool {
        for _ in 0..<tries where !el.exists { app.swipeUp() }
        return el.waitForExistence(timeout: 5)
    }

    // ─── D1 — transfer-a-box giver entry (web-total-transfer-offer twin) ─────

    /// Server-detail's "Transfer to another account" entry opens the giver
    /// ceremony: the irreversible warning with the type-the-FQDN confirm field
    /// and the danger CTA. Asserted at the confirm stage only — the FQDN is
    /// never typed and the CTA never fired, so no offer is signed.
    func test_transferOfferEntryOpensCeremony() throws {
        let app = launch(tab: "home")
        openPodDetail(app, named: "Home")
        let entry = app.buttons["sd-transfer-server"]
        XCTAssertTrue(revealBySwipe(app, entry), "Server-detail should offer the transfer entry.")
        gymShot(app, "transfer-entry")
        entry.tap()
        XCTAssertTrue(
            app.textFields["transfer-confirm-field"].waitForExistence(timeout: 15),
            "The giver ceremony should show the type-to-confirm field."
        )
        XCTAssertTrue(
            app.buttons["transfer-start"].exists,
            "The giver ceremony should show the Transfer-this-box CTA."
        )
        gymShot(app, "transfer-confirm-gate")
    }

    // ─── D5 — box-request inbox approve card (web-total-box-inbox twin) ──────

    /// A box awaiting a boot-unlock approval (-smoke-awaiting-unlock, the Cabin
    /// pod) surfaces the one-tap Approve/Deny card at the TOP of its detail —
    /// the directory's cheap `awaitingUnlock` flag drives `.requestPending`
    /// deterministically with no backend. Never taps Approve (biometric + live
    /// ceremony — the live slice).
    func test_boxInboxApproveCard() throws {
        let app = launch(tab: "home", extra: ["-smoke-awaiting-unlock"])
        openPodDetail(app, named: "Cabin")
        XCTAssertTrue(
            app.buttons["sd-approve-unlock"].waitForExistence(timeout: 15),
            "A waiting box's detail should render the one-tap Approve card."
        )
        XCTAssertTrue(
            app.buttons["sd-deny-unlock"].exists,
            "The approve card should carry the Deny affordance too."
        )
        gymShot(app, "inbox-approve-card")
    }

    // ─── D5 — multi-pod switcher (web-total-pod-switcher twin) ───────────────

    /// The Services tab renders the PodSwitcher control (3 seeded pods) and
    /// tapping it opens the switcher menu listing the pods.
    func test_podSwitcherOpensMenu() throws {
        let app = launch(tab: "apps")
        let switcher = app.buttons["pod-switcher"].exists
            ? app.buttons["pod-switcher"] : app.otherElements["pod-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 15), "Services should render the pod switcher.")
        gymShot(app, "pod-switcher")
        switcher.tap()
        XCTAssertTrue(
            app.otherElements["pod-switcher-menu"].waitForExistence(timeout: 10)
                || app.buttons["pod-switcher-menu"].waitForExistence(timeout: 2),
            "Tapping the switcher should open the pod menu."
        )
        gymShot(app, "pod-switcher-menu")
    }

    // ─── D4 — create-server Advanced toggles (web-total-cs-advanced twin) ────

    /// The create-server wizard's step-1 Advanced section: default OFF with the
    /// embed-secrets + debug-friendly toggles HIDDEN; opening it reveals both
    /// (default OFF); closing Advanced RESETS an armed debug-friendly so a
    /// debug/secret choice can never stay silently armed.
    func test_createServerAdvancedTogglesResetRule() throws {
        let app = launch(tab: "home")
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20), "Home should offer add-server.")
        add.tap()
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 15), "Step 0 should show the name field.")
        name.tap()
        name.typeText("gymbox")
        app.buttons["cs-next-button"].tap()

        let advanced = app.switches["cs-advanced-toggle"]
        XCTAssertTrue(revealBySwipe(app, advanced), "Step 1 should show the Advanced toggle.")
        XCTAssertEqual(advanced.switchValue, "0", "Advanced must default OFF.")
        XCTAssertFalse(
            app.switches["cs-debug-friendly-toggle"].exists,
            "The debug-friendly toggle must be hidden while Advanced is off."
        )
        advanced.tap()
        let debug = app.switches["cs-debug-friendly-toggle"]
        let embed = app.switches["cs-embed-secrets-toggle"]
        XCTAssertTrue(debug.waitForExistence(timeout: 10), "Advanced should reveal debug-friendly.")
        XCTAssertTrue(embed.exists, "Advanced should reveal embed-secrets.")
        XCTAssertEqual(debug.switchValue, "0", "Debug-friendly must default OFF.")
        XCTAssertEqual(embed.switchValue, "0", "Embed-secrets must default OFF.")
        gymShot(app, "cs-advanced-open")

        // Arm debug-friendly, close Advanced, reopen — the reset rule must have
        // cleared it (a debug choice can never stay silently armed).
        debug.tap()
        XCTAssertEqual(debug.switchValue, "1", "Debug-friendly should arm on tap.")
        advanced.tap()   // close — hides + resets the children
        advanced.tap()   // reopen
        XCTAssertTrue(debug.waitForExistence(timeout: 10))
        XCTAssertEqual(debug.switchValue, "0", "Reopening Advanced must show debug-friendly RESET to off.")
        gymShot(app, "cs-advanced-reset")
    }

    // ─── D3 — admin-root state on Account security (web-total-admin-root twin) ─

    /// The Account-security screen reports THIS device's admin standing
    /// honestly: a non-admin device (no admin master root — the demo default)
    /// shows NO Rotate-admin card; with `-smoke-admin-root` the card + the
    /// Rotate control render.
    func test_adminRootStateGatesRotateCard() throws {
        // Non-admin half: no seed → the rotate card must be absent.
        var app = launch(tab: "settings")
        openAccountSecurity(app)
        XCTAssertFalse(
            app.buttons["rotate-admin-btn"].exists,
            "A non-admin device must NOT offer the Rotate-admin control."
        )
        gymShot(app, "admin-root-non-admin")

        // Admin half: seeded → the card + Rotate render.
        app = launch(tab: "settings", extra: ["-smoke-admin-root"])
        openAccountSecurity(app)
        let rotate = app.buttons["rotate-admin-btn"]
        XCTAssertTrue(revealBySwipe(app, rotate), "An admin device should offer the Rotate-admin control.")
        gymShot(app, "admin-root-admin")
    }

    // ─── D4 — rotate-admin ceremony (web-total-rotate-admin-ceremony twin) ───

    /// Rotate-admin opens its warning ceremony (the revoke-semantic alert) —
    /// Cancel signs/rotates nothing; the card is intact afterwards.
    func test_rotateAdminCeremonyFirstScreen() throws {
        let app = launch(tab: "settings", extra: ["-smoke-admin-root"])
        openAccountSecurity(app)
        let rotate = app.buttons["rotate-admin-btn"]
        XCTAssertTrue(revealBySwipe(app, rotate), "The admin device should offer Rotate.")
        rotate.tap()
        let alert = app.alerts["Rotate your admin key?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10), "Rotate should open its warning ceremony.")
        gymShot(app, "rotate-admin-ceremony")
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(rotate.waitForExistence(timeout: 5), "Cancel should land back on the intact card.")
        XCTAssertFalse(
            app.staticTexts["rotate-admin-done-msg"].exists,
            "Cancel must not have rotated anything."
        )
        gymShot(app, "rotate-admin-cancelled")
    }

    // ─── D3 — promote-to-admin toggle (web-total-promote-admin twin) ─────────

    /// The promote-to-admin toggle appears ONLY on an admin device's add-device
    /// SAS ceremony, default OFF; a non-admin device omits it entirely.
    func test_promoteAdminToggleAdminOnly() throws {
        // Non-admin half: the ceremony renders with NO promote section.
        var app = launch(tab: "settings")
        openAddDevice(app)
        XCTAssertFalse(
            app.switches["add-device-promote-admin-toggle"].exists,
            "A non-admin device must NOT offer promote-to-admin."
        )
        gymShot(app, "promote-absent-non-admin")

        // Admin half: the toggle renders, default OFF.
        app = launch(tab: "settings", extra: ["-smoke-admin-root"])
        openAddDevice(app)
        let promote = app.switches["add-device-promote-admin-toggle"]
        XCTAssertTrue(promote.waitForExistence(timeout: 15), "An admin device should offer promote-to-admin.")
        XCTAssertEqual(promote.switchValue, "0", "Promote-to-admin must default OFF.")
        gymShot(app, "promote-toggle-admin")
    }

    // ─── shared navigation ────────────────────────────────────────────────────

    private func openAccountSecurity(_ app: XCUIApplication) {
        let row = app.buttons["settings-open-account-security"]
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20), "Settings should render.")
        XCTAssertTrue(revealBySwipe(app, row), "Settings should offer the account-security row.")
        row.tap()
        // The screen is open once its enable/disable action (mock-served
        // account-type) renders — the row's own label also says "Account
        // security", so a bare title match could false-pass pre-navigation.
        XCTAssertTrue(
            app.buttons["account-security-enable-btn"].waitForExistence(timeout: 15)
                || app.buttons["account-security-disable-btn"].waitForExistence(timeout: 3),
            "The account-security screen should open."
        )
    }

    private func openAddDevice(_ app: XCUIApplication) {
        let row = app.buttons["settings-add-device"]
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20), "Settings should render.")
        XCTAssertTrue(revealBySwipe(app, row), "Settings should offer the add-device row.")
        row.tap()
        // The SAS ceremony's QR stage renders immediately (phase
        // .waitingForDevice is set before any relay await).
        XCTAssertTrue(
            app.navigationBars["Add a device"].waitForExistence(timeout: 10)
                || app.staticTexts["Waiting for the other device to scan…"].waitForExistence(timeout: 10),
            "The add-device SAS ceremony should open."
        )
    }
}

private extension XCUIElement {
    /// SwiftUI Toggle value as "0"/"1" (XCUITest surfaces it as a switch whose
    /// value is a stringly boolean).
    var switchValue: String { (value as? String) ?? "" }
}
