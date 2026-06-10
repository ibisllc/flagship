import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// iOS projection of the SINGLE canonical provisioning vocabulary
/// (`ProvisionStatusPhase`) onto the demo install-progress checklist.
/// The fraction, the canonical group labels (design §1.2), and the
/// per-step states match the webapp + Android renderers because all
/// three derive from the same canonical phase ladder + group table.
@MainActor
final class ProvisionProgressTests: XCTestCase {

    func test_fraction_zeroForNullUnknown_oneForLive_zeroForBareError() {
        XCTAssertEqual(ProvisionProgress.fraction(nil), 0)
        XCTAssertEqual(ProvisionProgress.fraction(""), 0)
        XCTAssertEqual(ProvisionProgress.fraction("nope"), 0)
        XCTAssertEqual(ProvisionProgress.fraction("live"), 1)
        XCTAssertEqual(ProvisionProgress.fraction("error"), 0)
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

    func test_ladder_isCanonicalNinePhase_monotonic_downloadingAfterInstalling_installedAfterSealing() {
        XCTAssertEqual(
            ProvisionProgress.ladder,
            ["booting", "partitioning", "installing", "downloading",
             "registering", "sealing", "installed", "pairing", "live"]
        )
        let idx = { (p: String) in ProvisionProgress.ladder.firstIndex(of: p)! }
        XCTAssertGreaterThan(idx("downloading"), idx("installing"))
        XCTAssertGreaterThan(idx("installed"), idx("sealing"))
    }

    func test_stepGroups_canonicalLabels_andCoverEveryPhaseExactlyOnce() {
        XCTAssertEqual(
            ProvisionProgress.stepGroups.map { $0.label },
            ["Booting", "Installing", "Registering", "Securing", "Install complete — unplug the USB", "Ready"]
        )
        // Every non-terminal phase is covered exactly once (design §1.2
        // projection table). The grouped order is NOT the ladder order —
        // `pairing` rolls up with `registering` even though it sits after
        // `sealing` in the ladder — so compare as a set, not a sequence.
        let flattened = ProvisionProgress.stepGroups.flatMap { $0.phases }
        XCTAssertEqual(Set(flattened), Set(ProvisionProgress.ladder))
        XCTAssertEqual(flattened.count, ProvisionProgress.ladder.count, "no phase covered twice")
    }

    func test_stepStates_pairingActivatesRegisteringGroupWithCanonicalTitle() {
        // `pairing` rolls up into the Registering group (design §1.2). Group
        // order: Booting, Installing, Registering, Securing, Installed, Ready.
        let v = ProvisionProgress.stepStates(phase: "pairing")
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .active, .pending, .pending, .pending])
        let registering = v.first { $0.key == .registering }!
        XCTAssertEqual(registering.detail, "Pairing with your phone")
    }

    func test_stepStates_installedIsActionNeeded_notDone() {
        // `installed` activates its own Installed group (after Securing) with
        // the unplug instruction — NOT a done/terminal state (success is `live`).
        let v = ProvisionProgress.stepStates(phase: "installed")
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .done, .done, .active, .pending])
        let installed = v.first { $0.key == .installed }!
        XCTAssertEqual(installed.state, .active)
        XCTAssertEqual(installed.detail, "Install complete — unplug the USB, then power the box back on.")
        XCTAssertEqual(installed.detail, ProvisionProgress.installedUnplugDetail)
    }

    func test_stepStates_sealingActivatesSecuringGroup() {
        let v = ProvisionProgress.stepStates(phase: "sealing")
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .done, .active, .pending, .pending])
        XCTAssertEqual(v.first { $0.key == .securing }!.detail, "Sealing your disk key")
    }

    func test_stepStates_live_allDone() {
        let v = ProvisionProgress.stepStates(phase: "live")
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .done, .done, .done, .done])
    }

    func test_stepStates_errorWithHint_marksOwningGroupAndCarriesError() {
        let v = ProvisionProgress.stepStates(
            phase: "error", lastError: "rate limited by ACME", prevPhase: "sealing"
        )
        XCTAssertEqual(v.map { $0.state }, [.done, .done, .done, .failed, .pending, .pending])
        XCTAssertEqual(v.first { $0.key == .securing }!.detail, "rate limited by ACME")
    }

    func test_stepStates_bareError_failsFirstGroup() {
        let v = ProvisionProgress.stepStates(phase: "error", lastError: "boom")
        XCTAssertEqual(v.first!.state, .failed)
        XCTAssertEqual(v.first!.detail, "boom")
    }

    func test_shouldShowProgressBar_listVisibilityLogic() {
        XCTAssertFalse(ProvisionProgress.shouldShowProgressBar(phase: nil, status: "none"))
        XCTAssertFalse(ProvisionProgress.shouldShowProgressBar(phase: "live", status: "up"))
        XCTAssertFalse(ProvisionProgress.shouldShowProgressBar(phase: nil, status: "up"))
        XCTAssertTrue(ProvisionProgress.shouldShowProgressBar(phase: "installing", status: "provisioning"))
        XCTAssertTrue(ProvisionProgress.shouldShowProgressBar(phase: nil, status: "provisioning"))
        XCTAssertTrue(ProvisionProgress.shouldShowProgressBar(phase: "error", status: "provisioning"))
    }

    // MARK: - ProvisionStatusPhase group projection (the contract table)

    func test_phaseGroupProjection_matchesContractTable() {
        XCTAssertEqual(ProvisionStatusPhase.booting.group, .booting)
        XCTAssertEqual(ProvisionStatusPhase.partitioning.group, .booting)
        XCTAssertEqual(ProvisionStatusPhase.installing.group, .installing)
        // `downloading` (the flagship software fetch) rolls up with Installing.
        XCTAssertEqual(ProvisionStatusPhase.downloading.group, .installing)
        XCTAssertEqual(ProvisionStatusPhase.registering.group, .registering)
        XCTAssertEqual(ProvisionStatusPhase.pairing.group, .registering)
        XCTAssertEqual(ProvisionStatusPhase.sealing.group, .securing)
        XCTAssertEqual(ProvisionStatusPhase.installed.group, .installed)
        XCTAssertEqual(ProvisionStatusPhase.live.group, .ready)
        XCTAssertNil(ProvisionStatusPhase.error.group)
        XCTAssertNil(ProvisionStatusPhase.unknown.group)
    }

    func test_canonicalTitles_matchProvisionStatusTitles() {
        XCTAssertEqual(ProvisionStatusPhase.booting.title, "Booting up")
        XCTAssertEqual(ProvisionStatusPhase.downloading.title, "Downloading")
        XCTAssertEqual(ProvisionStatusPhase.partitioning.title, "Partitioning disk")
        XCTAssertEqual(ProvisionStatusPhase.installing.title, "Installing")
        XCTAssertEqual(ProvisionStatusPhase.installed.title, "Install complete — unplug the USB")
        XCTAssertEqual(ProvisionStatusPhase.registering.title, "Registering with Flagship")
        XCTAssertEqual(ProvisionStatusPhase.sealing.title, "Sealing your disk key")
        XCTAssertEqual(ProvisionStatusPhase.pairing.title, "Pairing with your phone")
        XCTAssertEqual(ProvisionStatusPhase.live.title, "Your server is live")
        XCTAssertEqual(ProvisionStatusPhase.error.title, "Setup hit a problem")
    }

    // MARK: - DemoServerBlock wire decode + cancel round-trip

    func test_demoServerBlock_decodesDeviceMetadataFromWire() throws {
        let json = #"""
        {
          "username": "demoalice",
          "available": false,
          "demoServer": {
            "fqdn": "home.demoalice.flagship.services",
            "status": "provisioning",
            "ttlIdleMinutes": 30,
            "phase": "sealing",
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
        XCTAssertEqual(resp.demoServer?.phase, "sealing")
    }

    func test_samplePodFromDemoServer_carriesTheBlockOntoThePod() {
        let block = DemoServerBlock(
            fqdn: "home.demoalice.flagship.services",
            status: "provisioning",
            phase: "installing",
            ip: "1.2.3.4",
            region: "fsn1",
            image: "debian-12"
        )
        let pod = DemoFixtures.samplePodFromDemoServer(block, username: "demoalice")
        XCTAssertEqual(pod.status, .pending)
        XCTAssertEqual(pod.demoServer?.phase, "installing")
        XCTAssertEqual(pod.demoServer?.ip, "1.2.3.4")
    }

    func test_cancel_mockRoundTrips_andResetsRowToNone() async throws {
        let mock = MockFlagshipServerClient()
        mock.demoServers = [
            "demoalice": DemoServerBlock(
                fqdn: "home.demoalice.flagship.services", status: "provisioning", phase: "installing"
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
                DemoServerBlock(fqdn: "home.demoalice.flagship.services", status: "provisioning", phase: "installing"),
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
