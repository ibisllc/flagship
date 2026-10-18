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

        // 5. The empty Home — the device that opened the account holds the
        // admin root, so it gets Add/Restore server; create the first one.
        let addFirst = app.buttons["home-add-server"]
        XCTAssertTrue(addFirst.waitForExistence(timeout: 15), "A new account lands on Home with no servers.")
        addFirst.tap()
        app.chooseAddNewServer()

        // 6. CreateServer — name it and advance through the design pages.
        let nameField = app.textFields.matching(identifier: "cs-name-field").firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 10))
        app.typeServerName(nameField, "Home")

        let next = app.buttons["cs-next-button"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        next.tap()

        app.chooseBackupPolicy()
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

    // MARK: - Connect to an existing account

    private func launchToConnectPage() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-smoke-onboarding"]
        app.launch()
        XCTAssertTrue(app.buttons["welcome-create"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["I already have an account"].exists)
        XCTAssertFalse(app.buttons["Join with a pairing code"].exists)
        let connect = app.buttons["welcome-connect"]
        XCTAssertTrue(connect.exists, "Welcome offers one Connect to an existing account.")
        // The same footer as the app lock: the secondary right below the
        // primary, then Patent Pending at the bottom.
        let patent = app.staticTexts["patent-pending"]
        XCTAssertTrue(patent.exists)
        XCTAssertLessThan(app.buttons["welcome-create"].frame.maxY, connect.frame.minY)
        XCTAssertLessThan(connect.frame.maxY, patent.frame.minY)
        gymShot(app, "welcome")
        connect.tap()
        XCTAssertTrue(app.staticTexts["connect-account"].waitForExistence(timeout: 10))
        return app
    }

    private func gymShot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "gym-screenshot:\(name)"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// One page holds both halves: the account name above the "or", the
    /// pairing code (scan + paste) below.
    func test_connectPageHoldsSignInAndPairing() throws {
        let app = launchToConnectPage()
        XCTAssertTrue(app.textFields.matching(identifier: "connect-name-field").firstMatch.exists)
        XCTAssertTrue(app.buttons["connect-name-continue"].exists)
        XCTAssertTrue(app.otherElements["connect-or"].exists || app.staticTexts["connect-or"].exists)
        XCTAssertTrue(app.buttons["connect-scan"].exists)
        XCTAssertTrue(app.textFields.matching(identifier: "connect-pair-field").firstMatch.exists)
        XCTAssertTrue(app.buttons["connect-pair-continue"].exists)
        gymShot(app, "connect-account")

        // An account name in the code field gets a sentence, and no join.
        let code = app.textFields.matching(identifier: "connect-pair-field").firstMatch
        code.tap()
        code.typeText("bright-maple")
        app.buttons["connect-pair-continue"].tap()
        XCTAssertTrue(app.staticTexts["That looks like an account name. Type it under Sign in with your account name."].waitForExistence(timeout: 5))
    }

    /// The sign-in half: the mock directory's demo account opens the sandbox.
    func test_connectSignInWithAccountName() throws {
        let app = launchToConnectPage()
        let name = app.textFields.matching(identifier: "connect-name-field").firstMatch
        name.tap()
        name.typeText("demo")
        app.buttons["connect-name-continue"].tap()
        XCTAssertTrue(
            app.tabBars.buttons["Home"].waitForExistence(timeout: 20)
                || app.buttons["Home"].waitForExistence(timeout: 1),
            "Signing in to the demo account lands in the app."
        )
        gymShot(app, "connect-demo-home")
    }

    /// A pairing link pasted where the account name goes opens the join flow.
    func test_connectPairingLinkInNameFieldOpensJoin() throws {
        let app = launchToConnectPage()
        let name = app.textFields.matching(identifier: "connect-name-field").firstMatch
        name.tap()
        name.typeText("https://flagshipserver.com/join?sid=gym123&pk=\(String(repeating: "A", count: 43))")
        app.buttons["connect-name-continue"].tap()
        XCTAssertTrue(
            app.navigationBars["Join an account"].waitForExistence(timeout: 10),
            "A pairing link in the name field joins instead of signing in."
        )
        gymShot(app, "connect-link-to-join")
    }

    /// Scan a code opens the in-app scanner.
    func test_connectScanOpensScanner() throws {
        let app = launchToConnectPage()
        app.buttons["connect-scan"].tap()
        XCTAssertTrue(app.navigationBars["Join an account"].waitForExistence(timeout: 10))
        gymShot(app, "connect-scanner")
    }
}
