import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// Regression: the box lists the session this phone paired itself with next
/// to Remote browsers, and Settings showed the iPhone under Browser sessions
/// instead of only under Trusted devices. Browser sessions now keeps the
/// sessions the box marks "remote".
@MainActor
final class BrowserSessionsTests: XCTestCase {

    func test_onlyRemoteSessionsAreBrowserSessions() {
        XCTAssertTrue(PairedSessionSummary(tokenPrefix: "r", addedAt: 0, current: false, kind: "remote").isBrowserSession)
        XCTAssertFalse(PairedSessionSummary(tokenPrefix: "d", addedAt: 0, current: true, kind: "device").isBrowserSession)
        XCTAssertFalse(PairedSessionSummary(tokenPrefix: "o", addedAt: 0, current: false, kind: "device").isBrowserSession)
    }

    func test_olderBoxWithoutKindStillLeavesThisDeviceOut() {
        XCTAssertFalse(PairedSessionSummary(tokenPrefix: "me", addedAt: 0, current: true).isBrowserSession)
        XCTAssertTrue(PairedSessionSummary(tokenPrefix: "x", addedAt: 0, current: false).isBrowserSession)
    }

    func test_decodesKindAndToleratesItsAbsence() throws {
        let json = #"{"sessions":[{"tokenPrefix":"a","addedAt":1,"current":true,"kind":"device"},{"tokenPrefix":"b","addedAt":2,"current":false,"kind":"remote","expiresAt":9},{"tokenPrefix":"c","addedAt":3,"current":false}]}"#
        let r = try JSONDecoder().decode(PairedSessionsListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.sessions.map(\.kind), ["device", "remote", nil])
        XCTAssertEqual(r.sessions[1].expiresAt, 9)
    }

    func test_settingsLoadsOnlyBrowserSessions() async {
        let screens = MockScreensClient()
        screens.simulatedLatency = 0
        let vm = SettingsViewModel(client: screens, server: MockFlagshipServerClient(), username: { nil })
        await vm.load()
        guard case .loaded(let sessions) = vm.browserSessions else {
            return XCTFail("browser sessions should load")
        }
        XCTAssertEqual(sessions.map(\.tokenPrefix), ["f9e8d7c6"], "this phone's own session is a Trusted device")
        XCTAssertFalse(sessions.contains(where: \.current))
    }
}
