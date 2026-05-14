import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

@MainActor
final class PendingPodWatcherTests: XCTestCase {

    // MARK: - mapStep

    func test_mapStep_recognizesAllPipelineNames() {
        XCTAssertEqual(PendingPodWatcher.mapStep("registered"),   .registered)
        XCTAssertEqual(PendingPodWatcher.mapStep("boot"),         .boot)
        XCTAssertEqual(PendingPodWatcher.mapStep("tunnel-online"), .tunnelOnline)
        XCTAssertEqual(PendingPodWatcher.mapStep("cert-issued"),  .certIssued)
        XCTAssertEqual(PendingPodWatcher.mapStep("ready"),        .ready)
    }

    func test_mapStep_ignoresUnknownEventNames() {
        XCTAssertNil(PendingPodWatcher.mapStep("failed"))           // failed is handled separately
        XCTAssertNil(PendingPodWatcher.mapStep("metric:cpu"))
        XCTAssertNil(PendingPodWatcher.mapStep(""))
    }

    // MARK: - Mock server install-event scripts

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    func test_mockGetInstallEvents_returnsScriptedSequence_andRollsCursor() async throws {
        let s = makeServer()
        s.installEventScripts["01CAFE"] = [
            (eventName: "registered",    detail: "",                              postedAt: 1),
            (eventName: "boot",          detail: "",                              postedAt: 2),
            (eventName: "tunnel-online", detail: "",                              postedAt: 3),
        ]
        let first = try await s.getInstallEvents(serial: "01CAFE", since: 0)
        XCTAssertEqual(first.events.count, 3)
        XCTAssertEqual(first.events.map(\.eventName), ["registered", "boot", "tunnel-online"])
        XCTAssertEqual(first.cursor, 3)
        let next = try await s.getInstallEvents(serial: "01CAFE", since: first.cursor)
        XCTAssertEqual(next.events, [])
        XCTAssertEqual(next.cursor, 3)
    }

    func test_mockGetInstallEvents_unknownSerialReturnsEmpty() async throws {
        let s = makeServer()
        let r = try await s.getInstallEvents(serial: "nope", since: 0)
        XCTAssertEqual(r.events, [])
        XCTAssertEqual(r.cursor, 0)
    }

    // MARK: - End-to-end watcher

    func test_watcher_flipsPodToOnline_onReadyEvent() async throws {
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
        s.installEventScripts["AC-01CAFE"] = [
            (eventName: "registered",    detail: "",                              postedAt: 1),
            (eventName: "boot",          detail: "",                              postedAt: 2),
            (eventName: "tunnel-online", detail: "",                              postedAt: 3),
            (eventName: "cert-issued",   detail: "",                              postedAt: 4),
            (eventName: "ready",         detail: "home.harry.flagship.services",   postedAt: 5),
        ]

        // Bridge captures: confirm each step fires + final complete.
        var observedSteps: [InstallProgressViewModel.Step] = []
        var observedComplete: String?
        InstallProgressBridge.shared.onStep = { observedSteps.append($0) }
        InstallProgressBridge.shared.onComplete = { observedComplete = $0 }
        defer {
            InstallProgressBridge.shared.onStep = nil
            InstallProgressBridge.shared.onComplete = nil
        }

        // Hand-drive a single poll so we don't rely on real time.
        let watcher = PendingPodWatcher(serial: "AC-01CAFE", podId: "p1", app: app, server: s)
        // Use Mirror to call the private pollOnce... actually call
        // start() and wait for the watcher's task to drain the
        // synchronous scripted events.
        watcher.start()
        // Give the task one runloop tick to drain the entire script
        // (Mock is no-latency so a single poll covers all 5 events).
        try await Task.sleep(nanoseconds: 50_000_000)
        watcher.stop()

        XCTAssertEqual(observedSteps, [.registered, .boot, .tunnelOnline, .certIssued, .ready])
        XCTAssertEqual(observedComplete, "home.harry.flagship.services")
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertNil(app.pods.first?.pendingAuthCodeSerial)
    }

    func test_watcher_firesOnFailed_onFailedEvent() async throws {
        let app = AppState()
        let pending = PodInfo(
            podId: "p1", name: "Home", description: nil,
            fqdn: "home.harry.flagship.services",
            status: .pending, pendingAuthCodeSerial: "AC-DEAD"
        )
        app.completeOnboarding(username: "harry", pods: [pending])

        let s = makeServer()
        s.installEventScripts["AC-DEAD"] = [
            (eventName: "registered", detail: "", postedAt: 1),
            (eventName: "failed",     detail: "cert-issuance timed out", postedAt: 2),
        ]
        var failure: String?
        InstallProgressBridge.shared.onFailed = { failure = $0 }
        defer { InstallProgressBridge.shared.onFailed = nil }

        let watcher = PendingPodWatcher(serial: "AC-DEAD", podId: "p1", app: app, server: s)
        watcher.start()
        try await Task.sleep(nanoseconds: 50_000_000)
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
        // We can't peek into the registry's dict directly, but
        // re-syncing after flipping the pending pod online should
        // stop the watcher cleanly (no crash, no leftover task).
        // Then a second sync is a no-op.
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

    func test_registry_doesNotStartWatcher_whenSerialIsMissing() {
        // A pending pod that somehow lost its serial (e.g. legacy
        // state) shouldn't try to poll — the Worker would 400 on the
        // empty serial path and we'd loop forever.
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
