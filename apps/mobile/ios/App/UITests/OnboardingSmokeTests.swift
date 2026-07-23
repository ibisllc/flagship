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

    /// Smoke: cold-launch → onboarding → the three-step server designer
    /// reaches the delivery chooser. Builder pairing is the QR-based option;
    /// the retired homepage relay is no longer exposed.
    func test_coldLaunchReachesDeliveryChooser() throws {
        let app = XCUIApplication()
        app.launch()

        // 1. Welcome
        let create = app.buttons["Create your account"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()

        // 2. SuggestUsername — accept the auto-suggested random handle (the
        //    mock client suggests one instantly; there's no typed field now).
        let acctContinue = app.buttons["Continue"]
        XCTAssertTrue(acctContinue.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: acctContinue)
        waitForExpectations(timeout: 5)
        acctContinue.tap()

        // 3. CreateServer — fill name and advance through the three design pages.
        let nameField = app.textFields.matching(identifier: "cs-name-field").firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText("Home")

        let next = app.buttons["cs-next-button"]
        XCTAssertTrue(next.waitForExistence(timeout: 3))
        next.tap()
        XCTAssertTrue(next.waitForExistence(timeout: 3))
        next.tap()

        let cont = app.buttons["cs-continue-button"]
        XCTAssertTrue(cont.waitForExistence(timeout: 3))
        cont.tap()

        let pair = app.buttons["cs-delivery-pair"]
        XCTAssertTrue(pair.waitForExistence(timeout: 3),
                      "Delivery chooser must offer builder QR/code pairing.")
    }
}
