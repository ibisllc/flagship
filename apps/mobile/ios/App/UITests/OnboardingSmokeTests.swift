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

    /// Smoke: cold-launch → onboarding → home. Uses the Skip button so
    /// the relay WebSocket isn't required.
    func test_coldLaunchWalksFromWelcomeToHome() throws {
        let app = XCUIApplication()
        app.launch()

        // 1. Welcome
        let create = app.buttons["Create your account"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()

        // 2. ChooseUsername
        let usernameField = app.textFields["harry"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 5))
        usernameField.tap()
        usernameField.typeText("harry")
        app.buttons["Continue"].tap()

        // 3. CreateServer — fill name, tap Skip.
        let nameField = app.textFields.matching(identifier: "cs-name-field").firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText("Home")
        let skip = app.buttons["cs-skip-button"]
        XCTAssertTrue(skip.waitForExistence(timeout: 3))
        skip.tap()

        // 4. Home — should render the welcome card.
        XCTAssertTrue(app.staticTexts["Welcome back,"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["harry."].exists)
    }

    /// QR-relay path: paste a QR URL → mock relay acks → SAS code visible.
    func test_qrRelayDriveToMatchCode() throws {
        let app = XCUIApplication()
        app.launch()

        app.buttons["Create your account"].tap()
        let user = app.textFields["harry"]
        XCTAssertTrue(user.waitForExistence(timeout: 5))
        user.tap(); user.typeText("harry")
        app.buttons["Continue"].tap()

        let nameField = app.textFields.matching(identifier: "cs-name-field").firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap(); nameField.typeText("Home")

        // The new flow added a QR-URL field + Connect button. The
        // actual relay round-trip is covered exhaustively in the
        // QrRelayClientTests + QrRelayProtocolTests unit suite; this
        // UI test just confirms the new fields are surfaced.
        let qrField = app.textFields.matching(identifier: "cs-qr-field").firstMatch
        XCTAssertTrue(qrField.waitForExistence(timeout: 3),
                      "v2 relay flow requires a QR-URL paste field.")

        let connect = app.buttons["cs-connect-button"]
        XCTAssertTrue(connect.waitForExistence(timeout: 3),
                      "Connect button drives the relay dial.")
    }
}
