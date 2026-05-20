import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Plan A — pin the `/api/users/check` extension contract on iOS.
///
/// Mirror of the Worker's behaviour (docs/sample-users.md §10.9):
///   - When a typed username matches a `demo_users` row, the response
///     carries a `demoServer` block (fqdn + status + ttlIdleMinutes).
///   - When the username carries ONLY a `testAccount` block (legacy),
///     the `demoServer` field is null and DemoFixtures falls back to
///     the 3-fixture path so already-shipped binaries still work.
///   - The connect-and-wait coordinator POSTs `/connect`, then polls
///     `/users/check` until the lifecycle flips to `up`, then mutates
///     the matching pod in AppState from `.pending` to `.online`.
@MainActor
final class DemoServerBlockTests: XCTestCase {

    // MARK: - Mock-level (Worker mirror)

    func test_mockUsersCheck_omitsDemoServer_whenUsernameNotConfigured() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let r = try await mock.usernameAvailable("harry")
        XCTAssertNil(r.demoServer)
    }

    func test_mockUsersCheck_includesDemoServer_whenConfigured() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.testAccounts = [
            "demo-alice": TestAccountMeta(display: "Demo Alice", ttlHours: 24)
        ]
        mock.demoServers = [
            "demo-alice": DemoServerBlock(
                fqdn: "home.demo-alice.flagship.services",
                status: "none",
                ttlIdleMinutes: 30
            )
        ]
        let r = try await mock.usernameAvailable("demo-alice")
        XCTAssertEqual(r.available, false)
        XCTAssertNotNil(r.testAccount)
        XCTAssertEqual(r.demoServer?.fqdn, "home.demo-alice.flagship.services")
        XCTAssertEqual(r.demoServer?.status, "none")
        // Compare the `lifecycle` enum case via String(describing:) so
        // we don't run into Swift's Optional<.none> overload-resolution
        // ambiguity (Optional.none vs DemoServerBlock.Lifecycle.none).
        XCTAssertEqual(r.demoServer.map(\.lifecycle), DemoServerBlock.Lifecycle.none)
        XCTAssertEqual(r.demoServer?.ttlIdleMinutes, 30)
    }

    func test_demoServerBlock_decodesFromWorkerWireShape() throws {
        // Wire shape mirrors packages/control-plane/src/demoUsers.ts
        // `demoServerBlockFromRow` — keep these byte-identical.
        let json = #"""
        {
          "username": "demo-alice",
          "available": false,
          "reason": "test account",
          "testAccount": {"display":"Demo Alice","ttlHours":24},
          "demoServer": {
            "fqdn": "home.demo-alice.flagship.services",
            "status": "provisioning",
            "ttlIdleMinutes": 30
          }
        }
        """#
        let resp = try JSONDecoder().decode(
            UsernameAvailabilityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(resp.demoServer?.fqdn, "home.demo-alice.flagship.services")
        XCTAssertEqual(resp.demoServer?.lifecycle, .provisioning)
    }

    func test_demoServerLifecycle_unknownStatusFallsBackToProvisioning() {
        // Forward-compat: an old binary reading a new Worker status
        // shouldn't open an unhealthy pod — collapse to provisioning
        // so the client polls instead.
        let block = DemoServerBlock(
            fqdn: "x.flagship.services",
            status: "weird-future-state",
            ttlIdleMinutes: 30
        )
        XCTAssertEqual(block.lifecycle, .provisioning)
    }

    // MARK: - DemoFixtures fork

    func test_activate_demoServerPresent_rendersOneRealDevice() {
        let app = AppState()
        let block = DemoServerBlock(
            fqdn: "home.demo-alice.flagship.services",
            status: "none",
            ttlIdleMinutes: 30
        )
        DemoFixtures.activate(app, username: "demo-alice", demoServer: block)
        XCTAssertEqual(app.pods.count, 1, "demoServer-present path must render ONE device")
        XCTAssertEqual(app.pods.first?.fqdn, "home.demo-alice.flagship.services")
        XCTAssertEqual(app.pods.first?.status, .pending, "status='none' maps to .pending until /connect")
        XCTAssertTrue(app.isPaired)
        XCTAssertEqual(app.currentUser, "demo-alice")
    }

    func test_activate_demoServerNil_fallsBackToThreeFixtures() {
        // Backward compat: an already-shipped Worker that only has a
        // TEST_ACCOUNTS entry (no demo_users row) keeps producing
        // the legacy 3-pod sandbox.
        let app = AppState()
        DemoFixtures.activate(app, username: "play-reviewer-q2", demoServer: nil)
        XCTAssertEqual(app.pods.count, 3, "demoServer-absent path keeps the legacy 3 fixtures")
        XCTAssertEqual(app.pods.map(\.name), ["Home", "Office", "Music"])
    }

    func test_activate_defaultOverloadStillFallsBackToFixtures() {
        // The legacy 2-arg activate(_:username:) callers (older code
        // paths) must still get the 3-pod sandbox — i.e. the new
        // demoServer param is a non-breaking optional.
        let app = AppState()
        DemoFixtures.activate(app, username: "play-reviewer-q2")
        XCTAssertEqual(app.pods.count, 3)
    }

    func test_samplePodFromDemoServer_upStatusMapsToOnline() {
        let block = DemoServerBlock(
            fqdn: "home.demo-alice.flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
        let pod = DemoFixtures.samplePodFromDemoServer(block, username: "demo-alice")
        XCTAssertEqual(pod.status, .online)
        XCTAssertEqual(pod.fqdn, "home.demo-alice.flagship.services")
    }

    func test_samplePodFromDemoServer_provisioningMapsToPending() {
        let block = DemoServerBlock(
            fqdn: "home.demo-alice.flagship.services",
            status: "provisioning",
            ttlIdleMinutes: 30
        )
        let pod = DemoFixtures.samplePodFromDemoServer(block, username: "demo-alice")
        XCTAssertEqual(pod.status, .pending)
    }

    // MARK: - DemoConnectClient (Mock)

    func test_mockDemoConnect_flipsStatusFromNoneToUp_synchronously() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.demoServers = [
            "demo-alice": DemoServerBlock(
                fqdn: "home.demo-alice.flagship.services",
                status: "none",
                ttlIdleMinutes: 30
            )
        ]
        let connect = MockDemoConnectClient(server: mock)
        connect.simulatedProvisioningSeconds = 0  // synchronous flip
        try await connect.connect(username: "demo-alice")
        XCTAssertEqual(connect.connectCalls, ["demo-alice"])
        // Now the mock's row should be `up`.
        let r = try await mock.usernameAvailable("demo-alice")
        XCTAssertEqual(r.demoServer?.lifecycle, .up)
    }

    func test_mockDemoConnect_pollUntilUp_returnsUpBlock() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.demoServers = [
            "demo-alice": DemoServerBlock(
                fqdn: "home.demo-alice.flagship.services",
                status: "up",
                ttlIdleMinutes: 30
            )
        ]
        let connect = MockDemoConnectClient(server: mock)
        let block = try await connect.pollUntilUp(
            username: "demo-alice",
            pollIntervalSeconds: 0.01,
            timeoutSeconds: 1.0
        )
        XCTAssertEqual(block.lifecycle, .up)
    }

    func test_mockDemoConnect_pollUntilUp_timesOutWhenStuckProvisioning() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.demoServers = [
            "demo-alice": DemoServerBlock(
                fqdn: "home.demo-alice.flagship.services",
                status: "provisioning",
                ttlIdleMinutes: 30
            )
        ]
        let connect = MockDemoConnectClient(server: mock)
        do {
            _ = try await connect.pollUntilUp(
                username: "demo-alice",
                pollIntervalSeconds: 0.01,
                timeoutSeconds: 0.05
            )
            XCTFail("expected timeout")
        } catch DemoConnectError.timedOut(let last) {
            XCTAssertEqual(last, "provisioning")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func test_mockDemoConnect_pollUntilUp_failsWhenDemoServerWentAway() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        // No demoServers map entry → block absent on every poll.
        let connect = MockDemoConnectClient(server: mock)
        do {
            _ = try await connect.pollUntilUp(
                username: "demo-alice",
                pollIntervalSeconds: 0.01,
                timeoutSeconds: 0.05
            )
            XCTFail("expected demoServerWentAway")
        } catch DemoConnectError.demoServerWentAway {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - DemoConnectCoordinator

    func test_coordinator_connect_flipsPodFromPendingToOnline() async {
        let app = AppState()
        let block = DemoServerBlock(
            fqdn: "home.demo-alice.flagship.services",
            status: "none",
            ttlIdleMinutes: 30
        )
        DemoFixtures.activate(app, username: "demo-alice", demoServer: block)
        XCTAssertEqual(app.pods.first?.status, .pending)

        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        mock.demoServers = ["demo-alice": block]
        let connect = MockDemoConnectClient(server: mock)
        connect.simulatedProvisioningSeconds = 0  // synchronous flip
        let coord = DemoConnectCoordinator(server: mock, demoConnect: connect)

        await coord.connect(
            username: "demo-alice",
            appState: app,
            pollIntervalSeconds: 0.01,
            timeoutSeconds: 2.0
        )
        guard case .up(let fqdn) = coord.state else {
            XCTFail("expected .up, got \(coord.state)"); return
        }
        XCTAssertEqual(fqdn, "home.demo-alice.flagship.services")
        XCTAssertEqual(app.pods.first?.status, .online,
                       "coordinator must flip the matching pod to .online")
    }
}
