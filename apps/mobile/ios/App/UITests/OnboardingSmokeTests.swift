import XCTest

/// Smoke test for the cold-launch path: Welcome → Create → SuggestUsername →
/// Open account → Secure your account (skipped) → the empty Home → Add your
/// first server → the three-page server designer → the delivery chooser.
///
/// `-smoke-onboarding` starts unpaired with no keys left from an earlier run
/// and talks to the mock clients only, so nothing reaches a real `.com`.
final class OnboardingSmokeTests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func test_coldLaunchReachesDeliveryChooser() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-smoke-onboarding"]
        app.launch()

        // 1. Welcome
        let create = app.buttons["Create your account"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        create.tap()

        // 2. SuggestUsername — accept the suggested random handle.
        let acctContinue = app.buttons["Continue"]
        XCTAssertTrue(acctContinue.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: acctContinue)
        waitForExpectations(timeout: 10)
        acctContinue.tap()

        // 3. Open account — the device name is prefilled; create the account keys.
        let open = app.buttons["open-account-continue"]
        XCTAssertTrue(open.waitForExistence(timeout: 10), "Continue on the handle should open the account step.")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: open)
        waitForExpectations(timeout: 10)
        open.tap()

        // 4. Secure your account — skip behind its warning.
        let skip = app.buttons["secure-account-skip"]
        XCTAssertTrue(skip.waitForExistence(timeout: 20), "A new account should be offered a backup next.")
        skip.tap()
        let skipAnyway = app.buttons.matching(identifier: "secure-account-skip-anyway").firstMatch
        XCTAssertTrue(skipAnyway.waitForExistence(timeout: 5), "Skipping should warn first.")
        skipAnyway.tap()

        // 5. The empty Home — add the first server.
        let addFirst = app.buttons["home-add-first-server"]
        XCTAssertTrue(addFirst.waitForExistence(timeout: 15), "A new account lands on Home with no servers.")
        addFirst.tap()

        // 6. CreateServer — name it and advance through the design pages.
        let nameField = app.textFields.matching(identifier: "cs-name-field").firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 10))
        nameField.tap()
        nameField.typeText("Home")

        let next = app.buttons["cs-next-button"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()

        let cont = app.buttons["cs-continue-button"]
        XCTAssertTrue(cont.waitForExistence(timeout: 5))
        cont.tap()

        let pair = app.buttons["cs-delivery-pair"]
        XCTAssertTrue(pair.waitForExistence(timeout: 5),
                      "Delivery chooser must offer builder QR/code pairing.")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "gym-screenshot:onboarding-delivery"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
