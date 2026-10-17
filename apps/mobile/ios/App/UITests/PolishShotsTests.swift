import XCTest

/// Polish review driver: visits the main screens over the mock clients and
/// writes one PNG per screen. Opt-in (skipped unless `POLISH_DIR` is set), so
/// the gym suites never run it. Appearance and Dynamic Type are set on the
/// simulator before the run (`simctl ui … appearance|content_size`), so the
/// same pass covers light/dark and every text size.
///
///   TEST_RUNNER_POLISH_DIR=/abs/out TEST_RUNNER_POLISH_TAG=phone-light-L \
///   xcodebuild test-without-building … -only-testing:FlagshipAppUITests/PolishShotsTests
final class PolishShotsTests: GymSweepCase {

    private var outDir: URL?
    private var tag = ""

    override func setUpWithError() throws {
        try super.setUpWithError()
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["POLISH_DIR"], !dir.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_POLISH_DIR to capture polish screenshots.")
        }
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: outDir!, withIntermediateDirectories: true)
        tag = env["POLISH_TAG"] ?? "shot"
        if UIDevice.current.userInterfaceIdiom == .pad, env["POLISH_PORTRAIT"] == nil {
            XCUIDevice.shared.orientation = .landscapeLeft
        }
    }

    private func snap(_ name: String) {
        sleep(1)
        let image = XCUIApplication().screenshot()
        let a = XCTAttachment(screenshot: image)
        a.name = name
        a.lifetime = .deleteOnSuccess
        add(a)
        if let outDir {
            try? image.pngRepresentation.write(to: outDir.appendingPathComponent("\(name)-\(tag).png"))
        }
    }

    private func go(_ app: XCUIApplication, _ destination: String) {
        let tab = app.tabBars.buttons[destination]
        if tab.exists { tab.tap(); return }
        let row = app.buttons
            .matching(NSPredicate(format: "identifier == %@ AND label == %@", "ipad-sidebar", destination)).firstMatch
        if row.waitForExistence(timeout: 5) { row.tap() } else { app.buttons[destination].firstMatch.tap() }
    }

    private func scrolled(_ app: XCUIApplication, _ name: String, pages: Int = 2) {
        for i in 1...pages {
            app.swipeUp()
            snap("\(name)-scroll\(i)")
        }
    }

    private func back(_ app: XCUIApplication) {
        let b = app.navigationBars.buttons.element(boundBy: 0)
        if b.exists { b.tap() }
        sleep(1)
    }

    func test_welcomeAndConnect() throws {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-onboarding"]
        app.launch()
        XCTAssertTrue(app.buttons["welcome-connect"].waitForExistence(timeout: 20))
        snap("01-welcome")
        app.buttons["welcome-connect"].tap()
        sleep(1)
        snap("02-connect")
    }

    func test_lock() throws {
        let app = launch(tab: "home", ["-smoke-locked"])
        _ = app.buttons.firstMatch.waitForExistence(timeout: 20)
        snap("03-lock")
    }

    func test_homeAndServer() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        snap("10-home")
        scrolled(app, "10-home", pages: 1)
        app.swipeDown()
        app.buttons["home-add-server"].tap()
        sleep(1)
        snap("11-home-add-menu")
        let new = app.buttons.matching(identifier: "home-add-new-server").firstMatch
        if new.waitForExistence(timeout: 5) {
            new.tap()
            sleep(2)
            snap("12-create-server")
            scrolled(app, "12-create-server", pages: 2)
            back(app)
        }
        openServerPage(app, named: "Home")
        snap("13-server")
        scrolled(app, "13-server", pages: 4)
    }

    func test_servicesAndApp() throws {
        let app = launch(tab: "apps")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "plants")).firstMatch
            .waitForExistence(timeout: 20))
        snap("20-services")
        openApp(app, named: "Plants")
        snap("21-app")
        scrolled(app, "21-app", pages: 4)
    }

    func test_activity() throws {
        let app = launch(tab: "activity")
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 20))
        sleep(2)
        snap("30-activity")
        for section in ["account", "server", "approvals"] {
            let s = app.buttons["activity-section-\(section)"]
            if s.waitForExistence(timeout: 5) {
                s.tap()
                sleep(1)
                snap("31-activity-\(section)")
            }
        }
    }

    func test_settings() throws {
        let app = launch(tab: "settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        snap("40-settings")
        scrolled(app, "40-settings", pages: 3)
    }

    /// Every Settings row's screen, one after another.
    func test_settingsScreens() throws {
        let app = launch(tab: "settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20))
        let rows = ["Account security", "AI keys", "Cloud recovery", "Back up account key", "Profiles", "Remote",
                    "Companion requests", "Open secured sessions", "Process URL", "Peer backup", "Privacy", "About Flagship"]
        for (i, title) in rows.enumerated() {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
            var tries = 0
            while !(row.exists && row.isHittable) && tries < 12 { (tries < 6 ? app.swipeUp() : app.swipeDown()); tries += 1 }
            guard row.exists, row.isHittable else { continue }
            row.tap()
            sleep(2)
            snap(String(format: "50-settings-%02d-%@", i, title.replacingOccurrences(of: " ", with: "-")))
            back(app)
        }
    }

    /// The app page's sub-screens and the server's share card.
    func test_appAndServerSubscreens() throws {
        let app = launch(tab: "apps")
        openApp(app, named: "Plants")
        for (id, name) in [("service-detail-open-access", "60-app-access-control")] {
            let b = app.buttons[id]
            if reveal(app, b) { b.tap(); sleep(2); snap(name); scrolled(app, name, pages: 2); back(app) }
        }
        back(app)
        go(app, "Home")
        openServerPage(app, named: "Home")
        let share = any(app, "share-server-card")
        if reveal(app, share) { snap("61-server-share-card") }
    }
}
