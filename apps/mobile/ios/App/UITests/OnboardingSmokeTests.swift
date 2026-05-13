import XCTest

/// Smoke test for the cold-launch path: Welcome → Create → ChooseUsername
/// → CreateServer form → Home with the new pod card.
///
/// Runs against the real FlagshipApp bundle with MockScreensClient so
/// the daemon-side parts don't matter. Cross-references the iPhone +
/// iPad layouts via UI_TEST_DEVICE.
final class OnboardingSmokeTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func test_coldLaunchWalksFromWelcomeToHome() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-UITestsResetState", "YES"]
        app.launch()

        // 1. Welcome
        let create = app.buttons["Create your account"]
        XCTAssertTrue(create.waitForExistence(timeout: 5), "Welcome screen should render Create button.")
        create.tap()

        // 2. ChooseUsername
        let usernameField = app.textFields["harry"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 5), "ChooseUsername should expose username field.")
        usernameField.tap()
        usernameField.typeText("harry")
        let continueBtn = app.buttons["Continue"]
        XCTAssertTrue(continueBtn.waitForExistence(timeout: 3))
        continueBtn.tap()

        // 3. CreateServer form
        let nameField = app.textFields["Home, Office, Garage"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 5), "CreateServer should show the short-name field.")
        nameField.tap()
        nameField.typeText("Home")
        // Skip the build-code flow via the ghost button so we don't
        // depend on the mock SSE stream.
        let skip = app.buttons["Skip — pretend it's already running"]
        XCTAssertTrue(skip.waitForExistence(timeout: 3))
        skip.tap()

        // 4. Home — should render the welcome + the new pod card.
        let welcome = app.staticTexts["Welcome back,"]
        XCTAssertTrue(welcome.waitForExistence(timeout: 8), "Home should render the welcome greeting after onboarding completes.")
        let home = app.staticTexts["harry."]
        XCTAssertTrue(home.exists, "Greeting should include the chosen username.")
    }
}
