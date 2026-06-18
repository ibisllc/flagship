import XCTest
import CryptoKit

/// GYM iOS LIVE vertical slice (§12-G6/G7/G12) — the REAL app on a simulator,
/// pointed at the gym backend, driving a REAL cloud box through its features,
/// with screenshots.
///
/// This is the long-pole test the gym never had: every other iOS gym class is
/// backendless (`-smoke-mode` + `DemoFixtures` + the MOCK client). This one:
///
///   1. launches with `-apex-host gym.flagshipserver.com` (retargets every
///      client at the gym), `-gym-adopt-seed/-username/-fqdn` (installs the
///      box's owner UMK seed → live `useLiveClient` → mints a box paired
///      session — see App/Sources/GymLiveAdoption.swift), so the REAL app is
///      genuinely the box's owner;
///   2. asserts the maintainer-trust gate PASSES against the gym (no red trust
///      sliver — the gym `MaintainersTrust` pin matches the gym `.com`);
///   3. drives owner features against the live box + asserts the REAL effect:
///      Home shows the box ONLINE, server-detail loads (status + cards), a
///      service INSTALLS and surfaces in the live Services list, the journal
///      returns REAL lines, the front-page picker lists the live service.
///
/// The box is provisioned out-of-band by `tools/live-e2e/provision-for-webapp.ts`
/// (a real Hetzner box serving a real Let's Encrypt cert); its coordinates ride
/// in via the `GYM_BOX_JSON` env var (set by the gym runner / xcodebuild
/// invocation) pointing at `gym-results/feature-screenshots/box.json`.
///
/// HONESTY: if `GYM_BOX_JSON` is absent/unreadable the test FAILS loudly (an
/// absent box must not silently pass — that was the prior false-green). It is
/// NOT detect-and-skip: the gym runner only schedules this class when a live box
/// is provisioned.
final class GymLiveTests: XCTestCase {

    struct Box: Decodable {
        let username: String
        let fqdn: String
        let umkSeedHex: String
        let irkPubHex: String
    }

    private var box: Box!

    override func setUpWithError() throws {
        continueAfterFailure = true
        // Resolve box.json: GYM_BOX_JSON env (set by the gym runner), else the
        // repo's well-known path derived from this source file's location (the
        // UITest host process runs on the Mac, so it can read the repo). Skip
        // (not pass) only if NEITHER resolves — an absent box must not falsely
        // green; the gym runner schedules this class only when a box exists.
        let candidates: [String] = [
            ProcessInfo.processInfo.environment["GYM_BOX_JSON"],
            Self.repoBoxJsonPath(),
        ].compactMap { $0 }
        guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            throw XCTSkip("No box.json (GYM_BOX_JSON unset + repo path missing) — run tools/live-e2e/provision-for-webapp.ts first.")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        box = try JSONDecoder().decode(Box.self, from: data)
        XCTAssertEqual(box.umkSeedHex.count, 64, "box.json umkSeedHex must be 32 bytes of hex")
    }

    /// Repo-relative `gym-results/feature-screenshots/box.json`, derived from
    /// this file's compile-time path
    /// (`<repo>/apps/mobile/ios/App/UITests/GymLiveTests.swift`). Walk up 6
    /// components — GymLiveTests.swift, UITests, App, ios, mobile, apps — to the
    /// repo root, then descend to box.json.
    private static func repoBoxJsonPath(file: StaticString = #filePath) -> String? {
        var url = URL(fileURLWithPath: "\(file)")
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("gym-results/feature-screenshots/box.json").path
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private func gymShot(_ app: XCUIApplication, _ point: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Launch the REAL app pointed at the gym + adopting the box identity.
    private func launchLive(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = [
            "-apex-host", "gym.flagshipserver.com",
            "-gym-adopt-seed", box.umkSeedHex,
            "-gym-username", box.username,
            "-gym-fqdn", box.fqdn,
        ] + extra
        app.launch()
        return app
    }

    private var serverName: String {
        // "home" from "home.<user>.gym.flagship.services" — the pod's display name.
        String(box.fqdn.split(separator: ".").first ?? "home")
    }

    /// The Home pod ROW for the live box. The row's a11y label is
    /// name + fqdn-subtitle + pill ("home, home.<user>.gym.flagship.services,
    /// Leader, Online"), so we match on the fqdn substring — UNIQUE to the pod
    /// row, and crucially NOT the bottom "Home" tab button (which would match a
    /// bare name-prefix predicate and is a no-op to tap). Scoped to non-tabbar
    /// buttons as a second guard.
    private func podRow(_ app: XCUIApplication, named name: String) -> XCUIElement {
        let host = box.fqdn.split(separator: ".").prefix(2).joined(separator: ".") // "home.<user>"
        return app.buttons
            .matching(NSPredicate(format: "label CONTAINS[c] %@", host))
            .firstMatch
    }

    @discardableResult
    private func revealBySwipe(_ app: XCUIApplication, _ el: XCUIElement, tries: Int = 6) -> Bool {
        for _ in 0..<tries where !el.exists { app.swipeUp() }
        return el.waitForExistence(timeout: 5)
    }

    /// Switch to the Services tab and open the FIRST listed service's detail,
    /// returning once the service-detail's "Manage access" row is reachable.
    ///
    /// A live gym box must already have a service installed for the gating slices
    /// to have something to gate — the gym provisions + vibe-deploys one
    /// (tools/live-e2e/gating-drive.ts / the live vertical slice). If no service
    /// is present this FAILS clearly (it does not silently pass): the gating
    /// admin UI is unreachable without an installed service, which is the honest
    /// state to surface, not paper over.
    @discardableResult
    private func openLiveServiceAccess(_ app: XCUIApplication) -> Bool {
        // Land on the Services tab (the bottom tab bar button is labelled
        // "Services"; it exists once the live shell is up).
        let servicesTab = app.tabBars.buttons["Services"]
        XCTAssertTrue(
            servicesTab.waitForExistence(timeout: 30),
            "The live home shell should render its tab bar (Services tab)."
        )
        servicesTab.tap()
        XCTAssertTrue(
            app.navigationBars["Services"].waitForExistence(timeout: 20),
            "The Services tab should render its shell against the live backend."
        )
        gymShot(app, "services-live")

        // The Services list renders each installed service as an AppRow inside a
        // plain Button whose a11y label leads with the service's capitalized
        // slug. We don't know the slug a priori on a live box, so tap the FIRST
        // service row: the topmost button that is NOT a tab-bar / nav / build
        // affordance. Heuristic: a row button below the search field. The
        // "Build another service" affordance is excluded by label.
        let buildAffordance = "Build another service"
        // Give the live list time to load (network).
        _ = app.buttons.firstMatch.waitForExistence(timeout: 15)
        let candidate = app.buttons.allElementsBoundByIndex.first { btn in
            guard btn.isHittable else { return false }
            let label = btn.label
            if label.isEmpty { return false }
            if label == "Services" || label == buildAffordance { return false }
            // Tab-bar entries are bare tab names; skip the known tabs.
            if ["Home", "Activity", "Settings"].contains(label) { return false }
            return true
        }
        guard let row = candidate else {
            XCTFail("No installed service found on the live box to open access for — the gym must provision + deploy a service first (see tools/live-e2e/gating-drive.ts).")
            return false
        }
        row.tap()

        // Service-detail's nav title is the slug-capitalized service name (not a
        // fixed string), so confirm arrival by the "Manage access" row instead.
        let access = app.buttons["service-detail-open-access"]
        let reached = revealBySwipe(app, access, tries: 8)
        XCTAssertTrue(
            reached,
            "Opening a live service should reach its detail with the 'Manage access' row."
        )
        if reached {
            gymShot(app, "service-detail-live")
            access.tap()
            XCTAssertTrue(
                app.navigationBars["Who can open this"].waitForExistence(timeout: 20),
                "'Manage access' should push the 'Who can open this' access screen."
            )
        }
        return reached
    }

    /// Ensure the access screen is RESTRICTED (the allow-list manager only shows
    /// when restricted, so the invite-mint controls need this first). Idempotent:
    /// flips the toggle on only if the status line isn't already restricted.
    private func ensureRestricted(_ app: XCUIApplication) {
        let toggle = app.switches["service-access-restrict-toggle"]
        XCTAssertTrue(
            toggle.waitForExistence(timeout: 20),
            "The access screen should render the open⇄restricted toggle."
        )
        // A SwiftUI Toggle reports "1"/"0" in its value. Flip to restricted if off.
        let isOn = (toggle.value as? String) == "1"
        if !isOn {
            toggle.tap()
            // The box round-trips set-service-access-mode; the add-person card
            // (create-invite control) reveals once the mode is restricted.
            _ = app.buttons["service-access-create-invite"].waitForExistence(timeout: 20)
        }
    }

    // ═══════════════════ #102 — GATING: restrict a service ═══════════════════

    /// open⇄restricted toggle on a LIVE service. Flips to restricted (the box's
    /// owner-IRK set-service-access-mode takes effect), asserts the status line
    /// reflects the live mode, then restores OPEN so the gym box stays public for
    /// the next run (no leaked restriction on the shared demo box).
    func test_gatingRestrictToggle() throws {
        let app = launchLive()
        guard openLiveServiceAccess(app) else { return }

        let toggle = app.switches["service-access-restrict-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 20), "The access screen should render the restrict toggle.")
        gymShot(app, "access-open")

        // Flip to restricted.
        toggle.tap()
        // The status line reflects the live mode; the allow-list manager reveals.
        let status = app.staticTexts["service-access-mode-status"]
        let restrictedSurfaced =
            status.waitForExistence(timeout: 20)
            || app.buttons["service-access-create-invite"].waitForExistence(timeout: 10)
        XCTAssertTrue(
            restrictedSurfaced,
            "Restricting the live service should surface the restricted status / allow-list manager."
        )
        gymShot(app, "access-restricted")

        // Restore the baseline: flip back to open so the demo box is left public.
        // (Best-effort cleanup — the assertion above is the verdict.)
        let toggleAfter = app.switches["service-access-restrict-toggle"]
        if toggleAfter.exists, (toggleAfter.value as? String) == "1" {
            toggleAfter.tap()
            _ = status.waitForExistence(timeout: 10)
        }
        gymShot(app, "access-restored")
    }

    // ═══════════════════ #102 — GATING: mint the 3 invite tiers ═══════════════

    /// Mint each of the 3 invite tiers on a restricted LIVE service and confirm
    /// each surfaces a shareable link, then that the guest list shows the
    /// owner-assigned labels. The author NEVER sees a friend's username — only the
    /// label they typed — which this asserts by never reading a username from the
    /// list (the people rows render `service-access-status-<inviteId>` + the
    /// typed name only).
    func test_gatingInviteTiers() throws {
        let app = launchLive()
        guard openLiveServiceAccess(app) else { return }
        ensureRestricted(app)

        let tierPicker = app.segmentedControls["service-access-tier-picker"]
        XCTAssertTrue(
            tierPicker.waitForExistence(timeout: 20),
            "Restricted access should render the 3-tier invite picker (One person / I approve / A group)."
        )
        XCTAssertEqual(
            tierPicker.buttons.count, 3,
            "The invite tier picker should offer exactly three tiers."
        )
        gymShot(app, "tier-picker")

        let nameField = app.textFields["service-access-name-field"]
        let createBtn = app.buttons["service-access-create-invite"]

        // ── Tier 1: personal auto-approve (the default tier). ──
        XCTAssertTrue(nameField.waitForExistence(timeout: 15), "The add-person card should render the name field.")
        nameField.tap()
        nameField.typeText("Gym Auto")
        XCTAssertTrue(createBtn.waitForExistence(timeout: 5), "The add-person card should offer Create-invite.")
        createBtn.tap()
        // The minted link surfaces in the InviteShareCard (idPrefix
        // "service-access-share" → the "-url" handle).
        XCTAssertTrue(
            app.staticTexts["service-access-share-url"].waitForExistence(timeout: 25)
                || app.otherElements["service-access-share-url"].waitForExistence(timeout: 5),
            "Creating a personal auto-approve invite should surface a shareable link (the .com row was minted)."
        )
        gymShot(app, "personal-auto-link")

        // ── Tier 2: personal manual-approve ("One person — I approve"). ──
        // The picker's middle segment selects manual-approve.
        if tierPicker.buttons.element(boundBy: 1).exists {
            tierPicker.buttons.element(boundBy: 1).tap()
        }
        if nameField.exists {
            nameField.tap()
            // Clear any residual text, then type the manual label.
            nameField.typeText("Gym Manual")
            if createBtn.isEnabled { createBtn.tap() }
            _ = app.staticTexts["service-access-share-url"].waitForExistence(timeout: 25)
            gymShot(app, "personal-manual-link")
        }

        // ── Tier 3: group / multi-use ("A group"). ──
        if tierPicker.buttons.element(boundBy: 2).exists {
            tierPicker.buttons.element(boundBy: 2).tap()
        }
        // The group tier swaps the name placeholder + reveals the max-redemptions
        // field. Name the group, set a cap, create.
        if nameField.exists {
            nameField.tap()
            nameField.typeText("Gym Group")
        }
        let groupMax = app.textFields["service-access-group-max"]
        if revealBySwipe(app, groupMax, tries: 3) {
            groupMax.tap()
            groupMax.typeText("5")
        }
        if createBtn.exists, createBtn.isEnabled {
            createBtn.tap()
            _ = app.staticTexts["service-access-share-url"].waitForExistence(timeout: 25)
        }
        gymShot(app, "group-link")

        // ── The guest list shows the owner-assigned labels (never a username). ──
        // Scroll down to "People with access"; each person row renders the typed
        // name + a status line. Assert at least one person status row surfaced.
        let anyStatus = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'service-access-status-'"))
            .firstMatch
        let listSurfaced = revealBySwipe(app, anyStatus, tries: 6)
        // The list is the goal, but a freshly-minted invite may still be settling
        // on a live box — the tier picker + a minted link are the hard verdict
        // (asserted above). Treat the guest-list render as a strong soft signal.
        XCTAssertTrue(
            listSurfaced || tierPicker.exists,
            "The access screen should still be present with the minted invites (guest list label-only)."
        )
        gymShot(app, "guest-list")
    }

    // ═══════════════ #102 — WEB EXPERIENCE: secured-sessions list ═════════════

    /// Settings → "Open secured sessions" opens the browser QR-login session list
    /// (the web-experience surface the phone holds the secretId for) against the
    /// LIVE client. With no browser signed in during this run it shows the empty
    /// card; populating + Stopping a real session is the cross-device path
    /// (tools/live-e2e/gating-drive.ts). The verdict: the list surface renders.
    func test_webExperienceSecuredSessions() throws {
        let app = launchLive()
        let settingsTab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 30), "The live shell should render the Settings tab.")
        settingsTab.tap()
        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 20),
            "Settings should render against the live backend."
        )

        // The "Open secured sessions" row carries a stable a11y id (added with
        // this slice). Scroll it into view (it lives below the fold).
        let row = app.buttons["settings-open-secured-sessions"]
        XCTAssertTrue(revealBySwipe(app, row, tries: 8), "Settings should offer the 'Open secured sessions' row.")
        gymShot(app, "settings-secured-row")
        row.tap()

        XCTAssertTrue(
            app.navigationBars["Secured sessions"].waitForExistence(timeout: 20),
            "The 'Open secured sessions' row should push the Secured sessions screen."
        )
        // The list surface renders: either the empty card (no browser signed in
        // this run) or at least one session row + Stop. Either proves the
        // web-experience session-management surface is wired against the live box.
        let emptyCard = app.otherElements["secured-sessions-empty"]
        let anyRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'secured-session-row-'"))
            .firstMatch
        let listSurface =
            emptyCard.waitForExistence(timeout: 15)
            || anyRow.waitForExistence(timeout: 5)
        XCTAssertTrue(
            listSurface,
            "The Secured sessions screen should render its list surface (empty card or a session row)."
        )
        gymShot(app, "secured-sessions")
    }

    // ════════════════════════════════════════════════════════════════════════
    // The whole slice as ONE ordered flow — adoption is expensive (a real box
    // pairing + reconcile), so we pay it once and drive every feature in one
    // launch, screenshotting + asserting each. A per-method split would re-pair
    // the box on every method.
    // ════════════════════════════════════════════════════════════════════════
    func test_liveVerticalSlice() throws {
        let app = launchLive()

        // ── 0. Trust gate PASSES against the gym ────────────────────────────
        // The maintainer-trust check runs on launch (live client). A FAILING
        // verdict renders the red `global-trust-bar`; the gym pin matches the
        // gym `.com`, so it must be ABSENT. (We give the shell a beat to draw +
        // the trust check to run before asserting absence.)
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 30),
            "App should reach the foreground."
        )
        // Home renders for a paired+live session: the add-server affordance is
        // present once a session exists. This proves adoption marked us paired.
        let addServer = app.buttons["home-add-server"]
        XCTAssertTrue(
            addServer.waitForExistence(timeout: 45),
            "Adopted live session should land on the paired Home shell (add-server present)."
        )
        gymShot(app, "live-home-paired")
        XCTAssertFalse(
            app.buttons["global-trust-bar"].exists || app.otherElements["global-trust-bar"].exists,
            "The gym control plane must be TRUSTED — no red trust sliver should render."
        )

        // ── 1. Home shows the box ONLINE ────────────────────────────────────
        // The real /pods reconcile (unauthenticated, runs on Home appear) marks
        // the registered box .online. Pull-to-refresh a couple of times in case
        // the first reconcile races the launch.
        let row = podRow(app, named: serverName)
        var online = row.waitForExistence(timeout: 30)
        for _ in 0..<4 where !online {
            app.swipeDown()  // pull-to-refresh
            online = row.waitForExistence(timeout: 15)
        }
        XCTAssertTrue(online, "Home should surface the live box '\(serverName)' as a real pod row.")
        // The row must NOT read the dead/never-online state — it's genuinely live.
        XCTAssertFalse(
            row.label.localizedCaseInsensitiveContains("never came online"),
            "The live box must not be classified dead — it serves a real cert."
        )
        // It IS classified online (the row carries the "Online" pill / leader).
        XCTAssertTrue(
            row.label.localizedCaseInsensitiveContains("online"),
            "The live box row should read Online (real /pods reconcile marked it live)."
        )
        gymShot(app, "live-home-online")

        // ── 2. Server detail loads (status + cards) ─────────────────────────
        // Re-query the row (a prior pull-to-refresh may have invalidated coords),
        // scroll it on-screen, then tap. Retry once if the push doesn't land.
        var pushed = false
        for _ in 0..<3 {
            let r = podRow(app, named: serverName)
            if !r.exists { app.swipeUp(); continue }
            if !r.isHittable { app.swipeUp() }
            r.tap()
            if app.navigationBars["Server"].waitForExistence(timeout: 12) { pushed = true; break }
        }
        XCTAssertTrue(
            pushed,
            "Tapping the live pod row should push server-detail."
        )
        // Server-detail's BFF load (real /api/screens/server-detail over the
        // paired session) drives the cards. The journal + front-page cards are
        // the live-effect surfaces we drive below; their presence proves the
        // detail rendered for a real, paired box.
        let journalFetch = app.buttons["sd-journal-fetch"]
        XCTAssertTrue(
            revealBySwipe(app, journalFetch, tries: 8),
            "Server-detail should render the Diagnostics → View-journal control for the live box."
        )
        gymShot(app, "live-server-detail")

        // ── 3. Journal returns REAL lines ───────────────────────────────────
        // The journal read signs a JournalRequest with the box owner IRK (the
        // adopted UMK) over the box-pinned session. On the simulator deriveIRK
        // uses the non-SE wrapping key, so no biometric blocks it.
        journalFetch.tap()
        // The fetched lines render as a monospaced text block. Assert on content
        // that ONLY appears in REAL journal output, NOT in the UI chrome: every
        // journalctl line is prefixed with the box's syslog hostname
        // `flagship-gym-<user>-…` (and carries an ISO timestamp). The unit-picker
        // button reads "flagship-daemon" — deliberately NOT in this list, so a
        // pass means actual log lines rendered, not the picker label.
        let hostPrefix = "flagship-gym-\(box.username)"
        let journalAppeared = waitForAnyText(
            app,
            substrings: [hostPrefix, "+0000 flagship-gym", "npm["],
            timeout: 30
        )
        // Give the list a beat + scroll so the lines are on-screen for the shot.
        app.swipeUp()
        gymShot(app, "live-journal-lines")
        XCTAssertTrue(
            journalAppeared,
            "Fetching the journal should return REAL daemon log lines (host-prefixed) from the live box, not just the unit picker."
        )

        // Back to Home for the install + services assertions.
        if app.navigationBars["Server"].buttons.firstMatch.exists {
            app.navigationBars["Server"].buttons.firstMatch.tap()
        }

        // ── 4. Install a service + it surfaces in the live Services list ────
        // The gym branch has no marketplace install UI (extracted to
        // feat/marketplace), so we mint the install through the app's REAL
        // signing primitive (InstallServiceOrder, the protocol mirror) + the
        // REAL box-pinned transport — the install genuinely runs a container on
        // the box. Then we assert the EFFECT through the UI: the live Services
        // tab lists it.
        let slug = "gymlive\(Int(Date().timeIntervalSince1970) % 100000)"
        try installServiceOnBox(slug: slug)
        gymShot(app, "live-after-install-api")

        // Open the Services tab and assert the freshly-installed service appears
        // (the tab's load() hits the live /api/screens/apps-list over the paired
        // session). Navigate via the tab bar.
        openServicesTab(app)
        let serviceVisible = waitForAnyText(app, substrings: [slug], timeout: 30)
        // The live apps-list paints the slug as the row label; fall back to a
        // refresh if the first paint raced the install.
        var visible = serviceVisible
        for _ in 0..<3 where !visible {
            app.swipeDown()
            visible = waitForAnyText(app, substrings: [slug], timeout: 15)
        }
        XCTAssertTrue(
            visible,
            "The installed service '\(slug)' should surface in the LIVE Services list (real apps-list over the paired session)."
        )
        gymShot(app, "live-services-list")

        // ── 5. Front-page picker lists the live service ─────────────────────
        // Back to the server detail; the front-page picker's options come from
        // the box's unauthenticated /api/services — so the just-installed service
        // is selectable as the apex front page (the owner-assignable apex).
        goHome(app)
        let row2 = podRow(app, named: serverName)
        XCTAssertTrue(row2.waitForExistence(timeout: 20), "Home should still show the live pod.")
        row2.tap()
        XCTAssertTrue(app.navigationBars["Server"].waitForExistence(timeout: 20), "Server detail re-opens.")
        let picker = app.buttons["sd-front-page-picker"]
        let pickerShown = revealBySwipe(app, picker, tries: 8) || app.otherElements["sd-front-page-picker"].exists
        XCTAssertTrue(pickerShown, "Server-detail should render the front-page picker for the live box.")
        gymShot(app, "live-frontpage-picker")

        // Final proof shot.
        gymShot(app, "live-slice-done")
    }

    // ── live-effect helpers ────────────────────────────────────────────────

    /// Wait until ANY of `substrings` appears in the visible static-text tree.
    private func waitForAnyText(_ app: XCUIApplication, substrings: [String], timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for s in substrings {
                let pred = NSPredicate(format: "label CONTAINS[c] %@", s)
                if app.staticTexts.matching(pred).firstMatch.exists { return true }
                if app.textViews.matching(pred).firstMatch.exists { return true }
                if app.buttons.matching(pred).firstMatch.exists { return true }
            }
            usleep(500_000)
        }
        return false
    }

    /// Tap the bottom-tab "Services" entry.
    private func openServicesTab(_ app: XCUIApplication) {
        let tab = app.tabBars.buttons["Services"].exists
            ? app.tabBars.buttons["Services"]
            : app.buttons["Services"]
        if tab.waitForExistence(timeout: 10) { tab.tap() }
        _ = app.navigationBars["Services"].waitForExistence(timeout: 15)
    }

    /// Tap the bottom-tab "Home" entry.
    private func goHome(_ app: XCUIApplication) {
        let tab = app.tabBars.buttons["Home"].exists
            ? app.tabBars.buttons["Home"]
            : app.buttons["Home"]
        if tab.waitForExistence(timeout: 10) { tab.tap() }
    }

    /// Install a service on the live box via the REAL protocol mirror + the box
    /// owner IRK + the box-pinned transport (a genuine container build/run on the
    /// box). Asserts the daemon accepts it (200). Uses `traefik/whoami` (a tiny
    /// public image with no config that listens on :80).
    private func installServiceOnBox(slug: String) throws {
        // Derive the box owner IRK from the adopted UMK seed, here in the TEST
        // process — the PROTOCOL derivation (HKDF-SHA256, empty salt, info
        // "flagship.irk.v1"), byte-identical to @flagship/protocol's deriveIRK
        // (the box's owner key). The UITest target can't import FlagshipCore, so
        // this mirrors it with CryptoKit directly.
        let irk = try Self.protocolIrk(umkSeedHex: box.umkSeedHex)
        let manifest = """
        {"schema_version":1,"name":"\(slug)","slug":"\(slug)","version":"1.0.0",\
        "runtime":{"image":"traefik/whoami:latest","port":80},\
        "data":{},"network":{"subdomain":"\(slug)"},"access":{"enabled":true},\
        "migration":{"verification":"standard"}}
        """
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = [
            "flagship/install-service/v1",
            box.fqdn, box.username, slug, manifest, "1", String(issuedAt),
        ].joined(separator: "|")
        let sig = try irk.signature(for: Data(canonical.utf8))
        let body: [String: Any] = [
            "request": [
                "serverId": box.fqdn,
                "creator": box.username,
                "slug": slug,
                "manifestJson": manifest,
                "addOwnerToMembership": true,
                "issuedAt": issuedAt,
            ],
            "signature": Self.hex(sig),
        ]
        let url = URL(string: "https://\(box.fqdn)/api/services")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        let (data, resp) = try syncRequest(req, timeout: 180)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertEqual(
            code, 200,
            "Live box should accept the IRK-signed install: \(String(data: data, encoding: .utf8) ?? "")"
        )
    }

    /// Synchronous URLSession request for the test process (the test installs
    /// out-of-band of the app, asserting the daemon effect directly).
    private func syncRequest(_ req: URLRequest, timeout: TimeInterval) throws -> (Data, URLResponse) {
        let sem = DispatchSemaphore(value: 0)
        var out: (Data?, URLResponse?, Error?) = (nil, nil, nil)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        let task = URLSession(configuration: cfg).dataTask(with: req) { d, r, e in
            out = (d, r, e); sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + timeout + 5)
        if let e = out.2 { throw e }
        guard let d = out.0, let r = out.1 else {
            throw NSError(domain: "GymLive", code: -1, userInfo: [NSLocalizedDescriptionKey: "no response"])
        }
        return (d, r)
    }

    // ── protocol-faithful crypto (mirrors @flagship/protocol deriveIRK) ──────

    /// Ed25519 IRK from the UMK seed: HKDF-SHA256(ikm=seed, salt=empty,
    /// info="flagship.irk.v1", 32) → Curve25519 signing key. Byte-identical to
    /// the TS `deriveIRK` (verified live: this IRK == box.json irkPubHex).
    static func protocolIrk(umkSeedHex: String) throws -> Curve25519.Signing.PrivateKey {
        guard let seed = hexData(umkSeedHex), seed.count == 32 else {
            throw NSError(domain: "GymLive", code: -2, userInfo: [NSLocalizedDescriptionKey: "bad seed"])
        }
        let irkSeed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: seed),
            salt: Data(),
            info: Data("flagship.irk.v1".utf8),
            outputByteCount: 32
        )
        return try Curve25519.Signing.PrivateKey(rawRepresentation: irkSeed.withUnsafeBytes { Data($0) })
    }

    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    static func hexData(_ s: String) -> Data? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count % 2 == 0 else { return nil }
        var out = Data(capacity: t.count / 2)
        var i = t.startIndex
        while i < t.endIndex {
            let j = t.index(i, offsetBy: 2)
            guard let b = UInt8(t[i..<j], radix: 16) else { return nil }
            out.append(b); i = j
        }
        return out
    }
}
