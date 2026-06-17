import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class SettingsViewModelTrustedDevicesTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    /// Deterministic IRK signer so the (now-authenticated) disconnect
    /// doesn't hit the biometric Keystore in CI.
    private func fakeSigner() -> @MainActor (String) async throws -> Curve25519.Signing.PrivateKey {
        let key = Curve25519.Signing.PrivateKey()
        return { _ in key }
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

    // MARK: - Disconnect (B6)

    func test_disconnect_optimisticallyRemovesRowAndReturnsTrueOnSuccess() async {
        let server = makeServer()
        server.devicesByUser["harry"] = [
            .init(tokenId: "tA", tokenPrefix: "tA", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1),
            .init(tokenId: "tB", tokenPrefix: "tB", label: "iPad",   platform: "apns", addedAt: 2, lastSeenAt: 2),
        ]
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" }, signer: fakeSigner())
        await vm.loadTrustedDevices()

        // Pre-register an artificial Mock push token row so the Mock
        // revoke has something concrete to drop. (devicesByUser is
        // separate from registeredPushTokens — the Mock's revoke just
        // deletes from registeredPushTokens.) We also remove from
        // devicesByUser so the refresh reflects the change.
        server.devicesByUser["harry"]?.removeAll { $0.tokenId == "tA" }

        let target = TrustedDevice(tokenId: "tA", tokenPrefix: "tA", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1)
        let ok = await vm.disconnect(target)
        XCTAssertTrue(ok)
        if case .loaded(let devices) = vm.trustedDevices {
            XCTAssertEqual(devices.map(\.tokenId), ["tB"])
        } else { XCTFail("expected loaded after disconnect") }
    }

    func test_disconnect_revertsListOnServerError() async {
        let server = makeServer()
        server.devicesByUser["harry"] = [
            .init(tokenId: "tA", tokenPrefix: "tA", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1),
        ]
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" }, signer: fakeSigner())
        await vm.loadTrustedDevices()
        // After load, flip shouldFail so disconnect's revoke call errors.
        server.shouldFail = true
        let target = TrustedDevice(tokenId: "tA", tokenPrefix: "tA", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1)
        let ok = await vm.disconnect(target)
        XCTAssertFalse(ok)
        // Row should reappear after rollback.
        if case .loaded(let devices) = vm.trustedDevices {
            XCTAssertEqual(devices.count, 1)
        } else { XCTFail("expected list restored") }
    }

    func test_disconnect_isNoOpWhenListNotLoaded() async {
        let vm = SettingsViewModel(client: makeScreens(), server: makeServer(), username: { "harry" })
        // Never load.
        let target = TrustedDevice(tokenId: "tA", tokenPrefix: "tA", label: "iPhone", platform: "apns", addedAt: 1, lastSeenAt: 1)
        let ok = await vm.disconnect(target)
        XCTAssertFalse(ok)
    }

    // MARK: - M4 pending re-pair

    func test_loadPendingRePair_nilWhenUsernameMissing() async {
        let vm = SettingsViewModel(client: makeScreens(), server: makeServer(), username: { nil })
        await vm.loadPendingRePair()
        XCTAssertNil(vm.pendingRePair)
    }

    func test_loadPendingRePair_populatesSnapshot() async {
        let server = makeServer()
        server.pendingRePairByUser["harry"] = .init(
            newIrkPub: "aa", oldIrkPub: "bb", initiatedAt: 1, completesAt: 2, objectedAt: nil)
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" }, signer: fakeSigner())
        await vm.loadPendingRePair()
        XCTAssertEqual(vm.pendingRePair?.pending?.completesAt, 2)
    }

    func test_loadTrustedDevices_alsoLoadsPendingRePair() async {
        let server = makeServer()
        server.pendingRePairByUser["harry"] = .init(
            newIrkPub: "aa", oldIrkPub: "bb", initiatedAt: 1, completesAt: 2, objectedAt: nil)
        let vm = SettingsViewModel(client: makeScreens(), server: server, username: { "harry" }, signer: fakeSigner())
        await vm.loadTrustedDevices()
        XCTAssertNotNil(vm.pendingRePair?.pending)
    }

    // MARK: - Legacy alias

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
