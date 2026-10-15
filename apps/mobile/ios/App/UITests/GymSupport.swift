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
}
