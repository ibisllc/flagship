import XCTest
@testable import FlagshipCore

final class OpenVibeSessionRouteTests: XCTestCase {
    func testBackFromASessionLandsOnTheChooser() {
        var path: [AppsRoute] = [.buildSource, .buildKey(purpose: .scratch), .vibeCodeDescribe]
        path.openVibeSession("s1")
        XCTAssertEqual(path, [.buildSource, .vibeCodeChat(sessionId: "s1")])

        path = [.buildSource, .buildJournal(buildId: nil)]
        path.openVibeSession("s2")
        XCTAssertEqual(path, [.buildSource, .vibeCodeChat(sessionId: "s2")])
    }

    func testASessionOpenedFromElsewhereGetsTheChooserUnderIt() {
        var path: [AppsRoute] = [.appDetail(serviceId: "a")]
        path.openVibeSession("s3")
        XCTAssertEqual(path, [.appDetail(serviceId: "a"), .buildSource, .vibeCodeChat(sessionId: "s3")])
    }

    func testATakenNameOpensTheSessionsListAboveTheChooser() {
        var path: [AppsRoute] = [.buildSource, .buildKey(purpose: .scratch), .vibeCodeDescribe]
        path.openBuildSessions()
        XCTAssertEqual(path, [.buildSource, .buildJournal(buildId: nil)])
    }
}

final class OpenEditSessionRouteTests: XCTestCase {
    func testBackFromAnEditLandsOnTheServicePage() {
        var path: [AppsRoute] = [.appDetail(serviceId: "alice--notes"), .editService(serviceId: "alice--notes"),
                                 .buildKey(purpose: .edit(serviceId: "alice--notes")), .editDescribe(serviceId: "alice--notes")]
        path.openEditSession("s1", serviceId: "alice--notes")
        XCTAssertEqual(path, [.appDetail(serviceId: "alice--notes"), .vibeCodeChat(sessionId: "s1")])
    }
}
