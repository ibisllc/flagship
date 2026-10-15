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

    /// "Add/Import a server" asks which: pick "Add a new server".
    func chooseAddNewServer(file: StaticString = #filePath, line: UInt = #line) {
        // The dialog nests the button in a button with the same id.
        let add = buttons.matching(identifier: "home-add-new-server").firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10), "Add/Import should offer Add a new server.",
                      file: file, line: line)
        add.tap()
    }
}
