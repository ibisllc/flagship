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

    /// "Add/Import a server" asks which: pick "Create a new server".
    func chooseAddNewServer(file: StaticString = #filePath, line: UInt = #line) {
        // The dialog nests the button in a button with the same id.
        let add = buttons.matching(identifier: "home-add-new-server").firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10), "Add/Import should offer Create a new server.",
                      file: file, line: line)
        add.tap()
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
