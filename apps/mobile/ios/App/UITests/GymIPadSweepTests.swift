import XCTest

/// GYM iOS button sweep (mock tier), iPad: only where the iPad differs from
/// the iPhone (the iPhone classes cover shared behaviour). The regular size
/// class draws a sidebar instead of the tab bar, runs landscape only, shows
/// confirmation dialogs as popovers (no Cancel button: a tap outside
/// dismisses) and sheets as page sheets narrower than the window. The harness
/// contains "GymIPad", so the gym runs this class on an iPad.
final class GymIPadSweepTests: GymSweepCase {

    override func setUpWithError() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad layout checks run on an iPad only.")
        try super.setUpWithError()
    }

    /// A sidebar destination row (the rows carry the sidebar's identifier).
    private func sidebarRow(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "ipad-sidebar", title)).firstMatch
    }

    private func window(_ app: XCUIApplication) -> CGRect { app.windows.firstMatch.frame }

    /// The title sits inside the nav bar: no tall title text outside it.
    private func assertInlineTitle(_ app: XCUIApplication, _ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let bar = app.navigationBars[title]
        XCTAssertTrue(bar.waitForExistence(timeout: 15), "The \(title) pane should show its nav bar.", file: file, line: line)
        let large = app.staticTexts.matching(NSPredicate(format: "label == %@", title)).allElementsBoundByIndex.contains {
            !bar.frame.contains($0.frame.origin) && $0.frame.height > bar.frame.height
                && $0.identifier != "ipad-sidebar"
        }
        XCTAssertFalse(large, "\(title) should use an inline title on iPad.", file: file, line: line)
    }

    /// The sidebar header names the account and how many servers it has.
    func test_sidebarHeaderNamesTheAccountAndItsServers() throws {
        let app = launch(tab: "home")
        XCTAssertTrue(sidebarRow(app, "Home").waitForExistence(timeout: 20), "The iPad shell draws the sidebar.")
        XCTAssertTrue(app.staticTexts["Flagship"].exists)
        XCTAssertTrue(app.staticTexts["bright-maple"].exists, "The sidebar names the account.")
        XCTAssertTrue(app.staticTexts["3 servers"].exists, "…and counts its servers (Home, Office, Music).")
        XCTAssertEqual(app.tabBars.count, 0, "No tab bar on iPad.")
        shot(app, "ipad-sidebar-header")
    }

    /// Each sidebar row swaps the content pane to its destination (inline
    /// titles, reading column), and Home comes back from the sidebar.
    func test_sidebarVisitsEveryDestination() throws {
        let app = launch(tab: "home")
        XCTAssertTrue(sidebarRow(app, "Services").waitForExistence(timeout: 20))

        sidebarRow(app, "Services").tap()
        assertInlineTitle(app, "Services")
        XCTAssertTrue(app.buttons["Build another service"].waitForExistence(timeout: 15), "Services' content shows.")

        sidebarRow(app, "Activity").tap()
        assertInlineTitle(app, "Activity")

        sidebarRow(app, "Settings").tap()
        assertInlineTitle(app, "Settings")
        let security = app.buttons["settings-open-account-security"]
        XCTAssertTrue(reveal(app, security), "Settings' rows show.")
        XCTAssertLessThanOrEqual(security.frame.width, 680, "Settings keeps to the reading column.")
        shot(app, "ipad-settings-pane")

        sidebarRow(app, "Home").tap()
        assertInlineTitle(app, "Home")
        XCTAssertTrue(podRow(app, named: "Office").waitForExistence(timeout: 15), "Home lists the servers again.")
        XCTAssertTrue(sidebarRow(app, "Settings").exists, "The sidebar stays while the pane changes.")
    }

    /// As each iPhone tab does, each sidebar destination keeps its place:
    /// a server page opened on Home is still open after a visit to Services.
    func test_sidebarDestinationKeepsItsPlace() throws {
        let app = launch(tab: "home")
        openServerPage(app, named: "Office")
        XCTAssertTrue(sidebarRow(app, "Services").waitForExistence(timeout: 10))
        sidebarRow(app, "Services").tap()
        XCTAssertTrue(app.navigationBars["Services"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.serverPageBackButton(named: "Office").exists, "Services covers Home's pane.")
        sidebarRow(app, "Home").tap()
        XCTAssertTrue(app.serverPageBackButton(named: "Office").waitForExistence(timeout: 15),
                      "Back on Home, the Office page is still open.")
        shot(app, "ipad-home-kept-place")
        app.serverPageBackButton(named: "Office").tap()
        XCTAssertTrue(podRow(app, named: "Office").waitForExistence(timeout: 15), "Back goes to the server list.")
    }

    /// The app runs landscape only on a tablet-sized screen, and stays so
    /// when the device turns to portrait.
    func test_runsLandscapeOnly() throws {
        let app = launch(tab: "home")
        XCTAssertTrue(sidebarRow(app, "Home").waitForExistence(timeout: 20))
        XCTAssertGreaterThan(window(app).width, window(app).height, "An iPad shows the app in landscape.")
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        XCTAssertTrue(sidebarRow(app, "Home").waitForExistence(timeout: 5))
        XCTAssertGreaterThan(window(app).width, window(app).height, "Turning the iPad doesn't rotate the app to portrait.")
        shot(app, "ipad-landscape")
    }

    /// Add/Import a server is a popover on iPad: no Cancel button, a tap
    /// outside closes it without going anywhere, and its choices still work.
    func test_addImportIsAPopoverClosedByTappingOutside() throws {
        let app = launch(tab: "home")
        let add = app.buttons["home-add-server"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let create = app.buttons.matching(identifier: "home-add-new-server").firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 10), "The choices show.")
        XCTAssertTrue(app.buttons.matching(identifier: "home-import-backup").firstMatch.exists)
        XCTAssertFalse(button(app, "Cancel").exists, "A popover has no Cancel button.")
        XCTAssertLessThan(create.frame.width, window(app).width / 2, "The choices sit in a popover, not an action sheet.")
        shot(app, "ipad-add-import-popover")

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.92)).tap()
        waitGone(create)
        XCTAssertTrue(app.navigationBars["Home"].exists, "Closing the popover goes nowhere.")
        XCTAssertFalse(app.textFields["cs-name-field"].exists)

        add.tap()
        app.chooseAddNewServer()
        XCTAssertTrue(app.textFields["cs-name-field"].waitForExistence(timeout: 15), "Create a new server still opens the form.")
    }

    /// A sheet (Backup/clone server) is a page sheet narrower than the
    /// window, and Done closes it.
    func test_sheetIsAPageSheet() throws {
        let app = launch(tab: "home")
        openServerPage(app, named: "Home")
        let backup = app.buttons["sd-backup-server"]
        XCTAssertTrue(reveal(app, backup))
        backup.tap()
        XCTAssertTrue(app.staticTexts["backup-suggested-passcode"].waitForExistence(timeout: 15), "The backup sheet opens.")
        let done = app.navigationBars.buttons["Done"].firstMatch
        XCTAssertTrue(done.exists)
        let sheetBar = app.navigationBars.containing(.button, identifier: "Done").firstMatch
        XCTAssertLessThan(sheetBar.frame.width, window(app).width * 0.8, "On iPad the sheet doesn't fill the window.")
        XCTAssertGreaterThan(sheetBar.frame.minX, 0, "…and stands clear of its left edge.")
        shot(app, "ipad-page-sheet")
        done.tap()
        waitGone(app.staticTexts["backup-suggested-passcode"])
        XCTAssertTrue(app.serverPageBackButton(named: "Home").exists, "Done returns to the server page.")
    }

    /// The pod switcher opens as a popover anchored under it, and picking a
    /// server filters Services to it.
    func test_podSwitcherPopoverPicksAServer() throws {
        let app = launch(tab: "apps")
        let switcher = app.buttons["pod-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 20))
        switcher.tap()
        let menu = any(app, "pod-switcher-menu")
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        XCTAssertLessThan(menu.frame.width, 300, "A small popover, not a sheet.")
        XCTAssertGreaterThanOrEqual(menu.frame.minY, switcher.frame.maxY - 1, "Anchored under the switcher.")
        shot(app, "ipad-pod-switcher")
        let office = menu.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Office")).firstMatch
        XCTAssertTrue(office.exists)
        office.tap()
        waitGone(menu)
        wait(switcher, "label CONTAINS 'Office'")
    }
}
