import XCTest

/// Base for the button sweep (GymSweep*Tests): every scenario launches
/// `-smoke-mode` against the mock clients, reaches its screen by tapping
/// from a tab (not by deep link), presses a control and checks what it did.
///
/// The mocks verify signed orders as the real `.com` and boxes do
/// (MockOrderSigners): the smoke account pins an admin root, so a sensitive
/// order goes through only from an admin device (`-smoke-admin-root`).
/// `-smoke-username bright-maple` makes the demo pods' FQDNs match the mock
/// box, which the per-server cards look pods up by.
class GymSweepCase: XCTestCase {

    private var launched: XCUIApplication?

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// A failed scenario keeps the screen's accessibility tree, so a red
    /// assertion can be read without rerunning it.
    override func tearDownWithError() throws {
        if let app = launched, let run = testRun, run.totalFailureCount > 0 {
            let a = XCTAttachment(string: app.debugDescription)
            a.name = "Screen at failure"
            a.lifetime = .keepAlways
            add(a)
        }
        launched = nil
    }

    /// Put the keyboard away so it can't cover a button below the field.
    func dismissKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.count > 0 else { return }
        let ret = app.keyboards.buttons["return"].firstMatch
        if ret.exists, ret.isHittable { ret.tap() }
        if app.keyboards.count > 0 { app.navigationBars.firstMatch.tap() }
    }

    /// Dismiss a confirmation dialog without acting. On iOS 27 an iPhone
    /// shows it as a popover with no Cancel button: press Cancel when there
    /// is one, else tap the popover's dismiss region.
    func cancelDialog(_ app: XCUIApplication) {
        let sheet = app.sheets.buttons["Cancel"].firstMatch
        if sheet.waitForExistence(timeout: 2), sheet.isHittable { sheet.tap(); return }
        let plain = app.buttons.matching(NSPredicate(format: "label == 'Cancel'")).firstMatch
        if plain.exists, plain.isHittable { plain.tap(); return }
        let region = app.otherElements["PopoverDismissRegion"]
        if region.exists { region.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap() }
    }

    /// Attach a screenshot for the gym's advisory judge.
    func shot(_ app: XCUIApplication, _ point: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "gym-screenshot:\(point)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// A fresh smoke launch on `tab` (home | apps | activity | settings).
    /// `admin`: this device holds the account's admin root.
    func launch(tab: String = "home", admin: Bool = true, _ extra: [String] = [],
                username: String = "bright-maple") -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-smoke-mode", "-smoke-tab", tab, "-smoke-username", username]
            + (admin ? ["-smoke-admin-root"] : []) + extra
        app.launch()
        launched = app
        return app
    }

    /// Scroll until `el` is on screen (bounded); true when it exists.
    @discardableResult
    func reveal(_ app: XCUIApplication, _ el: XCUIElement, tries: Int = 10) -> Bool {
        for _ in 0..<tries where !(el.exists && el.isHittable) { app.swipeUp() }
        return el.waitForExistence(timeout: 5)
    }

    /// Scroll back up until `el` is on screen (bounded).
    @discardableResult
    func revealUp(_ app: XCUIApplication, _ el: XCUIElement, tries: Int = 10) -> Bool {
        for _ in 0..<tries where !(el.exists && el.isHittable) { app.swipeDown() }
        return el.waitForExistence(timeout: 5)
    }

    /// A Home server row (its label is the name plus status), not the tab.
    func podRow(_ app: XCUIApplication, named name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label != %@", name, name)).firstMatch
    }

    /// Home → the named server's page.
    func openServerPage(_ app: XCUIApplication, named name: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = podRow(app, named: name)
        XCTAssertTrue(reveal(app, row), "The \(name) server row should be on Home.", file: file, line: line)
        row.tap()
        XCTAssertTrue(app.serverPageBackButton(named: name).waitForExistence(timeout: 15),
                      "Tapping \(name) should open its server page.", file: file, line: line)
    }

    /// Services → the named demo app's page.
    func openApp(_ app: XCUIApplication, named name: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", name.lowercased())).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "The demo \(name) app should be listed.", file: file, line: line)
        row.tap()
        XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 15), "\(name)'s page should open.",
                      file: file, line: line)
    }

    /// Wait until `predicate` holds for `el` (a condition wait, no sleep).
    func wait(_ el: XCUIElement, _ format: String, timeout: TimeInterval = 10,
              file: StaticString = #filePath, line: UInt = #line) {
        let exp = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: el)
        let result = XCTWaiter().wait(for: [exp], timeout: timeout)
        XCTAssertEqual(result, .completed, "Timed out waiting for \(format) on \(el).", file: file, line: line)
    }

    /// Wait until `el` is gone.
    func waitGone(_ el: XCUIElement, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        wait(el, "exists == false", timeout: timeout, file: file, line: line)
    }

    /// Any element (button, cell, text, switch…) with this identifier.
    func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// A static text whose label contains `text`.
    func text(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// What the mock clients saw (GymProbe): one line per noted request,
    /// e.g. "signed server-order by admin-root" or "refused access-mode".
    func probe(_ app: XCUIApplication) -> String {
        let el = app.descendants(matching: .any).matching(identifier: "gym-probe").firstMatch
        return el.exists ? el.label : ""
    }

    /// Wait until the mocks noted a line containing `line`.
    func expectProbe(_ app: XCUIApplication, _ line: String, timeout: TimeInterval = 15,
                     file: StaticString = #filePath, line callLine: UInt = #line) {
        let el = app.descendants(matching: .any).matching(identifier: "gym-probe").firstMatch
        let exp = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", line), object: el)
        let ok = XCTWaiter().wait(for: [exp], timeout: timeout) == .completed
        XCTAssertTrue(ok, "The mocks never saw \"\(line)\". They saw: \(probe(app))", file: file, line: callLine)
    }

    /// The mocks did not note `line` (checked now, after the UI settled).
    func expectNoProbe(_ app: XCUIApplication, _ line: String, file: StaticString = #filePath, line callLine: UInt = #line) {
        XCTAssertFalse(probe(app).contains(line), "The mocks saw \"\(line)\": \(probe(app))", file: file, line: callLine)
    }

    /// A button by its label (dialogs and menus have no identifiers).
    func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }
}
