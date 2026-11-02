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

    func test_accessRequestNamesTheAppNotItsSlug() throws {
        XCTAssertEqual(AppDisplayName.forAccessRequest(serviceId: "river-otter--notes", appName: "notes"), "Notes")
        XCTAssertEqual(AppDisplayName.forAccessRequest(serviceId: "river-otter--chess-club", appName: " chess-club "), "Chess Club")
        XCTAssertEqual(AppDisplayName.forAccessRequest(serviceId: "river-otter--chess-club", appName: "Club d'échecs"), "Club d'échecs")
        XCTAssertEqual(AppDisplayName.forAccessRequest(serviceId: "river-otter--notes", appName: "Notes"), "Notes")
        XCTAssertEqual(AppDisplayName.forAccessRequest(serviceId: "river-otter--chess-club", appName: ""), "Chess Club")
        XCTAssertEqual(AppDisplayName.forAccessRequest(serviceId: "river-otter--chess-club", appName: nil), "Chess Club")

        let req = try JSONDecoder().decode(AppAccessRequest.self, from: Data(
            #"{"serviceId":"a--notes","appName":"notes","host":"api.example.com"}"#.utf8))
        XCTAssertEqual(req.appName, "Notes")
        let draft = try JSONDecoder().decode(AppAccessDraftEntry.self, from: Data(
            #"{"kind":"draft","serviceId":"a--chess-club","hosts":[]}"#.utf8))
        XCTAssertEqual(draft.appName, "Chess Club")
    }
}
