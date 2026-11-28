import XCTest

/// GYM iOS: "Choose your own account name" with a name held for a `.com` holder (owner, 2026-11-27), at an
/// accessibility text size. Launches `-smoke-onboarding` (mock clients, no keys) with the mock `.com`'s precheck
/// holding clou-dflare for cloudflare.com and failing acme's lookup (GymHeldNameClient). Typing a held name shows one
/// status line under the field, whole and above the keyboard; Pay stays off; Done closes the keyboard; Why? opens the
/// sheet. Nothing is created or paid for a held name.
final class GymChooseNameTests: GymSweepCase {

    private static let shotDir = "/private/tmp/claude-501/-Users-harrywinner-flagship/740cf826-70b9-453b-99a1-e9ade7ed2df8/scratchpad/shots"

    private func launchChooseName() -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = [
            "-smoke-onboarding",
            "-smoke-held-names", "clou-dflare=cloudflare.com",
            "-smoke-held-unchecked", "acme",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL",
        ]
        app.launch()
        let create = app.buttons["Create your account"]
        XCTAssertTrue(create.waitForExistence(timeout: 20), "A fresh launch shows Welcome.")
        create.tap()
        let chooseOwn = app.buttons["suggest-choose-own"]
        XCTAssertTrue(chooseOwn.waitForExistence(timeout: 15))
        wait(chooseOwn, "isEnabled == true", timeout: 15)
        chooseOwn.tap()
        return app
    }

    private func nameField(_ app: XCUIApplication) -> XCUIElement {
        let direct = app.textFields["choose-name-field"]
        if direct.waitForExistence(timeout: 5) { return direct }
        return app.descendants(matching: .any)["choose-name-field"].descendants(matching: .textField).firstMatch
    }

    /// The line is on screen in full: inside the window and above the keyboard when one is up.
    private func assertWhollyVisible(_ app: XCUIApplication, _ el: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(el.exists, file: file, line: line)
        let window = app.windows.firstMatch.frame
        let f = el.frame
        XCTAssertTrue(f.height > 0 && f.minY >= window.minY && f.maxY <= window.maxY, "\(f) should be inside \(window)", file: file, line: line)
        if app.keyboards.count > 0 {
            let kb = app.keyboards.firstMatch.frame
            XCTAssertLessThanOrEqual(f.maxY, kb.minY, "the line must not sit under the keyboard", file: file, line: line)
        }
        XCTAssertTrue(el.isHittable, file: file, line: line)
    }

    private func save(_ app: XCUIApplication, _ point: String) {
        shot(app, point)
        try? FileManager.default.createDirectory(atPath: Self.shotDir, withIntermediateDirectories: true)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(Self.shotDir)/ios-\(point).png"))
    }

    func test_heldNameShowsUnderTheFieldWithTheKeyboardUp_payStaysOff_doneClosesIt_whyOpensTheSheet() {
        let app = launchChooseName()
        let field = nameField(app)
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("clou-dflare")
        let status = app.staticTexts["choose-name-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10), "The precheck's hold shows under the field.")
        XCTAssertTrue(status.label.hasPrefix("Held for the owner of cloudflare.com until "), status.label)
        // Still typing: the keyboard stays up, and the line is above it, whole.
        assertWhollyVisible(app, status)
        let pay = app.buttons["choose-name-pay"]
        XCTAssertFalse(pay.isEnabled, "Pay stays off for a held name.")
        XCTAssertFalse(app.buttons["choose-name-show-code"].isEnabled, "Use a voucher stays off for a held name.")
        save(app, "held-keyboard-up")

        // Done on the keyboard closes it; the line is still whole.
        if app.keyboards.count > 0 {
            let done = app.keyboards.buttons.matching(NSPredicate(format: "label ==[c] 'done'")).firstMatch
            if done.exists { done.tap() } else { field.typeText("\n") }
        } else {
            field.typeText("\n")
        }
        let closed = NSPredicate(format: "count == 0")
        expectation(for: closed, evaluatedWith: app.keyboards)
        waitForExpectations(timeout: 5)
        assertWhollyVisible(app, status)
        save(app, "held-after-done")

        let why = app.buttons["choose-name-why"]
        XCTAssertTrue(why.waitForExistence(timeout: 5))
        XCTAssertEqual(why.label, "Why is clou-dflare held?")
        why.tap()
        let title = app.staticTexts["held-why-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "Why? opens the sheet.")
        XCTAssertEqual(title.label, "Why is clou-dflare held?")
        XCTAssertTrue(app.buttons["held-why-email"].exists)
        save(app, "held-why-sheet")
        let ok = app.buttons["held-why-ok"]
        if !ok.isHittable { app.swipeUp() }
        ok.tap()
        XCTAssertTrue(title.waitForNonExistence(timeout: 10))

        // Back still works: nothing was opened for the held name.
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.exists, "Back is still offered.")
    }

    func test_payRightAfterTypingAFailedLookup_closesTheKeyboardAndStays() {
        let app = launchChooseName()
        let field = nameField(app)
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("acme")
        let pay = app.buttons["choose-name-pay"]
        if !pay.isHittable { app.swipeUp() }
        pay.tap()
        let status = app.staticTexts["choose-name-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "Couldn't check acme.com just now. Try again in a minute.")
        XCTAssertEqual(app.keyboards.count, 0, "Pay closes the keyboard first.")
        assertWhollyVisible(app, status)
        XCTAssertFalse(app.buttons["choose-name-why"].exists, "No Why? when the lookup failed.")
        XCTAssertFalse(app.buttons["choose-name-keep"].exists, "Nothing was opened: no Keep button.")
        save(app, "held-unchecked")
    }
}
