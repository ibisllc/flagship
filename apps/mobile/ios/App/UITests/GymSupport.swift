import XCTest

extension XCUIApplication {
    /// The back button of a pushed server page. The page is titled with the
    /// server's name, which for "Home" is also the Home tab's own title, so the
    /// back button is what tells the pushed page apart.
    func serverPageBackButton(named name: String) -> XCUIElement {
        navigationBars[name].buttons
            .matching(NSPredicate(format: "identifier == 'BackButton' OR label == 'Home' OR label == 'Back'"))
            .firstMatch
    }

    /// The system back button of the page titled `title`. UIKit names it
    /// `BackButton`; it usually reports as a Button, but the gym has seen
    /// XCUITest resolve it as a PopUpButton (iOS 26+ gives it a long-press
    /// history menu) and fail a `buttons[...]` query on the type: match any.
    func navBackButton(in title: String) -> XCUIElement {
        navigationBars[title].descendants(matching: .any).matching(identifier: "BackButton").firstMatch
    }

    /// "Add/Restore server" asks which: pick "Create a new server".
    func chooseAddNewServer(file: StaticString = #filePath, line: UInt = #line) {
        // The dialog nests the button in a button with the same id.
        let add = buttons.matching(identifier: "home-add-new-server").firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10), "Add/Restore should offer Create a new server.",
                      file: file, line: line)
        add.tap()
    }

    /// The title of the iPad's detail pane. The split view's detail column
    /// shows the active destination's title in its own bar, so a pane is found
    /// by its title text to the right of the sidebar as well as by a bar of that name.
    func iPadPaneTitle(_ title: String) -> XCUIElement {
        let texts = staticTexts.matching(NSPredicate(format: "label == %@", title))
        let right = texts.allElementsBoundByIndex.first { $0.frame.minX > 300 }
        return right ?? navigationBars[title]
    }

    func waitForIPadPane(_ title: String, timeout: TimeInterval = 15) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if navigationBars[title].exists { return true }
            if staticTexts.matching(NSPredicate(format: "label == %@", title)).allElementsBoundByIndex.contains(where: { $0.frame.minX > 300 }) { return true }
            usleep(300_000)
        }
        return false
    }

    /// Add/Restore server → Restore from backup → a source:
    /// `file` | `peers` | `phone` (the menu must be open).
    func chooseRestoreSource(_ source: String, file: StaticString = #filePath, line: UInt = #line) {
        let door = buttons.matching(identifier: "home-restore-backup").firstMatch
        XCTAssertTrue(door.waitForExistence(timeout: 10), "Add/Restore server should offer Restore from backup.", file: file, line: line)
        door.tap()
        let option = buttons.matching(identifier: "restore-source-\(source)").firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 10), "Restore from backup should offer \(source).", file: file, line: line)
        option.tap()
    }

    /// The Backups step preselects nothing and Continue stays off until the
    /// owner picks: choose `none` | `phone-only` | `peer`.
    func chooseBackupPolicy(_ policy: String = "none", file: StaticString = #filePath, line: UInt = #line) {
        let option = descendants(matching: .any).matching(identifier: "cs-backup-policy-\(policy)").firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 10), "The Backups step should offer \(policy).", file: file, line: line)
        option.tap()
    }

    /// Create server starts with the next free "home" in the name field:
    /// clears it, then types `text`.
    func typeServerName(_ field: XCUIElement, _ text: String) {
        // The caret goes to the end of the text, so the deletes clear all of it.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.97)).tap()
        let current = (field.value as? String) ?? ""
        if !current.isEmpty, current != (field.placeholderValue ?? "") {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
    }
}
