import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// Live provisioning-status timeline coverage:
///  - the `ProvisionStatus` wire decode matches the Worker shape in
///    packages/control-plane/src/provisionStatus.ts +
///    packages/storage/src/types.ts (the iOS-Mock-matches-Worker-wire
///    invariant),
///  - the Live client maps 404 → nil (via the Mock's 404 contract),
///  - the polling view model transitions pending → … → live through the
///    Mock and stops on the terminal phase.
@MainActor
final class ProvisionTimelineTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    // MARK: - Model wire parity

    func test_provisionStatus_decodesWorkerWireShape() throws {
        // Exactly the Worker's ProvisionStatusRecord:
        //   { serial, serverDomain?, phase, detail?, updatedAt, history[] }
        // history entries are { phase, detail?, ts }.
        let json = #"""
        {
          "serial": "AC-01CAFE",
          "serverDomain": "home.harry.flagship.services",
          "phase": "installing",
          "detail": "62%",
          "updatedAt": 1717000000123,
          "history": [
            { "phase": "booting", "ts": 1717000000000 },
            { "phase": "downloading", "detail": "fetching image", "ts": 1717000000050 },
            { "phase": "partitioning", "ts": 1717000000080 },
            { "phase": "installing", "detail": "62%", "ts": 1717000000123 }
          ]
        }
        """#
        let s = try JSONDecoder().decode(ProvisionStatus.self, from: Data(json.utf8))
        XCTAssertEqual(s.serial, "AC-01CAFE")
        XCTAssertEqual(s.serverDomain, "home.harry.flagship.services")
        XCTAssertEqual(s.phase, .installing)
        XCTAssertEqual(s.detail, "62%")
        XCTAssertEqual(s.updatedAt, 1717000000123)
        XCTAssertEqual(s.history.count, 4)
        XCTAssertEqual(s.history.first?.phase, .booting)
        XCTAssertNil(s.history.first?.detail)
        XCTAssertEqual(s.history[1].phase, .downloading)
        XCTAssertEqual(s.history[1].detail, "fetching image")
        XCTAssertEqual(s.history.last?.phase, .installing)
    }

    func test_provisionStatus_omitsOptionalFields() throws {
        // serverDomain + detail absent (the box hasn't registered yet).
        let json = #"""
        {
          "serial": "AC-NEW",
          "phase": "booting",
          "updatedAt": 5,
          "history": [ { "phase": "booting", "ts": 5 } ]
        }
        """#
        let s = try JSONDecoder().decode(ProvisionStatus.self, from: Data(json.utf8))
        XCTAssertNil(s.serverDomain)
        XCTAssertNil(s.detail)
        XCTAssertEqual(s.phase, .booting)
        XCTAssertEqual(s.history.count, 1)
    }

    func test_provisionStatusPhase_unknownIsForwardCompat() throws {
        // A phase a newer Worker introduces decodes to .unknown, not a throw.
        let json = #"{ "serial": "x", "phase": "teleporting", "updatedAt": 1, "history": [] }"#
        let s = try JSONDecoder().decode(ProvisionStatus.self, from: Data(json.utf8))
        XCTAssertEqual(s.phase, .unknown)
        XCTAssertFalse(ProvisionStatusPhase.ordered.contains(.unknown))
    }

    func test_provisionStatusPhase_ladderIsTheContractOrder() {
        XCTAssertEqual(
            ProvisionStatusPhase.ordered.map(\.rawValue),
            ["booting", "downloading", "partitioning", "installing",
             "installed", "registering", "sealing", "pairing", "live"]
        )
        XCTAssertTrue(ProvisionStatusPhase.live.isTerminal)
        XCTAssertTrue(ProvisionStatusPhase.error.isTerminal)
        XCTAssertFalse(ProvisionStatusPhase.installing.isTerminal)
        // `installed` is ACTION-NEEDED, NOT terminal — success stays `live`.
        XCTAssertFalse(ProvisionStatusPhase.installed.isTerminal)
    }

    // MARK: - Client 404 → nil

    func test_fetchProvisionStatus_unknownSerialReturnsNil() async throws {
        let s = makeServer()
        let result = try await s.fetchProvisionStatus(serial: "no-such-serial")
        XCTAssertNil(result)
    }

    func test_fetchProvisionStatus_fixtureReturnsVerbatim() async throws {
        let s = makeServer()
        s.provisionStatusFixtures["AC-1"] = ProvisionStatus(
            serial: "AC-1",
            serverDomain: "home.harry.flagship.services",
            phase: .registering,
            detail: nil,
            updatedAt: 99,
            history: [ProvisionStatusEntry(phase: .booting, ts: 1)]
        )
        let got = try await s.fetchProvisionStatus(serial: "AC-1")
        XCTAssertEqual(got?.phase, .registering)
        XCTAssertEqual(got?.serverDomain, "home.harry.flagship.services")
    }

    func test_mockScript_advancesAndBuildsAppendOnlyHistory() async throws {
        let s = makeServer()
        s.provisionStatusScripts["AC-2"] = [
            (.booting, nil),
            (.installing, "20%"),
            (.live, nil),
        ]
        let first = try await s.fetchProvisionStatus(serial: "AC-2")
        XCTAssertEqual(first?.phase, .booting)
        XCTAssertEqual(first?.history.map(\.phase), [.booting])

        let second = try await s.fetchProvisionStatus(serial: "AC-2")
        XCTAssertEqual(second?.phase, .installing)
        XCTAssertEqual(second?.detail, "20%")
        XCTAssertEqual(second?.history.map(\.phase), [.booting, .installing])

        let third = try await s.fetchProvisionStatus(serial: "AC-2")
        XCTAssertEqual(third?.phase, .live)
        XCTAssertEqual(third?.history.map(\.phase), [.booting, .installing, .live])

        // Clamps at the terminal step.
        let fourth = try await s.fetchProvisionStatus(serial: "AC-2")
        XCTAssertEqual(fourth?.phase, .live)
    }

    // MARK: - Polling view model transitions

    func test_viewModel_pollsThroughToLive_andStops() async throws {
        let s = makeServer()
        s.provisionStatusScripts["AC-3"] = [
            (.booting, nil),
            (.downloading, nil),
            (.installing, "50%"),
            (.registering, nil),
            (.pairing, nil),
            (.live, nil),
        ]
        s.provisionStatusServerDomains["AC-3"] = "home.harry.flagship.services"

        // 1ms poll interval so the 6-step script drains in milliseconds.
        let vm = ProvisionTimelineViewModel(serial: "AC-3", server: s, pollIntervalNanos: 1_000_000)
        vm.start()
        try await waitUntil(timeout: 2.0) { vm.isDone }

        XCTAssertTrue(vm.isDone)
        XCTAssertEqual(vm.status?.phase, .live)
        XCTAssertEqual(vm.status?.serverDomain, "home.harry.flagship.services")
        vm.stop()
    }

    func test_viewModel_stopsOnError() async throws {
        let s = makeServer()
        s.provisionStatusScripts["AC-4"] = [
            (.booting, nil),
            (.error, "disk too small"),
        ]
        let vm = ProvisionTimelineViewModel(serial: "AC-4", server: s, pollIntervalNanos: 1_000_000)
        vm.start()
        try await waitUntil(timeout: 2.0) { vm.isDone }
        XCTAssertTrue(vm.isDone)
        XCTAssertEqual(vm.status?.phase, .error)
        XCTAssertEqual(vm.status?.detail, "disk too small")
        vm.stop()
    }

    func test_viewModel_nilBeforeFirstCheckpoint_thenAdvances() async throws {
        // No script + no fixture → fetch returns nil; the model keeps
        // polling and status stays nil (not isDone). Then seed a fixture
        // and confirm the next poll picks it up.
        let s = makeServer()
        let vm = ProvisionTimelineViewModel(serial: "AC-5", server: s, pollIntervalNanos: 1_000_000)
        vm.start()
        try await Task.sleep(nanoseconds: 20_000_000) // 20ms — a few polls
        XCTAssertNil(vm.status)
        XCTAssertFalse(vm.isDone)

        s.provisionStatusFixtures["AC-5"] = ProvisionStatus(
            serial: "AC-5", phase: .live, updatedAt: 1,
            history: [ProvisionStatusEntry(phase: .live, ts: 1)]
        )
        try await waitUntil(timeout: 2.0) { vm.isDone }
        XCTAssertEqual(vm.status?.phase, .live)
        vm.stop()
    }

    // MARK: - Directory fallback (serial-less pod)

    func test_directoryMode_synthesizesPhaseFromPendingEntry() async throws {
        // A pod surfaced from `/pods` carries no serial — the VM polls the
        // directory and projects pending[].phase onto the ladder.
        let directory = PodsDirectoryResponse(
            username: "harry",
            pods: [],
            pending: [PendingPodEntry(
                orderRef: String(repeating: "ab", count: 32),
                serverName: "abc",
                fqdn: "abc.harry.flagship.services",
                phase: "installing",
                createdAt: 1
            )]
        )
        let vm = ProvisionTimelineViewModel(
            username: "harry",
            fqdn: "ABC.harry.flagship.services",
            fetchDirectory: { _ in directory },
            pollIntervalNanos: 1_000_000
        )
        vm.start()
        try await waitUntil(timeout: 2.0) { vm.status?.phase == .installing }
        XCTAssertFalse(vm.isDone)
        XCTAssertEqual(vm.status?.serverDomain, "ABC.harry.flagship.services")
        XCTAssertEqual(vm.status?.history, [])
        vm.stop()
    }

    func test_directoryMode_flipsLiveWhenFqdnRegisters_andStops() async throws {
        let directory = PodsDirectoryResponse(
            username: "harry",
            pods: [PodDirectoryEntry(
                serverDomain: "abc.harry.flagship.services",
                identityPubKey: String(repeating: "00", count: 32)
            )],
            pending: []
        )
        let vm = ProvisionTimelineViewModel(
            username: "harry",
            fqdn: "abc.harry.flagship.services",
            fetchDirectory: { _ in directory },
            pollIntervalNanos: 1_000_000
        )
        vm.start()
        try await waitUntil(timeout: 2.0) { vm.isDone }
        XCTAssertEqual(vm.status?.phase, .live)
        vm.stop()
    }

    func test_directoryMode_revokedRegistrationDoesNotFlipLive() async throws {
        // A revoked registration is NOT the live box; with the pending order
        // also gone the ladder stays on the waiting state (the reconciler is
        // what removes the pod itself).
        let directory = PodsDirectoryResponse(
            username: "harry",
            pods: [PodDirectoryEntry(
                serverDomain: "abc.harry.flagship.services",
                identityPubKey: String(repeating: "00", count: 32),
                revokedAt: 5
            )],
            pending: []
        )
        let vm = ProvisionTimelineViewModel(
            username: "harry",
            fqdn: "abc.harry.flagship.services",
            fetchDirectory: { _ in directory },
            pollIntervalNanos: 1_000_000
        )
        vm.start()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(vm.status)
        XCTAssertFalse(vm.isDone)
        vm.stop()
    }

    func test_directoryMode_unreachableDirectoryKeepsWaiting() async throws {
        let vm = ProvisionTimelineViewModel(
            username: "harry",
            fqdn: "abc.harry.flagship.services",
            fetchDirectory: { _ in nil },
            pollIntervalNanos: 1_000_000
        )
        vm.start()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(vm.status)
        XCTAssertFalse(vm.isDone)
        vm.stop()
    }

    // MARK: - Helpers

    /// Polls a condition until true or the deadline elapses. The view
    /// model is driven with a 1ms poll interval in these tests so the
    /// progression drains in milliseconds; the deadline is a generous
    /// backstop against a hung task.
    private func waitUntil(
        timeout: TimeInterval,
        _ condition: @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000) // 5ms
        }
        XCTAssertTrue(condition(), "condition not met within \(timeout)s", file: file, line: line)
    }
}
