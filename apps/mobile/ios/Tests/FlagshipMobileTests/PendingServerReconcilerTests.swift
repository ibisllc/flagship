import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

@MainActor
final class PendingServerReconcilerTests: XCTestCase {

    private func freshStore() -> PendingServerStore {
        PendingServerStore(defaults: UserDefaults(suiteName: "recon-\(UUID().uuidString)")!)
    }

    /// A merged `/pods` directory — UNAUTHENTICATED, no signer / biometric.
    private func directory(
        registered: [String] = [],
        pending: [PendingPodEntry] = []
    ) -> PodsDirectoryResponse {
        PodsDirectoryResponse(
            username: "harry",
            pods: registered.map { PodDirectoryEntry(serverDomain: $0, identityPubKey: "22") },
            pending: pending
        )
    }

    /// A fetcher that returns a fixed directory — proves NO signer is needed.
    private func fetcher(_ dir: PodsDirectoryResponse?) -> PendingServerReconciler.PodsFetcher {
        { _ in dir }
    }

    private func order(_ serial: String, _ name: String) -> PendingPodEntry {
        PendingPodEntry(
            serial: serial, serverName: name,
            fqdn: "\(name).harry.flagship.services",
            phase: "booting", createdAt: 1_000
        )
    }

    // (a) A pending order with NO local record surfaces as a pending pod —
    // from the single merged fetch, with NO signer / biometric.
    func test_surfacesPendingOrderWithNoLocalRecord() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory(pending: [order("HOME2SER", "home2")]))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1)
        let pod = app.pods.first
        XCTAssertEqual(pod?.status, .pending)
        XCTAssertEqual(pod?.name, "home2")
        XCTAssertEqual(pod?.pendingAuthCodeSerial, "HOME2SER")
        XCTAssertEqual(pod?.fqdn, "home2.harry.flagship.services")
        XCTAssertEqual(store.list(username: "harry").map(\.authCodeSerial), ["HOME2SER"])
        XCTAssertEqual(app.lastKnownOutstandingSerials, ["HOME2SER"])
    }

    // A fresh install (empty store) surfaces a registered server AND a pending
    // order both from ONE fetch — with no signer.
    func test_freshInstall_registeredAndPendingBothSurfaceFromOneFetch() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()
        XCTAssertTrue(store.list(username: "harry").isEmpty)

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory(
                registered: ["home1.harry.flagship.services"],
                pending: [order("HOME2SER", "home2")]
            ))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 2)
        let online = app.pods.first { $0.status == .online }
        let pending = app.pods.first { $0.status == .pending }
        XCTAssertEqual(online?.fqdn, "home1.harry.flagship.services")
        XCTAssertEqual(pending?.fqdn, "home2.harry.flagship.services")
        XCTAssertEqual(pending?.pendingAuthCodeSerial, "HOME2SER")
    }

    // Pull-to-refresh surfaces a pending order with NO Face ID: the fetcher is
    // a plain async closure (no signer parameter exists), so by construction
    // the read path cannot trigger a biometric prompt.
    func test_refreshSurfacesPendingWithoutBiometric() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()
        var fetchCount = 0

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: { _ in
                fetchCount += 1
                return self.directory(pending: [self.order("REFSER01", "refreshed")])
            }
        )
        await r.reconcile()   // pull-to-refresh

        XCTAssertEqual(fetchCount, 1)
        XCTAssertEqual(app.pods.first?.pendingAuthCodeSerial, "REFSER01")
        XCTAssertEqual(app.pods.first?.status, .pending)
    }

    // (b/c) A local ghost whose serial/fqdn is in NEITHER array is dropped from
    // AppState + the store.
    func test_dropsGhostAbsentFromBothArrays() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "ghost", name: "home1", description: nil,
                    fqdn: "home1.harry.flagship.services",
                    status: .pending, pendingAuthCodeSerial: "DEADSER0")
        ])
        let store = freshStore()
        store.add(username: "harry", .init(
            podId: "ghost", name: "home1", description: "",
            fqdn: "home1.harry.flagship.services",
            authCodeSerial: "DEADSER0", createdAt: 1))

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory())   // empty: serial is no longer a real order
        )
        await r.reconcile()

        XCTAssertTrue(app.pods.isEmpty)
        XCTAssertTrue(store.list(username: "harry").isEmpty)
    }

    // A registered server supersedes its leftover pending record (no duplicate).
    func test_registeredServerSupersedesPendingRecord() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "online-pod", name: "home1", description: nil,
                    fqdn: "home1.harry.flagship.services",
                    status: .online)
        ])
        let store = freshStore()
        store.add(username: "harry", .init(
            podId: "stale-pending", name: "home1", description: "",
            fqdn: "home1.harry.flagship.services",
            authCodeSerial: "USEDSER0", createdAt: 1))

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory(registered: ["home1.harry.flagship.services"]))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.map(\.podId), ["online-pod"])
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertTrue(store.list(username: "harry").isEmpty)
    }

    // A registered fqdn with NO local pod surfaces as `.online`.
    func test_registeredFqdnSurfacesAsOnlinePod_evenWithNoLocalRecord() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory(registered: ["home.harry.flagship.services"]))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.fqdn, "home.harry.flagship.services")
        XCTAssertEqual(app.pods.filter { $0.status == .pending }.count, 0)
    }

    // A pending pod whose fqdn becomes registered flips to ONE online pod.
    func test_pendingPodFlipsAndDedupsWhenFqdnRegisters() async {
        let app = AppState()
        let fqdn = "home.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "home",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOMESER0")
        ])
        let store = freshStore()
        store.add(username: "harry", .init(
            podId: PodInfo.podId(forFqdn: fqdn), name: "home", description: "",
            fqdn: fqdn, authCodeSerial: "HOMESER0", createdAt: 1))

        // The order is still listed pending, but the box has now registered —
        // registration must win.
        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory(registered: [fqdn], pending: [order("HOMESER0", "home")]))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1, "must collapse to one pod")
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.fqdn, fqdn)
        XCTAssertNil(app.pods.first?.pendingAuthCodeSerial)
        XCTAssertTrue(store.list(username: "harry").isEmpty, "pending record dropped")
    }

    // A registered flip keeps the user's typed name from the pending pod.
    func test_registeredFlipPreservesPendingDisplayName() async {
        let app = AppState()
        let fqdn = "home.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "My Home Box",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOMESER0")
        ])

        let r = PendingServerReconciler(
            app: app,
            fetchPods: fetcher(directory(registered: [fqdn]))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.name, "My Home Box")
    }

    // A nil fetch (directory unreachable this pass) leaves state untouched.
    func test_nilFetchLeavesStateUntouched() async {
        let app = AppState()
        let fqdn = "home.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "home",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOMESER0")
        ])

        let r = PendingServerReconciler(
            app: app,
            fetchPods: fetcher(nil)
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.first?.status, .pending)
        XCTAssertNil(app.lastKnownOutstandingSerials)
    }

    // A revoked registered entry does NOT surface as online.
    func test_revokedRegisteredEntryIsIgnored() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let dir = PodsDirectoryResponse(
            username: "harry",
            pods: [PodDirectoryEntry(
                serverDomain: "old.harry.flagship.services",
                identityPubKey: "22", revokedAt: 999)],
            pending: []
        )

        let r = PendingServerReconciler(app: app, fetchPods: fetcher(dir))
        await r.reconcile()

        XCTAssertTrue(app.pods.isEmpty)
    }
}
