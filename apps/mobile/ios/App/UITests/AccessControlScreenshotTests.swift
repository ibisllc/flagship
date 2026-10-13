import XCTest

/// Access control screenshots (docs/service-access-gating.md, "Open mode +
/// members") from the gym's smoke fixture: the service page's row, the screen
/// in Open to all, the Members only confirmation and Members only with the
/// add-group card. Opt-in (skipped unless `ACCESS_SHOT_DIR` is set):
///
///   TEST_RUNNER_ACCESS_SHOT_DIR=/abs/out xcodebuild test ... \
///     -only-testing:FlagshipAppUITests/AccessControlScreenshotTests
final class AccessControlScreenshotTests: XCTestCase {
    private var outDir: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let dir = ProcessInfo.processInfo.environment["ACCESS_SHOT_DIR"], !dir.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_ACCESS_SHOT_DIR to capture Access control screenshots.")
        }
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    }

    private func shot(_ name: String) {
        sleep(1)
        let image = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: image)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        try? image.pngRepresentation.write(to: outDir.appendingPathComponent("\(name).png"))
    }

    func test_accessControl() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", "apps", "-smoke-access-fixture"]
        app.launch()

        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "plants")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the demo Plants app should be listed")
        row.tap()

        let access = app.buttons["service-detail-open-access"]
        var tries = 0
        while !access.isHittable && tries < 8 { app.swipeUp(); tries += 1 }
        if !access.exists { shot("access-ios-debug") }
        XCTAssertTrue(access.exists, "the service page should show the Access control row")
        shot("access-ios-service-page")
        access.tap()

        XCTAssertTrue(app.navigationBars["Access control"].waitForExistence(timeout: 15))
        let toggle = app.segmentedControls["service-access-restrict-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["service-access-role-sam-bright-maple--plants"].waitForExistence(timeout: 15),
                      "the members list should show ranks")
        shot("access-ios-open")

        toggle.buttons["Members only"].tap()
        let confirm = app.sheets.buttons["Members only"].firstMatch
        if confirm.waitForExistence(timeout: 5) {
            shot("access-ios-confirm")
            confirm.tap()
        } else {
            let second = app.buttons.matching(NSPredicate(format: "label == %@", "Members only")).element(boundBy: 1)
            XCTAssertTrue(second.waitForExistence(timeout: 5))
            shot("access-ios-confirm")
            second.tap()
        }
        XCTAssertTrue(toggle.buttons["Members only"].waitForExistence(timeout: 5))
        sleep(2)
        XCTAssertTrue(toggle.buttons["Members only"].isSelected, "the box took the change")
        shot("access-ios-members-only")

        app.buttons["service-access-add-group"].tap()
        XCTAssertTrue(app.textFields["service-access-name-field"].waitForExistence(timeout: 5))
        app.buttons["service-access-new-role"].tap()
        sleep(1)
        shot("access-ios-rank-menu")
    }
}
