import XCTest
@testable import FlagshipAPI

final class AppDisplayNameTests: XCTestCase {
    func test_slugReadsAsWords() {
        XCTAssertEqual(AppDisplayName.fromSlug("chess-club"), "Chess Club")
        XCTAssertEqual(AppDisplayName.fromSlug("notes"), "Notes")
        XCTAssertEqual(AppDisplayName.fromSlug("my_app-2"), "My App 2")
        XCTAssertEqual(AppDisplayName.fromSlug("-"), "-")
        XCTAssertEqual(AppDisplayName.fromServiceId("river-otter--chess-club"), "Chess Club")
        XCTAssertEqual(AppDisplayName.fromServiceId("budget"), "Budget")
    }

    func test_boxNameWinsOverTheSlug() throws {
        let json = #"{"serviceId":"a--chess-club","creator":"a","slug":"chess-club","urlLabel":"x","url":"https://x","status":"running","installedAt":0}"#
        var app = try JSONDecoder().decode(AppSummary.self, from: Data(json.utf8))
        XCTAssertEqual(app.displayName, "Chess Club")
        app.name = "Club d'échecs"
        XCTAssertEqual(app.displayName, "Club d'échecs")
        app.name = "  "
        XCTAssertEqual(app.displayName, "Chess Club")
    }
}
