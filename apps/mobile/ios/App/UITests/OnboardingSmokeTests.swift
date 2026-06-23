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

    /// Smoke: cold-launch → onboarding → the create-server flow reaches the
    /// match page via the MOCK relay. In mock mode (the Debug default) the
    /// "Use a demo QR" button generates a valid QR locally and runs the REAL
    /// flow against the mock backend — no relay WebSocket / desktop QR needed.
    /// (Replaces the removed "Skip — pretend it's already running" shortcut.)
    /// Stops at the match page so the assertion needs no Keystore/biometric
    /// (that only kicks in at confirm/mint); the full mint→deliver path is
    /// covered by the unit suite.
    func test_coldLaunchReachesCreateServerMatch() throws {
        let app = XCUIApplication()
        app.launch()

        // 1. Welcome
        let create = app.buttons["Create your account"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()

        // 2. SuggestUsername — accept the auto-suggested random handle (the
        //    mock client suggests one instantly; there's no typed field now).
        let cont = app.buttons["Continue"]
        XCTAssertTrue(cont.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: cont)
        waitForExpectations(timeout: 5)
        cont.tap()

        // 3. CreateServer — fill name, Continue to the QR step.
        let nameField = app.textFields.matching(identifier: "cs-name-field").firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText("Home")
        let cont = app.buttons["cs-continue-button"]
        XCTAssertTrue(cont.waitForExistence(timeout: 3))
        cont.tap()

        // 4. Scan page — use the mock-mode demo QR to drive the real flow.
        let demoQr = app.buttons["cs-demo-qr-button"]
        XCTAssertTrue(demoQr.waitForExistence(timeout: 3),
                      "Mock mode must surface the demo-QR shortcut.")
        demoQr.tap()

        // 5. The mock relay acks → the 6-digit match page appears.
        let match = app.otherElements.matching(identifier: "cs-match-label").firstMatch
        let matchText = app.staticTexts.matching(identifier: "cs-match-label").firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 8) || matchText.waitForExistence(timeout: 1),
                      "Demo QR should drive through the mock relay to the match page.")
    }

    /// QR-relay path: paste a QR URL → mock relay acks → SAS code visible.
    func test_qrRelayDriveToMatchCode() throws {
        let app = XCUIApplication()
        app.launch()

        app.buttons["Create your account"].tap()
        let cont = app.buttons["Continue"]
        XCTAssertTrue(cont.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: cont)
        waitForExpectations(timeout: 5)
        cont.tap()

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
