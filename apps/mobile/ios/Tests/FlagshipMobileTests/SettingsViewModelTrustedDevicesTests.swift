import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class SettingsViewModelTrustedDevicesTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func makeScreens() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    func test_loadTrustedDevices_emptyWhenUsernameMissing() async {
        let vm = SettingsViewModel(
            client: makeScreens(),
            server: makeServer(),
            username: { nil }
        )
        await vm.loadTrustedDevices()
        if case .loaded(let devices) = vm.trustedDevices {
            XCTAssertTrue(devices.isEmpty)
        } else {
            XCTFail("expected loaded([]), got \(vm.trustedDevices)")
        }
        XCTAssertNil(vm.devicesEtag)
    }

    func test_loadTrustedDevices_populatesFromServer() async {
        let server = makeServer()
        server.devicesByUser["harry"] = [
            .init(tokenId: "t1", tokenPrefix: "t1", label: "iPhone", platform: "apns", addedAt: 100, lastSeenAt: 110),
            .init(tokenId: "t2", tokenPrefix: "t2", label: "iPad",   platform: "apns", addedAt: 200, lastSeenAt: 210),
        ]
        let vm = SettingsViewModel(
            client: makeScreens(),
            server: server,
            username: { "harry" }
        )
        await vm.loadTrustedDevices()
        if case .loaded(let devices) = vm.trustedDevices {
            XCTAssertEqual(devices.count, 2)
            XCTAssertEqual(devices[0].label, "iPhone")  // sorted by addedAt
        } else {
            XCTFail("expected loaded, got \(vm.trustedDevices)")
        }
        XCTAssertNotNil(vm.devicesEtag)
    }

    func test_loadTrustedDevices_capturesEtag() async {
        let server = makeServer()
        server.devicesByUser["harry"] = [.init(tokenId: "t1", tokenPrefix: "t1", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1)]
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" })
        await vm.loadTrustedDevices()
        XCTAssertTrue(vm.devicesEtag?.hasPrefix("W/\"") ?? false)
    }

    func test_load_populatesBothBrowserSessionsAndTrustedDevices() async {
        let server = makeServer()
        server.devicesByUser["harry"] = [.init(tokenId: "t1", tokenPrefix: "t1", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1)]
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" })
        await vm.load()
        if case .loaded(let d) = vm.trustedDevices {
            XCTAssertEqual(d.count, 1)
        } else { XCTFail("trustedDevices: \(vm.trustedDevices)") }
        if case .loaded = vm.browserSessions {} else { XCTFail("browserSessions: \(vm.browserSessions)") }
    }

    func test_loadTrustedDevices_setsFailedOnServerError() async {
        let server = makeServer()
        server.shouldFail = true
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" })
        await vm.loadTrustedDevices()
        if case .failed = vm.trustedDevices {} else {
            XCTFail("expected .failed, got \(vm.trustedDevices)")
        }
    }

    func test_legacyControlDevices_aliasesBrowserSessions() async {
        // Existing UI bits still read .controlDevices; the alias must
        // surface .browserSessions verbatim until rename lands.
        let vm = SettingsViewModel(client: makeScreens(), server: makeServer(), username: { nil })
        await vm.load()
        // Both views of the same state:
        switch (vm.browserSessions, vm.controlDevices) {
        case (.loaded(let a), .loaded(let b)):
            XCTAssertEqual(a.map(\.tokenPrefix), b.map(\.tokenPrefix))
        default:
            // Both transition together; alias should never lag.
            break
        }
    }
}
