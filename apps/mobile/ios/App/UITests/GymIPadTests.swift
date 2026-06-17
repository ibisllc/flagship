import XCTest

/// GYM iOS iPad surface (§7-C / D8) — the adaptive iPad layout assertions.
///
/// The app already ships an adaptive shell (`FlagshipUI/Shell/RootShell.swift`):
/// in the REGULAR horizontal size class (iPad) it renders a 280pt sidebar + a
/// main content pane (NOT the iPhone compact `TabView`), every hero screen wraps
/// its content in `.fsReadingColumn()` (≤640pt, centered), and the nav titles
/// degrade from `.large` to `.inline`. This class asserts that adaptive surface
/// is actually drawn — it does NOT build the layout (the layout pre-exists).
///
/// CRITICAL — destination binding: the gym's iOS adapter (tools/gym/src/adapters/
/// ios.ts) routes any scenario whose `harness` contains "GymIPad" to the iPad
/// `-destination` (iPad Pro 11-inch M4) and everything else to the iPhone. So
/// these methods MUST run on an iPad simulator; on an iPhone the regular size
/// class is never entered and the sidebar assertion would (correctly) fail.
///
/// NO BACKEND, by construction: every test launches with `-smoke-mode` (seeds
/// `DemoFixtures` against the MOCK client). The verdict is each test's assertion
/// (Layer 1, §2.1); screenshots are attached to the `.xcresult` (kept always) so
/// the gym adapter can pull them for the advisory judge — they never decide
/// pass/fail.
final class GymIPadTests: XCTestCase {

    override func setUpWithError() throws {
        // Each method relaunches a fresh app, so per-test isolation is the
        // runner's job; keep going after a failure so a whole-class local run
        // reports every method's result.
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

    /// Launch in smoke mode on a tab (+ optional extra gym-only args). The gym
    /// runner invokes each method as its OWN `-only-testing:` process (so they're
    /// already isolated), but a developer whole-class run shares one process — so
    /// terminate any prior instance first to guarantee a clean, freshly-seeded
    /// launch every method (no bled navigation/tab state).
    private func launch(tab: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab] + extra
        app.launch()
        return app
    }

    // ─── D8 — the iPad sidebar shell (NOT the iPhone TabView) ─────────────────

    /// On the iPad destination the regular-size-class shell renders the 280pt
    /// sidebar (`ipad-sidebar`) and NOT the compact iPhone `TabView` — so there
    /// is no UIKit tab bar. Asserting BOTH (sidebar present AND tab bar absent)
    /// proves the adaptive branch chose the iPad layout, not just that some
    /// shell drew. The sidebar carries the destination rows ("Home"/"Services"/
    /// "Activity"/"Settings"), so its destinations are reachable from it.
    func test_iPadRendersSidebarNotTabView() throws {
        let app = launch(tab: "home")
        // The seeded Home shell drew (the add-server affordance proves pods +
        // paired state); now assert the iPad chrome around it.
        XCTAssertTrue(
            app.buttons["home-add-server"].waitForExistence(timeout: 20),
            "Smoke-mode Home should render the seeded paired shell on iPad."
        )
        gymShot(app, "ipad-home")
        // The 280pt sidebar is the iPad-only branch of RootShell, tagged
        // `ipad-sidebar`. SwiftUI propagates an `.accessibilityIdentifier` on a
        // (non-container) VStack onto its leaf descendants, so the id lands on
        // the sidebar's rows/headers rather than a single Other — match ANY
        // descendant carrying it. Present here ⇒ the regular size class chose
        // iPadShell (the iPhone TabView shell never builds this view).
        XCTAssertTrue(
            sidebarElement(app).waitForExistence(timeout: 10),
            "The iPad regular-size-class shell should render the 280pt sidebar."
        )
        // And NOT the iPhone TabView: the compact shell is a SwiftUI TabView
        // whose `.tabItem`s surface as a UIKit tab bar. The iPad sidebar is a
        // plain HStack with no tab bar — so its absence distinguishes the two.
        XCTAssertEqual(
            app.tabBars.count, 0,
            "The iPad shell uses a sidebar, so there should be NO bottom TabView tab bar."
        )
        gymShot(app, "ipad-sidebar")
    }

    /// Any element carrying the `ipad-sidebar` identifier (the id propagates to
    /// the sidebar's leaf rows/headers — see test above).
    private func sidebarElement(_ app: XCUIApplication) -> XCUIElement {
        return app.descendants(matching: .any).matching(identifier: "ipad-sidebar").firstMatch
    }

    /// The sidebar's destination rows drive navigation in place of tab items:
    /// tapping "Services" in the sidebar swaps the content pane to the Services
    /// shell (nav title "Services") — proving the sidebar is the live navigator,
    /// not decoration. (The sidebar rows' a11y labels are the destination titles.)
    func test_iPadSidebarNavigatesContentPane() throws {
        let app = launch(tab: "home")
        XCTAssertTrue(
            sidebarElement(app).waitForExistence(timeout: 20),
            "The iPad sidebar should render."
        )
        // The "Services" sidebar row: a Button carrying BOTH the propagated
        // `ipad-sidebar` id (so it's the sidebar row, not a content-pane control)
        // AND the exact destination label.
        let servicesRow = app.buttons
            .matching(NSPredicate(format: "identifier == %@ AND label == %@", "ipad-sidebar", "Services"))
            .firstMatch
        XCTAssertTrue(servicesRow.waitForExistence(timeout: 10), "The sidebar should offer a Services destination row.")
        servicesRow.tap()
        XCTAssertTrue(
            app.navigationBars["Services"].waitForExistence(timeout: 15),
            "Tapping the Services sidebar row should swap the content pane to the Services shell."
        )
        gymShot(app, "ipad-services-pane")
    }

    // ─── D8 — the reading column constrains content width ─────────────────────

    /// On a wide iPad content pane the hero screens clamp their inner column to
    /// `FSLayout.readingMaxWidth` (640pt) and center it (`.fsReadingColumn()`),
    /// so the rows/cards never stretch edge-to-edge. Assert a reading-column-
    /// bounded control (`home-add-server`, which lives inside the clamped VStack)
    /// is BOTH (a) no wider than the reading measure (≤ ~660pt, a small slack
    /// over 640 for padding/rounding) and (b) narrower than the window — i.e. the
    /// clamp actually bit on this wide pane. (On a compact iPhone pane the clamp
    /// is a no-op; this assertion is meaningful only on the iPad destination.)
    func test_iPadReadingColumnConstrainsWidth() throws {
        let app = launch(tab: "home")
        let addServer = app.buttons["home-add-server"]
        XCTAssertTrue(addServer.waitForExistence(timeout: 20), "Home should render the add-server affordance.")
        gymShot(app, "ipad-reading-column")

        let windowWidth = app.windows.firstMatch.frame.width
        let columnWidth = addServer.frame.width
        // The reading measure is 640pt; allow a little slack for horizontal
        // padding + sub-pixel rounding so the assertion is robust, but still
        // far below a full-width iPad pane (≥ ~744pt content pane on an 11").
        XCTAssertLessThanOrEqual(
            columnWidth, 680,
            "The reading column should clamp content to ~640pt; measured \(columnWidth)pt."
        )
        // And the clamp must actually be biting — the column is meaningfully
        // narrower than the whole iPad window (else we're not on the wide pane).
        XCTAssertLessThan(
            columnWidth, windowWidth - 80,
            "On the wide iPad pane the reading column (\(columnWidth)pt) should be clearly narrower than the window (\(windowWidth)pt)."
        )
    }

    // ─── D8 — inline (not large) titles in the regular size class ─────────────

    /// In the regular size class the hero screens set `.navigationBarTitleDisplayMode(.inline)`
    /// (the sidebar already names the destination, so a giant in-content large
    /// title is redundant). An inline title sits INSIDE the nav bar; a `.large`
    /// title additionally renders a big out-of-bar title element. Assert the
    /// nav bar carries the inline "Home" title AND that there is no second,
    /// large, out-of-navbar "Home" title element — i.e. the title is inline.
    func test_iPadUsesInlineNavTitles() throws {
        let app = launch(tab: "home")
        let homeNavBar = app.navigationBars["Home"]
        XCTAssertTrue(homeNavBar.waitForExistence(timeout: 20), "The Home content pane should carry a nav bar titled Home.")
        // The inline title lives inside the nav bar. A large-title layout would
        // ALSO place a "Home" static text OUTSIDE the nav bar (the big collapsing
        // header). Assert no such out-of-navbar large title exists: every "Home"
        // static text that is a title should be within the nav bar's frame.
        let navFrame = homeNavBar.frame
        let homeTitles = app.staticTexts.matching(NSPredicate(format: "label == %@", "Home")).allElementsBoundByIndex
        let largeOutOfBar = homeTitles.contains { el in
            // Out-of-navbar AND tall ⇒ a large title. (Sidebar rows are inside
            // `ipad-sidebar`, far left; the inline title is inside navFrame.)
            !navFrame.contains(el.frame.origin) && el.frame.height > navFrame.height
        }
        XCTAssertFalse(
            largeOutOfBar,
            "The iPad hero screen should use an INLINE nav title, not a large out-of-navbar title."
        )
        gymShot(app, "ipad-inline-title")
    }
}
