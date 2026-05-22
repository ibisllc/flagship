import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// v2 device-addressing — pin the `/api/users/check` extension
/// contract on iOS for the `deviceCapability` block, plus the
/// AppState session-state + DemoFixtures activation paths.
///
/// Mirror of the Worker behaviour
/// (docs/v2-device-addressing-and-real-ticket.md §5.1):
///   - When the typed string is `<u>.<label>` and a matching active
///     grant exists, the response carries a `deviceCapability` block
///     alongside the `demoServer` block from the underlying user-part
///     row. DemoFixtures.activate installs the capability so the home
///     screen renders the chip + greys out actions absent from `scopes`.
///   - When the typed string has NO dot, the legacy path runs and the
///     `deviceCapability` field is nil.
///   - Unknown future scope strings decode to nil and are silently
///     dropped (forward-compat — a newer Worker emitting a scope this
///     binary doesn't know about doesn't crash the client).
@MainActor
final class DeviceCapabilityBlockTests: XCTestCase {

    // MARK: - Wire decode

    func test_decodesFromWorkerWireShape_withBrowseOnlyScopes() throws {
        // Wire shape mirrors packages/control-plane/src/usersCheck.ts
        // `deviceCapability` — keep these byte-identical.
        let json = #"""
        {
          "username": "demoalice.reviewer",
          "available": false,
          "reason": "device capability",
          "demoServer": {
            "fqdn": "home.demoalice.flagship.services",
            "status": "up",
            "ttlIdleMinutes": 30
          },
          "deviceCapability": {
            "label": "reviewer",
            "devicePubKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "scopes": ["browse"],
            "grantId": "00000000-0000-4000-8000-000000000001",
            "expiresAt": 9999999999999,
            "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
          }
        }
        """#
        let resp = try JSONDecoder().decode(
            UsernameAvailabilityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(resp.deviceCapability?.label, "reviewer")
        XCTAssertEqual(resp.deviceCapability?.scopes, [.browse])
        XCTAssertEqual(resp.deviceCapability?.grantId, "00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(resp.demoServer?.fqdn, "home.demoalice.flagship.services")
        XCTAssertEqual(resp.deviceCapability?.isFullyScoped, false)
    }

    func test_decodesElevatedDeviceCapabilityWithMultipleScopes() throws {
        let json = #"""
        {
          "username": "demoalice.work-laptop",
          "available": false,
          "reason": "device capability",
          "deviceCapability": {
            "label": "work-laptop",
            "devicePubKey": "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef00000000",
            "scopes": ["browse", "install-service", "vibe-code"],
            "grantId": "00000000-0000-4000-8000-000000000002",
            "expiresAt": 9999999999999,
            "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
          }
        }
        """#
        let resp = try JSONDecoder().decode(
            UsernameAvailabilityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(resp.deviceCapability?.scopes.count, 3)
        XCTAssertEqual(resp.deviceCapability?.scopeSet,
                       Set([.browse, .installService, .vibeCode]))
        XCTAssertFalse(resp.deviceCapability!.isFullyScoped)
    }

    func test_unknownScopeStringsAreDroppedForwardCompat() throws {
        // A newer Worker emitting a scope this binary doesn't know
        // MUST NOT crash the client — the decoder compactMaps so an
        // unknown wire string silently disappears.
        let json = #"""
        {
          "username": "demoalice.reviewer",
          "available": false,
          "reason": "device capability",
          "deviceCapability": {
            "label": "reviewer",
            "devicePubKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "scopes": ["browse", "new-future-scope-this-binary-cannot-parse"],
            "grantId": "00000000-0000-4000-8000-000000000003",
            "expiresAt": 9999999999999,
            "signature": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
          }
        }
        """#
        let resp = try JSONDecoder().decode(
            UsernameAvailabilityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(resp.deviceCapability?.scopes, [.browse],
                       "unknown future scope must be silently dropped, browse must survive")
    }

    func test_legacyResponseWithoutCapabilityFieldDecodes() throws {
        // Backward compat — a pre-v2 Worker / a non-dot username
        // produces a response with no `deviceCapability` field at all.
        let json = #"""
        {
          "username": "demoalice",
          "available": false,
          "reason": "test account",
          "testAccount": {"display":"Demo Alice","ttlHours":24}
        }
        """#
        let resp = try JSONDecoder().decode(
            UsernameAvailabilityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(resp.deviceCapability)
    }

    // MARK: - Mock branch (iOS Mock mirrors the Worker wire format)

    func test_mockEmitsDeviceCapabilityForDotForm() async throws {
        // The iOS Mock MUST emit the same `deviceCapability` shape as
        // the real Worker when the simulated username has a `.<label>`
        // suffix and the test has populated both `demoServers` (the
        // underlying user-part row) and `deviceCapabilities` (the
        // grant). Mock-matches-the-Worker-wire-format invariant —
        // memory: feedback_ios_mock_matches_worker_wire.
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.demoServers = [
            "demoalice": DemoServerBlock(
                fqdn: "home.demoalice.flagship.services",
                status: "up",
                ttlIdleMinutes: 30
            )
        ]
        mock.deviceCapabilities = [
            "demoalice.reviewer": DeviceCapabilityBlock(
                label: "reviewer",
                devicePubKey: String(repeating: "0", count: 64),
                scopes: [.browse],
                grantId: "00000000-0000-4000-8000-000000000010",
                expiresAt: 9_999_999_999_999,
                signature: String(repeating: "0", count: 128)
            )
        ]
        let r = try await mock.usernameAvailable("demoalice.reviewer")
        XCTAssertEqual(r.available, false)
        XCTAssertEqual(r.deviceCapability?.label, "reviewer")
        XCTAssertEqual(r.deviceCapability?.scopes, [.browse])
        XCTAssertEqual(r.demoServer?.fqdn,
                       "home.demoalice.flagship.services",
                       "the same underlying demo server is surfaced for the device's pod")
    }

    func test_mockReturns404ForUnknownDotForm() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        do {
            _ = try await mock.usernameAvailable("demoalice.no-such-device")
            XCTFail("expected ScreensClientError.http(404)")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 404)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - DemoFixtures activation

    func test_activateWithDeviceCapability_installsRestrictedSession() {
        let app = AppState()
        let demo = DemoServerBlock(
            fqdn: "home.demoalice.flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
        let cap = DeviceCapabilityBlock(
            label: "reviewer",
            devicePubKey: String(repeating: "0", count: 64),
            scopes: [.browse],
            grantId: "00000000-0000-4000-8000-000000000020",
            expiresAt: 9_999_999_999_999,
            signature: String(repeating: "0", count: 128)
        )
        DemoFixtures.activate(
            app,
            username: "demoalice.reviewer",
            demoServer: demo,
            deviceCapability: cap
        )
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.fqdn, "home.demoalice.flagship.services")
        XCTAssertEqual(app.deviceCapability?.label, "reviewer")
        XCTAssertTrue(app.isRestrictedDevice)
        XCTAssertTrue(app.hasScope(.browse))
        XCTAssertFalse(app.hasScope(.installService))
        XCTAssertFalse(app.hasScope(.vibeCode))
    }

    func test_activateWithoutDeviceCapability_leavesScopesOpen() {
        let app = AppState()
        let demo = DemoServerBlock(
            fqdn: "home.demoalice.flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
        DemoFixtures.activate(app, username: "demoalice", demoServer: demo)
        XCTAssertNil(app.deviceCapability)
        XCTAssertFalse(app.isRestrictedDevice)
        // Legacy single-IRK path holds every scope implicitly.
        XCTAssertTrue(app.hasScope(.installService))
        XCTAssertTrue(app.hasScope(.vibeCode))
    }

    func test_signOutClearsDeviceCapability() {
        let app = AppState()
        let demo = DemoServerBlock(
            fqdn: "home.demoalice.flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
        let cap = DeviceCapabilityBlock(
            label: "reviewer",
            devicePubKey: String(repeating: "0", count: 64),
            scopes: [.browse],
            grantId: "00000000-0000-4000-8000-000000000021",
            expiresAt: 9_999_999_999_999,
            signature: String(repeating: "0", count: 128)
        )
        DemoFixtures.activate(
            app,
            username: "demoalice.reviewer",
            demoServer: demo,
            deviceCapability: cap
        )
        XCTAssertNotNil(app.deviceCapability)
        app.signOut()
        XCTAssertNil(app.deviceCapability,
                     "signOut must wipe the device capability or the next account inherits it")
    }
}
