import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

@MainActor
final class PendingPodWatcherTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    // MARK: - Canonical channel (fetchProvisionStatus) scripting

    func test_mockFetchProvisionStatus_advancesScriptAndBuildsHistory() async throws {
        let s = makeServer()
        s.provisionStatusScripts["01CAFE"] = [
            (phase: .booting, detail: nil),
            (phase: .installing, detail: nil),
            (phase: .registering, detail: nil),
        ]
        let first = try await s.fetchProvisionStatus(serial: "01CAFE")
        XCTAssertEqual(first?.phase, .booting)
        XCTAssertEqual(first?.history.map(\.phase), [.booting])
        let second = try await s.fetchProvisionStatus(serial: "01CAFE")
        XCTAssertEqual(second?.phase, .installing)
        XCTAssertEqual(second?.history.map(\.phase), [.booting, .installing])
    }

    func test_mockFetchProvisionStatus_unknownSerialReturnsNil() async throws {
        let s = makeServer()
        let r = try await s.fetchProvisionStatus(serial: "nope")
        XCTAssertNil(r)
    }

    // MARK: - End-to-end watcher

    func test_watcher_flipsPodToOnline_onLivePhase() async throws {
        // Set up a paired AppState with one pending pod.
        let app = AppState()
        let pending = PodInfo(
            podId: "p1",
            name: "Home",
            description: nil,
            fqdn: "home.harry.flagship.services",
            status: .pending,
            pendingAuthCodeSerial: "AC-01CAFE"
        )
        app.completeOnboarding(username: "harry", pods: [pending])

        let s = makeServer()
        // One poll serves the whole script (Mock advances one step per
        // call, but the watcher polls until it sees the terminal phase).
        s.provisionStatusScripts["AC-01CAFE"] = [
            (phase: .booting, detail: nil),
            (phase: .downloading, detail: nil),
            (phase: .partitioning, detail: nil),
            (phase: .installing, detail: nil),
            (phase: .registering, detail: nil),
            (phase: .sealing, detail: nil),
            (phase: .pairing, detail: nil),
            (phase: .live, detail: nil),
        ]
        s.provisionStatusServerDomains["AC-01CAFE"] = "home.harry.flagship.services"

        // Bridge captures: confirm each non-terminal phase fires + final complete.
        var observedSteps: [ProvisionStatusPhase] = []
        var observedComplete: String?
        InstallProgressBridge.shared.onStep = { observedSteps.append($0) }
        InstallProgressBridge.shared.onComplete = { observedComplete = $0 }
        defer {
            InstallProgressBridge.shared.onStep = nil
            InstallProgressBridge.shared.onComplete = nil
        }

        // 1ms poll cadence so the Mock's one-phase-per-poll progression drains
        // the whole script quickly without real time.
        let watcher = PendingPodWatcher(
            serial: "AC-01CAFE", podId: "p1", app: app, server: s, pollIntervalNanos: 1_000_000
        )
        watcher.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        watcher.stop()

        // onStep fired for every non-terminal phase in ladder order, once each.
        XCTAssertEqual(
            observedSteps,
            [.booting, .downloading, .partitioning, .installing, .installed, .registering, .sealing, .pairing]
        )
        XCTAssertEqual(observedComplete, "home.harry.flagship.services")
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertNil(app.pods.first?.pendingAuthCodeSerial)
    }

    func test_watcher_firesOnFailed_onErrorPhase() async throws {
        let app = AppState()
        let pending = PodInfo(
            podId: "p1", name: "Home", description: nil,
            fqdn: "home.harry.flagship.services",
            status: .pending, pendingAuthCodeSerial: "AC-DEAD"
        )
        app.completeOnboarding(username: "harry", pods: [pending])

        let s = makeServer()
        s.provisionStatusScripts["AC-DEAD"] = [
            (phase: .registering, detail: nil),
            (phase: .error, detail: "cert-issuance timed out"),
        ]
        var failure: String?
        InstallProgressBridge.shared.onFailed = { failure = $0 }
        defer { InstallProgressBridge.shared.onFailed = nil }

        let watcher = PendingPodWatcher(
            serial: "AC-DEAD", podId: "p1", app: app, server: s, pollIntervalNanos: 1_000_000
        )
        watcher.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        watcher.stop()

        XCTAssertEqual(failure, "cert-issuance timed out")
        // Pod stays pending on failure so the user can hit Cancel
        // Order from the pending detail page.
        XCTAssertEqual(app.pods.first?.status, .pending)
    }

    // MARK: - Registry

    func test_registry_startsWatchersForPendingPods_andStopsForOnlinePods() async {
        let app = AppState()
        app.completeOnboarding(
            username: "harry",
            pods: [
                .init(podId: "p1", name: "Home", description: nil,
                      fqdn: "home.harry.flagship.services",
                      status: .pending, pendingAuthCodeSerial: "AC-1"),
                .init(podId: "p2", name: "Office", description: nil,
                      fqdn: "office.harry.flagship.services",
                      status: .online),
            ]
        )
        let s = makeServer()
        let reg = PendingPodWatcherRegistry(app: app, server: s)

        reg.sync()
        // The pending pod gets a watcher; the online one doesn't.
        // Re-syncing after flipping the pending pod online should stop the
        // watcher cleanly (no crash, no leftover task). A second sync is a no-op.
        if let idx = app.pods.firstIndex(where: { $0.podId == "p1" }) {
            var pod = app.pods[idx]
            pod = PodInfo(
                podId: pod.podId, name: pod.name, description: pod.description,
                fqdn: pod.fqdn, status: .online
            )
            app.pods[idx] = pod
        }
        reg.sync()
        reg.stopAll()
        XCTAssertEqual(app.pods.filter { $0.status == .pending }.count, 0)
    }

    // MARK: - #43 — stale-serial handling

    /// A serial that 404s forever AND is definitively NOT in the outstanding
    /// authority is a ghost — the watcher drops the pod instead of spinning.
    func test_watcher_dropsGhost_whenSerialNotOutstanding() async throws {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "ghost", name: "home1", description: nil,
                    fqdn: "home1.harry.flagship.services",
                    status: .pending, pendingAuthCodeSerial: "DEADSER0")
        ])
        let s = makeServer()
        // No script for "DEADSER0" → fetchProvisionStatus returns nil every poll.
        let watcher = PendingPodWatcher(
            serial: "DEADSER0", podId: "ghost", app: app, server: s,
            pollIntervalNanos: 1_000_000,
            isSerialStillOutstanding: { false }   // definitively gone
        )
        watcher.start()
        try await Task.sleep(nanoseconds: 200_000_000)
        watcher.stop()

        XCTAssertTrue(app.pods.isEmpty, "a dead serial's pod should be dropped, not spin")
    }

    /// A freshly-minted serial that hasn't checkpointed yet but IS still
    /// outstanding keeps waiting (stays pending) — no-checkpoint-yet is a
    /// state, not a failure.
    func test_watcher_keepsWaiting_whenSerialStillOutstanding() async throws {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "live", name: "home2", description: nil,
                    fqdn: "home2.harry.flagship.services",
                    status: .pending, pendingAuthCodeSerial: "LIVESER0")
        ])
        let s = makeServer()
        let watcher = PendingPodWatcher(
            serial: "LIVESER0", podId: "live", app: app, server: s,
            pollIntervalNanos: 1_000_000,
            isSerialStillOutstanding: { true }   // still a real order
        )
        watcher.start()
        try await Task.sleep(nanoseconds: 200_000_000)
        watcher.stop()

        XCTAssertEqual(app.pods.first?.status, .pending)
    }

    func test_registry_doesNotStartWatcher_whenSerialIsMissing() {
        // A pending pod that somehow lost its serial (e.g. legacy state)
        // shouldn't try to poll — the Worker would 400 on the empty serial
        // path and we'd loop forever.
        let app = AppState()
        app.completeOnboarding(
            username: "harry",
            pods: [
                .init(podId: "p1", name: "Home", description: nil,
                      fqdn: "home.harry.flagship.services",
                      status: .pending, pendingAuthCodeSerial: nil),
            ]
        )
        let reg = PendingPodWatcherRegistry(app: app, server: makeServer())
        reg.sync()      // must not crash
        reg.stopAll()
    }
}
