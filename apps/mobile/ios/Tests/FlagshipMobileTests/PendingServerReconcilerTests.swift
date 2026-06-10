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

    /// The wire entry carries the OPAQUE orderRef, never the raw serial —
    /// exactly what the hardened Worker emits.
    private func order(_ serial: String, _ name: String) -> PendingPodEntry {
        PendingPodEntry(
            orderRef: OrderRef.compute(serial: serial), serverName: name,
            fqdn: "\(name).harry.flagship.services",
            phase: "booting", createdAt: 1_000
        )
    }

    // OrderRef must match the control-plane byte-for-byte (pinned vector
    // from packages/control-plane/tests/podInventory.test.ts).
    func test_orderRefMatchesControlPlaneVector() {
        XCTAssertEqual(
            OrderRef.compute(serial: "HOME2SER"),
            "e0970cb9bd5fd0967cdc259ec8ca1619d1a98c44abc8eadd3fc8d4c2e6fb6442"
        )
    }

    // (a) A pending order with NO local record surfaces as a pending pod —
    // from the single merged fetch, with NO signer / biometric. It carries
    // NO raw serial (this device didn't mint the order; the unauthenticated
    // directory only ships the opaque ref).
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
        XCTAssertNil(pod?.pendingAuthCodeSerial, "raw serial must not be reconstructed from /pods")
        XCTAssertEqual(pod?.fqdn, "home2.harry.flagship.services")
        XCTAssertEqual(store.list(username: "harry").map(\.authCodeSerial), [""])
        XCTAssertEqual(app.lastKnownOutstandingOrderRefs, [OrderRef.compute(serial: "HOME2SER")])
    }

    // A directory-surfaced (serial-less) pod SURVIVES the next reconcile
    // while its order is still outstanding (matched by fqdn), and ages out
    // once the order disappears.
    func test_serialLessPendingPod_survivesThenAgesOut() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()

        let dir = directory(pending: [order("HOME2SER", "home2")])
        let r1 = PendingServerReconciler(app: app, store: store, fetchPods: fetcher(dir))
        await r1.reconcile()
        await r1.reconcile()   // second pass: still outstanding → still ONE pod
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .pending)

        // Order gone server-side → the serial-less pod is a ghost.
        let r2 = PendingServerReconciler(app: app, store: store, fetchPods: fetcher(directory()))
        await r2.reconcile()
        XCTAssertTrue(app.pods.isEmpty)
        XCTAssertTrue(store.list(username: "harry").isEmpty)
    }

    // A pod created on THIS device (raw serial held locally) reconciles by
    // hashing the serial against the directory's refs — it keeps the serial
    // (deep-progress capability) and is NOT duplicated.
    func test_locallyCreatedPodKeepsSerialAndDedupsByRef() async {
        let app = AppState()
        let fqdn = "home2.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "home2",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOME2SER")
        ])
        let store = freshStore()
        store.add(username: "harry", .init(
            podId: PodInfo.podId(forFqdn: fqdn), name: "home2", description: "",
            fqdn: fqdn, authCodeSerial: "HOME2SER", createdAt: 1))

        let r = PendingServerReconciler(
            app: app, store: store,
            fetchPods: fetcher(directory(pending: [order("HOME2SER", "home2")]))
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.pendingAuthCodeSerial, "HOME2SER")
        XCTAssertEqual(store.list(username: "harry").map(\.authCodeSerial), ["HOME2SER"])
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
        XCTAssertNil(pending?.pendingAuthCodeSerial, "the directory never hands out the raw serial")
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
        XCTAssertEqual(app.pods.first?.fqdn, "refreshed.harry.flagship.services")
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
    // Decommission support: PodDirectoryEntry.cameOnline = lastReported != nil
    // || currentCert present. Drives the "Never came online" pill + the
    // free-the-name delete (vs the lost/stolen revoke for a live box).
    func test_cameOnlineDerivation() {
        XCTAssertFalse(PodDirectoryEntry(serverDomain: "d", identityPubKey: "00").cameOnline)
        XCTAssertTrue(
            PodDirectoryEntry(serverDomain: "d", identityPubKey: "00", lastReported: 1).cameOnline
        )
        XCTAssertTrue(
            PodDirectoryEntry(serverDomain: "d", identityPubKey: "00", hasCert: true).cameOnline
        )
    }

    // A registered box that never checked in surfaces ONLINE but cameOnline=false
    // (the dead-install case); one that has reported stays cameOnline=true.
    func test_registeredDeadBox_flagsCameOnlineFalse() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()
        let dir = PodsDirectoryResponse(
            username: "harry",
            pods: [
                PodDirectoryEntry(serverDomain: "dead.harry.flagship.services", identityPubKey: "00"),
                PodDirectoryEntry(serverDomain: "live.harry.flagship.services", identityPubKey: "11", lastReported: 123),
            ],
            pending: []
        )
        let r = PendingServerReconciler(app: app, store: store, fetchPods: fetcher(dir))
        await r.reconcile()

        let dead = app.pods.first { $0.fqdn == "dead.harry.flagship.services" }
        XCTAssertEqual(dead?.status, .online)
        XCTAssertEqual(dead?.cameOnline, false)
        let live = app.pods.first { $0.fqdn == "live.harry.flagship.services" }
        XCTAssertEqual(live?.cameOnline, true)
    }

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
        XCTAssertNil(app.lastKnownOutstandingOrderRefs)
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
