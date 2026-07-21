import XCTest

/// GYM iOS every-merge specs (§12-G4 / §10 Phase-2) — the curated, fast,
/// DETERMINISTIC, NO-BACKEND Tier-1 subset the gym drives on iOS: "does the app
/// still launch, render its core screens, and navigate without a broken edge."
/// This is the iOS leg of `gym:every-merge` (the cold-launch→Home smoke lives
/// in `GymSmokeTests`; this class adds the breadth).
///
/// NO BACKEND, by construction: every test launches with `-smoke-mode`, which
/// seeds `DemoFixtures` (three obviously-fake sample pods) against the MOCK
/// client — no `/api/*`, no Worker, no VPS (see FlagshipApp.applySmokeMode…).
/// `-smoke-tab <home|apps|activity|settings>` lands the shell on a tab on first
/// paint; `-smoke-ops` additionally seeds one in-flight build so the global
/// operations sliver renders.
///
/// The verdict is each test's assertion (Layer 1, §2.1). Screenshots are
/// captured at named points and attached to the `.xcresult` (kept always) so
/// the gym adapter can pull them for the advisory judge — they never decide
/// pass/fail.
///
/// Building this target builds the FlagshipApp end-to-end, so a green run also
/// validates the app build + the `-smoke-*` launch-arg seams. Each test method
/// is a SEPARATE gym scenario (`-only-testing:FlagshipAppUITests/
/// GymEveryMergeTests/<method>`); xcodebuild builds once then runs them
/// incrementally, so the per-scenario cost after the first is small.
final class GymEveryMergeTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Attach a screenshot under the gym's stable name so the adapter maps it
    /// to a screenshot point. `keepAlways` so the frame is present on success
    /// too (the D7 capture, §7-B).
    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Launch in smoke mode on a given tab (+ optional extra args).
    private func launch(tab: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab] + extra
        app.launch()
        return app
    }

    // ─── Per-tab render (the seeded paired shell) ────────────────────────────

    /// The Services tab renders its shell (nav title "Services") in smoke mode.
    func test_servicesTabRenders() throws {
        let app = launch(tab: "apps")
        gymShot(app, "cold-launch")
        XCTAssertTrue(
            app.navigationBars["Services"].waitForExistence(timeout: 15),
            "Smoke-mode Services tab should render its shell."
        )
        gymShot(app, "services-ready")
    }

    /// The Activity tab renders its shell (nav title "Activity") in smoke
    /// mode — the ActivityScreen landing.
    func test_activityTabRenders() throws {
        let app = launch(tab: "activity")
        gymShot(app, "cold-launch")
        XCTAssertTrue(
            app.navigationBars["Activity"].waitForExistence(timeout: 15),
            "Smoke-mode Activity tab should render its shell."
        )
        gymShot(app, "activity-ready")
    }

    /// The Settings tab renders its shell (nav title "Settings") + the
    /// load-bearing rows (account-security + the session-action cluster).
    func test_settingsTabRenders() throws {
        let app = launch(tab: "settings")
        gymShot(app, "cold-launch")
        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 15),
            "Smoke-mode Settings tab should render its shell."
        )
        // The account-security row + the tier-2 sign-out (the session-tiers
        // cluster) are the deterministic goal. Scroll into view first — the
        // sign-out lives below the fold.
        XCTAssertTrue(
            app.buttons["settings-open-account-security"].waitForExistence(timeout: 5),
            "Settings should show the account-security row."
        )
        let signOut = app.buttons["settings-sign-out-btn"]
        if !signOut.exists {
            app.swipeUp()
        }
        XCTAssertTrue(
            signOut.waitForExistence(timeout: 5),
            "Settings should show the tier-2 lock-with-passkey (sign-out) row."
        )
        gymShot(app, "settings-ready")
    }

    // ─── Navigation: Home → create-server form ───────────────────────────────

    /// From the seeded Home, the add-server affordance goes STRAIGHT to the
    /// create-server form (the provision-vs-pair chooser was removed; parity
    /// with the webapp + Android). The form is a 3-step design wizard: step 0
    /// is name + description, step 1 carries the disk-encryption toggle (the A4
    /// create-server control). Assert step 0 renders, then advance to step 1
    /// and assert the disk-encryption toggle. Renders against the mock client;
    /// no backend.
    func test_createServerFormReachable() throws {
        let app = launch(tab: "home")
        let addServer = app.buttons["home-add-server"]
        XCTAssertTrue(addServer.waitForExistence(timeout: 15), "Home should show add-server.")
        gymShot(app, "home-ready")
        addServer.tap()

        // Add-server goes straight into the create flow — no chooser.
        let name = app.textFields["cs-name-field"]
        XCTAssertTrue(
            name.waitForExistence(timeout: 15),
            "Add-server should open the create-server form (step 0 name field)."
        )
        gymShot(app, "create-server-form")
        // Name gates Next; type one, then advance to the boot-unlock /
        // disk-encryption step.
        name.tap()
        name.typeText("gymbox")
        let next = app.buttons["cs-next-button"]
        XCTAssertTrue(next.waitForExistence(timeout: 5), "Step 0 should offer Next.")
        next.tap()
        XCTAssertTrue(
            app.switches["cs-encrypt-disk-toggle"].waitForExistence(timeout: 10),
            "Create-server step 1 should show the disk-encryption toggle."
        )
        gymShot(app, "create-server-encrypt")
    }

    // ─── The global active-operations sliver ─────────────────────────────────

    /// With `-smoke-ops` seeding one in-flight build, the global operations
    /// sliver (`global-operations-bar`) renders (WhatsApp-style teal strip).
    /// Without the seed it correctly stays hidden, so this proves the sliver
    /// surfaces a live operation.
    func test_activeOperationsSliverRenders() throws {
        let app = launch(tab: "home", extra: ["-smoke-ops"])
        // The sliver lives in the top safe-area inset above the shell.
        XCTAssertTrue(
            app.otherElements["global-operations-bar"].waitForExistence(timeout: 15)
                || app.buttons["global-operations-bar"].waitForExistence(timeout: 1),
            "An in-flight operation should render the global operations sliver."
        )
        gymShot(app, "operations-sliver")
    }
}
