import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// iOS mirror of packages/protocol/src/provisionProgress.ts — the
/// fraction, the four-group labels, and the per-step states must match
/// the webapp + Android renderers byte-for-byte. Plus the
/// device-metadata wire decode + the cancel client round-trip.
@MainActor
final class ProvisionProgressTests: XCTestCase {

    func test_fraction_zeroForNullUnknown_oneForReady_zeroForBareFailed() {
        XCTAssertEqual(ProvisionProgress.fraction(nil), 0)
        XCTAssertEqual(ProvisionProgress.fraction(""), 0)
        XCTAssertEqual(ProvisionProgress.fraction("nope"), 0)
        XCTAssertEqual(ProvisionProgress.fraction("ready"), 1)
        XCTAssertEqual(ProvisionProgress.fraction("failed"), 0)
    }

    func test_fraction_monotonicAlongLadder() {
        var prev = -1.0
        for phase in ProvisionProgress.ladder {
            let f = ProvisionProgress.fraction(phase)
            XCTAssertGreaterThan(f, prev, "phase \(phase) not increasing")
            XCTAssertGreaterThan(f, 0)
            XCTAssertLessThanOrEqual(f, 1)
            prev = f
        }
    }

    func test_stepGroups_fourGroupsWithCanonicalLabels() {
        XCTAssertEqual(
            ProvisionProgress.stepGroups.map { $0.label },
            ["Booting", "Registering", "Securing (TLS certificate)", "Ready"]
        )
        // Every non-terminal phase is covered exactly once, in order.
        let flattened = ProvisionProgress.stepGroups.flatMap { $0.phases }
        XCTAssertEqual(flattened, ProvisionProgress.ladder)
    }

    func test_stepStates_acmeSubphaseActivatesSecuringWithTitle() {
        let v = ProvisionProgress.stepStates(phase: "dns01-propagation-wait")
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .active, .pending])
        let securing = v.first { $0.key == .securing }!
        XCTAssertEqual(securing.detail, "Waiting for DNS")
    }

    func test_stepStates_ready_allDone() {
        let v = ProvisionProgress.stepStates(phase: "ready")
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .done, .done])
    }

    func test_stepStates_failedWithHint_marksOwningGroupAndCarriesError() {
        let v = ProvisionProgress.stepStates(
            phase: "failed", lastError: "rate limited by ACME", prevPhase: "acme-validating"
        )
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .failed, .pending])
        XCTAssertEqual(v.first { $0.key == .securing }!.detail, "rate limited by ACME")
    }

    func test_stepStates_bareFailed_failsFirstGroup() {
        let v = ProvisionProgress.stepStates(phase: "failed", lastError: "boom")
        XCTAssertEqual(v.first!.state, .failed)
        XCTAssertEqual(v.first!.detail, "boom")
    }

    func test_shouldShowProgressBar_listVisibilityLogic() {
        XCTAssertFalse(ProvisionProgress.shouldShowProgressBar(phase: nil, status: "none"))
        XCTAssertFalse(ProvisionProgress.shouldShowProgressBar(phase: "ready", status: "up"))
        XCTAssertFalse(ProvisionProgress.shouldShowProgressBar(phase: nil, status: "up"))
        XCTAssertTrue(ProvisionProgress.shouldShowProgressBar(phase: "deps", status: "provisioning"))
        XCTAssertTrue(ProvisionProgress.shouldShowProgressBar(phase: nil, status: "provisioning"))
        XCTAssertTrue(ProvisionProgress.shouldShowProgressBar(phase: "failed", status: "provisioning"))
    }

    func test_demoServerBlock_decodesDeviceMetadataFromWire() throws {
        let json = #"""
        {
          "username": "demoalice",
          "available": false,
          "demoServer": {
            "fqdn": "home.demoalice.flagship.services",
            "status": "provisioning",
            "ttlIdleMinutes": 30,
            "phase": "acme-validating",
            "phaseAt": 12345,
            "ip": "1.2.3.4",
            "region": "fsn1",
            "serverType": "cx22",
            "image": "debian-12"
          }
        }
        """#
        let resp = try JSONDecoder().decode(
            UsernameAvailabilityResponse.self, from: Data(json.utf8)
        )
        XCTAssertEqual(resp.demoServer?.ip, "1.2.3.4")
        XCTAssertEqual(resp.demoServer?.region, "fsn1")
        XCTAssertEqual(resp.demoServer?.serverType, "cx22")
        XCTAssertEqual(resp.demoServer?.image, "debian-12")
        XCTAssertEqual(resp.demoServer?.phase, "acme-validating")
    }

    func test_samplePodFromDemoServer_carriesTheBlockOntoThePod() {
        let block = DemoServerBlock(
            fqdn: "home.demoalice.flagship.services",
            status: "provisioning",
            phase: "deps",
            ip: "1.2.3.4",
            region: "fsn1",
            image: "debian-12"
        )
        let pod = DemoFixtures.samplePodFromDemoServer(block, username: "demoalice")
        XCTAssertEqual(pod.status, .pending)
        XCTAssertEqual(pod.demoServer?.phase, "deps")
        XCTAssertEqual(pod.demoServer?.ip, "1.2.3.4")
    }

    func test_cancel_mockRoundTrips_andResetsRowToNone() async throws {
        let mock = MockFlagshipServerClient()
        mock.demoServers = [
            "demoalice": DemoServerBlock(
                fqdn: "home.demoalice.flagship.services", status: "provisioning", phase: "deps"
            )
        ]
        let demo = MockDemoConnectClient(server: mock)
        try await demo.cancel(username: "demoalice")
        XCTAssertEqual(demo.cancelCalls, ["demoalice"])
        XCTAssertEqual(mock.demoServers["demoalice"]?.status, "none")
    }

    func test_coordinatorCancel_dropsTheDemoPod() async throws {
        let mock = MockFlagshipServerClient()
        mock.demoServers = [
            "demoalice": DemoServerBlock(fqdn: "home.demoalice.flagship.services", status: "up")
        ]
        let demo = MockDemoConnectClient(server: mock)
        let coordinator = DemoConnectCoordinator(server: mock, demoConnect: demo)
        let app = AppState()
        app.completeOnboarding(
            username: "demoalice",
            pods: [DemoFixtures.samplePodFromDemoServer(
                DemoServerBlock(fqdn: "home.demoalice.flagship.services", status: "provisioning", phase: "deps"),
                username: "demoalice"
            )]
        )
        XCTAssertEqual(app.pods.count, 1)
        let ok = await coordinator.cancel(username: "demoalice", appState: app)
        XCTAssertTrue(ok)
        XCTAssertEqual(app.pods.count, 0)
        XCTAssertEqual(demo.cancelCalls, ["demoalice"])
    }
}
