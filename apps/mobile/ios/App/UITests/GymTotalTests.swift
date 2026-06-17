import XCTest

/// GYM iOS TOTAL-gym Tier-1 tranche (§12-G5 / §6 matrix) — the higher-value,
/// fixture-feasible, DETERMINISTIC, NO-BACKEND scenarios that go BEYOND the
/// every-merge subset (`GymSmokeTests` + `GymEveryMergeTests`) into the §6
/// dimensions a demo fixture can seed + assert without a real box:
///
///   - D1 lifecycle (render/confirm side): server-detail cards; the revoke
///     confirmation sheet (the confirm UI + optimistic state, NOT a backend delete).
///   - D2 build modes (screens render): the chooser, git fitness, mcp connect,
///     the AI-key step. (Marketplace is on feat/marketplace — skipped on main.)
///   - D3 settings: the AI-keys manager.
///   - D4 security: the biometric lock screen; the maintainer-trust red sliver.
///   - D5 server-event → UI (fixture-seeded): awaiting-unlock approve card; a
///     dead server surfaces as such on Home. (The LIVE induction is G6.)
///   - D7 (light): a "primary action present + enabled per state" check.
///
/// NO BACKEND, by construction: every test launches with `-smoke-mode` (seeds
/// `DemoFixtures` against the MOCK client). The mock client returns canned
/// server-detail / build-modes responses, so the screens render real content;
/// the D5 seed states ride new gym-only launch args
/// (`-smoke-awaiting-unlock` / `-smoke-dead` / `-smoke-trust-untrusted` /
/// `-smoke-locked`) wired in `FlagshipApp.applySmokeModeIfRequested`. These args
/// are gym-only — production never passes them.
///
/// The verdict is each test's assertion (Layer 1, §2.1). Screenshots are
/// captured at named points and attached to the `.xcresult` (kept always) so
/// the gym adapter can pull them for the advisory judge — they never decide
/// pass/fail. Each test method is a SEPARATE gym scenario
/// (`-only-testing:FlagshipAppUITests/GymTotalTests/<method>`); xcodebuild
/// builds once then runs them incrementally.
final class GymTotalTests: XCTestCase {

    override func setUpWithError() throws {
        // The gym RUNNER invokes each method as its own `-only-testing:` scenario
        // (independent verdict), so per-test isolation is the runner's job. Keep
        // going after a failure here so a whole-class run (the developer's local
        // sanity check) reports EVERY method's result, not just up to the first
        // failure — each test relaunches the app fresh, so there's no shared state.
        continueAfterFailure = true
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

    /// Launch in smoke mode on a tab (+ optional extra gym-only args).
    private func launch(tab: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab] + extra
        app.launch()
        return app
    }

    /// Match a Home pod ROW by its name. The row is an FSListRow whose button
    /// a11y label concatenates the pod name + subtitle + pill ("Home, Living-room
    /// mini-PC, online"), so match by label-PREFIX — but EXCLUDE the bottom tab
    /// bar's "Home" button (whose label is EXACTLY the name) by requiring the
    /// label to be longer than the bare name. Without this, `firstMatch` on a
    /// bare-prefix match could pick the tab and "open pod" would be a no-op.
    private func podRow(_ app: XCUIApplication, named name: String) -> XCUIElement {
        return app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", name, name))
            .firstMatch
    }

    /// From the seeded Home, open the first server's ("Home") detail. Returns
    /// once the detail's nav bar ("Server") is shown.
    private func openHomePodDetail(_ app: XCUIApplication) {
        let row = podRow(app, named: "Home")
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The seeded Home pod row should be present.")
        row.tap()
        XCTAssertTrue(
            app.navigationBars["Server"].waitForExistence(timeout: 15),
            "Tapping the seeded online pod should push the server-detail screen."
        )
    }

    // ─── D1 — server-detail cards render (against the mock client) ───────────

    /// Tapping the seeded online pod renders its server-detail cards: the
    /// lock/power control, the front-page picker, and the View-journal action.
    /// These render from the MOCK serverDetail() response (no live box).
    func test_serverDetailRendersCards() throws {
        let app = launch(tab: "home")
        gymShot(app, "home-ready")
        openHomePodDetail(app)
        gymShot(app, "server-detail")
        // The power-off control (LockPowerCard) is the headline owner action.
        XCTAssertTrue(
            app.buttons["sd-power-off"].waitForExistence(timeout: 15),
            "Server-detail should render the lock-and-power-off control."
        )
        // The front-page picker (FrontPageCard) + the journal action
        // (JournalCard) round out the loaded detail. Scroll to reach them.
        let frontPage = app.buttons["sd-front-page-picker"]
        if !frontPage.exists { app.swipeUp() }
        XCTAssertTrue(
            frontPage.waitForExistence(timeout: 5) || app.otherElements["sd-front-page-picker"].exists,
            "Server-detail should render the front-page picker."
        )
        let journal = app.buttons["sd-journal-fetch"]
        if !journal.exists { app.swipeUp() }
        XCTAssertTrue(
            journal.waitForExistence(timeout: 5),
            "Server-detail should render the View-journal action."
        )
        gymShot(app, "server-detail-cards")
    }

    /// The danger-zone revoke opens the hold-to-confirm sheet — the CONFIRM UI,
    /// not a backend delete. Asserts the confirmation control surfaces, then
    /// stops (never actually revokes; this is Tier-1, no backend).
    func test_revokeServerSheetConfirm() throws {
        let app = launch(tab: "home")
        openHomePodDetail(app)
        // The revoke entry lives in the danger zone, below the fold.
        let revoke = app.buttons["sd-revoke-server"]
        for _ in 0..<4 where !revoke.exists { app.swipeUp() }
        XCTAssertTrue(revoke.waitForExistence(timeout: 10), "Server-detail should offer the revoke action.")
        gymShot(app, "danger-zone")
        revoke.tap()
        // The revoke sheet's hold-to-confirm control is the confirmation gate.
        XCTAssertTrue(
            app.buttons["revoke-confirm-hold"].waitForExistence(timeout: 10),
            "Tapping revoke should present the hold-to-confirm sheet (the confirm UI)."
        )
        gymShot(app, "revoke-confirm")
    }

    // ─── D2 — build-a-service modes (screens render) ─────────────────────────

    /// The Services tab's "Build another service" affordance opens the build
    /// chooser; all three on-`main` source tiles render (scratch / git / mcp).
    /// (Marketplace ships on feat/marketplace — absent on main by design.)
    func test_buildChooserRenders() throws {
        let app = launch(tab: "apps")
        // The Services tab (with mock apps) shows a "Build another service"
        // button; tapping it pushes the chooser ("Build a service").
        let build = app.buttons["Build another service"]
        XCTAssertTrue(build.waitForExistence(timeout: 15), "Services should offer a build affordance.")
        gymShot(app, "services-ready")
        build.tap()
        XCTAssertTrue(
            app.buttons["build-src-scratch"].waitForExistence(timeout: 15),
            "The build chooser should render the scratch tile."
        )
        XCTAssertTrue(app.buttons["build-src-git"].exists, "The build chooser should render the git tile.")
        XCTAssertTrue(app.buttons["build-src-mcp"].exists, "The build chooser should render the mcp tile.")
        gymShot(app, "build-chooser")
    }

    /// chooser → git → the fitness-verdict screen (Git import) renders its
    /// Check-repo control. Renders against the mock client; no backend.
    func test_buildGitFitnessScreen() throws {
        let app = launch(tab: "apps")
        let build = app.buttons["Build another service"]
        XCTAssertTrue(build.waitForExistence(timeout: 15))
        build.tap()
        let git = app.buttons["build-src-git"]
        XCTAssertTrue(git.waitForExistence(timeout: 15))
        git.tap()
        XCTAssertTrue(
            app.buttons["build-git-check"].waitForExistence(timeout: 15),
            "The git import screen should render its Check-repo control."
        )
        gymShot(app, "build-git")
    }

    /// chooser → mcp → the IDE-connect screen renders its Create-connection
    /// control. Renders against the mock client; no backend.
    func test_buildMcpConnectScreen() throws {
        let app = launch(tab: "apps")
        let build = app.buttons["Build another service"]
        XCTAssertTrue(build.waitForExistence(timeout: 15))
        build.tap()
        let mcp = app.buttons["build-src-mcp"]
        XCTAssertTrue(mcp.waitForExistence(timeout: 15))
        mcp.tap()
        XCTAssertTrue(
            app.buttons["build-mcp-create"].waitForExistence(timeout: 15),
            "The MCP connect screen should render its Create-connection control."
        )
        gymShot(app, "build-mcp")
    }

    /// chooser → scratch → the AI-key step (BuildKeyScreen) renders. With NO
    /// saved keys it offers the "use a different key" affordance. D2-B2 +
    /// D7-light: the AI-key step is present before the box model runs.
    func test_buildKeyAiStepRenders() throws {
        let app = launch(tab: "apps")
        let build = app.buttons["Build another service"]
        XCTAssertTrue(build.waitForExistence(timeout: 15))
        build.tap()
        let scratch = app.buttons["build-src-scratch"]
        XCTAssertTrue(scratch.waitForExistence(timeout: 15))
        scratch.tap()
        // The AI-key step's nav title is "AI key"; the "use a different key"
        // control is present whether or not a saved key exists.
        XCTAssertTrue(
            app.navigationBars["AI key"].waitForExistence(timeout: 15),
            "Scratch should route through the AI-key step."
        )
        XCTAssertTrue(
            app.buttons["build-key-different"].exists,
            "The AI-key step should offer the use-a-different-key affordance."
        )
        gymShot(app, "build-key")
    }

    // ─── D3 — settings: the AI-keys manager ──────────────────────────────────

    /// Settings → "AI keys" opens the device-local BYOK key manager; its
    /// Add-a-key affordance renders (the keys list is device-local — no
    /// backend). D3-C2.
    func test_aiKeysManagerRenders() throws {
        let app = launch(tab: "settings")
        // The "AI keys" row is an FSSettingsRow → a Button whose a11y label
        // concatenates the title + subtitle ("AI keys, Bring-your-own keys…"),
        // so match by label-prefix, and scroll the ScrollView until it's on screen.
        let aiKeys = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'AI keys'")).firstMatch
        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 15),
            "Settings should render its shell."
        )
        for _ in 0..<5 where !aiKeys.exists { app.swipeUp() }
        XCTAssertTrue(aiKeys.waitForExistence(timeout: 10), "Settings should offer the AI-keys row.")
        aiKeys.tap()
        XCTAssertTrue(
            app.navigationBars["AI keys"].waitForExistence(timeout: 15),
            "The AI-keys manager should open."
        )
        XCTAssertTrue(
            app.buttons["ai-key-add"].waitForExistence(timeout: 5),
            "The AI-keys manager should render the Add-a-key affordance."
        )
        gymShot(app, "ai-keys")
    }

    // ─── D4 — global security experience ──────────────────────────────────────

    /// Tapping the tier-1 "Lock with Face ID" action in Settings re-gates the
    /// shell behind the biometric lock screen (D4-E1) — the real user lock
    /// flow. `app.lock()` sets `awaitingManualUnlock`, so the lock screen STAYS
    /// up (no auto-unlock) for the assertion; the Simulator has no enrolled
    /// biometric anyway.
    func test_biometricLockScreenTraps() throws {
        let app = launch(tab: "settings")
        let lock = app.buttons["settings-lock-btn"]
        for _ in 0..<3 where !lock.exists { app.swipeUp() }
        XCTAssertTrue(lock.waitForExistence(timeout: 15), "Settings should offer the tier-1 Lock action.")
        lock.tap()
        // The biometric lock screen (its identified container surfaces as an
        // Other element; its "Flagship is locked" copy + sign-out are reliable
        // proxies if the container query is flaky across Xcode versions).
        let locked = app.otherElements["biometric-lock-screen"].waitForExistence(timeout: 15)
            || app.staticTexts["Flagship is locked"].waitForExistence(timeout: 5)
            || app.buttons["lock-sign-out-btn"].waitForExistence(timeout: 5)
        XCTAssertTrue(locked, "Tapping Lock should present the biometric lock screen over the shell.")
        gymShot(app, "lock-screen")
    }

    /// With `-smoke-trust-untrusted`, a positively-untrusted maintainer-trust
    /// verdict is seeded → the red GlobalTrustBar renders one non-dismissible
    /// failure line (D4-E7). The bar shows only while unlocked, so the seeded
    /// shell (unlocked) is the right surface.
    func test_trustSliverRendersUntrusted() throws {
        let app = launch(tab: "home", extra: ["-smoke-trust-untrusted"])
        XCTAssertTrue(
            app.otherElements["global-trust-bar"].waitForExistence(timeout: 15)
                || app.buttons["global-trust-bar"].waitForExistence(timeout: 1),
            "An untrusted verdict should render the red trust sliver."
        )
        gymShot(app, "trust-sliver")
    }

    // ─── D5 — server-event → UI (fixture-seeded) ──────────────────────────────

    /// With `-smoke-awaiting-unlock`, a box that is waiting for a boot-unlock
    /// approval is seeded (F1). The cheap `awaitingUnlock` directory flag drives
    /// the liveness classifier, so its Home row carries the
    /// `pod-card-waiting-approval` pill — the awaiting-unlock event surfaced on
    /// the front end, deterministically with no backend. (The approve CARD
    /// itself needs a live mailbox request to enter `requestPending`; that
    /// action→effect path is the live slice, G6.)
    func test_awaitingUnlockApproveCard() throws {
        let app = launch(tab: "home", extra: ["-smoke-awaiting-unlock"])
        // The waiting box is "Cabin".
        let row = podRow(app, named: "Cabin")
        for _ in 0..<3 where !row.exists { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The awaiting-unlock pod row should be present.")
        let pill = app.staticTexts.matching(identifier: "pod-card-waiting-approval").firstMatch.waitForExistence(timeout: 10)
            || app.otherElements["pod-card-waiting-approval"].waitForExistence(timeout: 5)
            || app.descendants(matching: .any).matching(identifier: "pod-card-waiting-approval").firstMatch.waitForExistence(timeout: 5)
        XCTAssertTrue(pill, "A box awaiting unlock should carry the waiting-for-approval pill on Home.")
        gymShot(app, "home-awaiting")
    }

    /// With `-smoke-dead`, a box that registered long ago and never came online
    /// (no live unlock request) is seeded (F3). Its Home row carries the
    /// never-online status pill — the dead/offline event surfaced on the front
    /// end. (Decommission is offered on its detail; here we assert the Home
    /// surfacing, which is deterministic.)
    func test_deadServerSurfacesOnHome() throws {
        let app = launch(tab: "home", extra: ["-smoke-dead"])
        let row = podRow(app, named: "Attic")
        for _ in 0..<3 where !row.exists { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The dead pod row should be present.")
        // The never-online pill is the dead-state surfacing on Home. The pill
        // id can land on a static text or an other element depending on its
        // composition — accept either.
        let pill = app.staticTexts.matching(identifier: "pod-card-never-online").firstMatch.waitForExistence(timeout: 10)
            || app.otherElements["pod-card-never-online"].waitForExistence(timeout: 5)
            || app.descendants(matching: .any).matching(identifier: "pod-card-never-online").firstMatch.waitForExistence(timeout: 5)
        XCTAssertTrue(pill, "A dead server should carry the never-online status pill on Home.")
        gymShot(app, "dead-server")
    }
}
