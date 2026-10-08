import XCTest

/// App Store screenshot driver. Drives the REAL reviewer path — a fresh install
/// signs in to a live demo account through "I already have an account" — then
/// visits each primary destination and writes a full-resolution PNG per screen.
///
/// Opt-in only (skipped unless `SHOT_USER` is set), so the gym suites never run
/// it. xcodebuild forwards `TEST_RUNNER_`-prefixed variables to the runner:
///
///   TEST_RUNNER_SHOT_USER=<demo username> TEST_RUNNER_SHOT_DIR=/abs/out \
///   xcodebuild test -project apps/mobile/ios/App/FlagshipApp.xcodeproj \
///     -scheme FlagshipApp -destination 'platform=iOS Simulator,id=<udid>' \
///     -only-testing:FlagshipAppUITests/AppStoreScreenshotTests
final class AppStoreScreenshotTests: XCTestCase {

    private var outDir: URL?
    private var prefix = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let user = env["SHOT_USER"], !user.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_SHOT_USER to capture App Store screenshots.")
        }
        if let dir = env["SHOT_DIR"], !dir.isEmpty {
            outDir = URL(fileURLWithPath: dir, isDirectory: true)
            try? FileManager.default.createDirectory(at: outDir!, withIntermediateDirectories: true)
        }
        prefix = env["SHOT_PREFIX"] ?? ""
        // The iPad app is landscape-only.
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
        }
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        // Let springs, skeletons and async loads settle before the capture.
        sleep(2)
        let image = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let outDir {
            try? image.pngRepresentation.write(to: outDir.appendingPathComponent("\(prefix)\(name).png"))
        }
    }

    /// iPhone navigates by tab bar; the iPad shell by sidebar rows.
    private func go(_ app: XCUIApplication, _ destination: String) {
        let tab = app.tabBars.buttons[destination]
        if tab.exists {
            tab.tap()
            return
        }
        let row = app.buttons
            .matching(NSPredicate(format: "identifier == %@ AND label == %@", "ipad-sidebar", destination))
            .firstMatch
        if row.waitForExistence(timeout: 5) {
            row.tap()
        } else {
            app.buttons[destination].firstMatch.tap()
        }
    }

    func test_captureReviewerJourney() throws {
        let user = ProcessInfo.processInfo.environment["SHOT_USER"]!
        let app = XCUIApplication()
        app.launch()

        let haveAccount = app.buttons["I already have an account"]
        XCTAssertTrue(haveAccount.waitForExistence(timeout: 15))
        shot(app, "01-welcome")
        haveAccount.tap()

        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(user)
        app.buttons["join-continue"].tap()

        XCTAssertTrue(
            app.buttons["home-add-server"].waitForExistence(timeout: 90),
            "Signing in to the demo account should land on a Home with its server."
        )
        // Give the live directory poll a moment to mark the box online.
        sleep(6)
        shot(app, "02-home")

        go(app, "Services")
        sleep(3)
        shot(app, "03-services")

        go(app, "Activity")
        sleep(3)
        shot(app, "04-activity")

        go(app, "Settings")
        sleep(2)
        shot(app, "05-settings")

        go(app, "Home")
        if let row = firstServerRow(app) {
            row.tap()
            sleep(5)
            shot(app, "06-server-detail")
        }
    }

    /// Showcase set: the same real UI over the built-in smoke-mode fixtures
    /// (three servers, installed services, deploy history), so marketing
    /// shots show a lived-in account rather than one empty demo box.
    func test_captureShowcase() throws {
        let env = ProcessInfo.processInfo.environment
        let app = XCUIApplication()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", "home", "-smoke-recovery-enrolled",
                               "-smoke-username", env["SHOT_HANDLE"] ?? "bright-maple"]
        app.launch()

        XCTAssertTrue(app.buttons["home-add-server"].waitForExistence(timeout: 20))
        shot(app, "10-showcase-home")

        if let row = firstServerRow(app) {
            row.tap()
            sleep(3)
            shot(app, "11-showcase-server")
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }

        go(app, "Services")
        sleep(2)
        shot(app, "12-showcase-services")

        go(app, "Activity")
        sleep(2)
        shot(app, "13-showcase-activity")

        go(app, "Settings")
        sleep(2)
        shot(app, "14-showcase-settings")

        go(app, "Home")
        let build = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Build a service")).firstMatch
        if build.waitForExistence(timeout: 5) {
            build.tap()
            sleep(3)
            shot(app, "15-showcase-build")
        }
    }

    private func firstServerRow(_ app: XCUIApplication) -> XCUIElement? {
        let byId = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "pod-card")).firstMatch
        if byId.waitForExistence(timeout: 5) { return byId }
        let byPill = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Online")).firstMatch
        return byPill.exists ? byPill : nil
    }
}
