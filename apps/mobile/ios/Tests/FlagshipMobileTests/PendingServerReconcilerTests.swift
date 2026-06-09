import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

@MainActor
final class PendingServerReconcilerTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func freshStore() -> PendingServerStore {
        PendingServerStore(defaults: UserDefaults(suiteName: "recon-\(UUID().uuidString)")!)
    }

    /// A fixed signer — no Secure Enclave / biometric in tests.
    private func signer(irk: String = "ABCD") -> PendingServerReconciler.Signer {
        { _, _ in (signatureHex: String(repeating: "0", count: 128), irkPubHex: irk) }
    }

    private func order(_ serial: String, _ name: String) -> OutstandingOrder {
        OutstandingOrder(
            serial: serial, serverName: name,
            fqdn: "\(name).harry.flagship.services",
            phase: .booting, createdAt: 1_000
        )
    }

    // (a) An outstanding order with NO local record surfaces as a pending pod.
    func test_surfacesOutstandingOrderWithNoLocalRecord() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = [order("HOME2SER", "home2")]
        let store = freshStore()

        let r = PendingServerReconciler(app: app, server: server, store: store, sign: signer())
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1)
        let pod = app.pods.first
        XCTAssertEqual(pod?.status, .pending)
        XCTAssertEqual(pod?.name, "home2")
        XCTAssertEqual(pod?.pendingAuthCodeSerial, "HOME2SER")
        XCTAssertEqual(pod?.fqdn, "home2.harry.flagship.services")
        // Persisted so it survives the next launch.
        XCTAssertEqual(store.list(username: "harry").map(\.authCodeSerial), ["HOME2SER"])
        // Authority cache published for the watcher.
        XCTAssertEqual(app.lastKnownOutstandingSerials, ["HOME2SER"])
    }

    // (b/c) A local ghost whose serial is absent from BOTH server sources
    // is dropped from AppState + the store.
    func test_dropsGhostAbsentFromBothSources() async {
        let app = AppState()
        // home1 = stale pending ghost (its order was wiped server-side).
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "ghost", name: "home1", description: nil,
                    fqdn: "home1.harry.flagship.services",
                    status: .pending, pendingAuthCodeSerial: "DEADSER0")
        ])
        let store = freshStore()
        store.add(username: "harry", accountKey: "ABCD", .init(
            podId: "ghost", name: "home1", description: "",
            fqdn: "home1.harry.flagship.services",
            authCodeSerial: "DEADSER0", createdAt: 1))

        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = []   // serial no longer a real order

        let r = PendingServerReconciler(app: app, server: server, store: store, sign: signer())
        await r.reconcile()

        XCTAssertTrue(app.pods.isEmpty)
        XCTAssertTrue(store.list(username: "harry").isEmpty)
    }

    // A registered server (from /pods, i.e. a non-pending pod) supersedes
    // its pending record: the local pending record is dropped, the online
    // pod stays, and it is NOT re-surfaced as a duplicate pending.
    func test_registeredServerSupersedesPendingRecord() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "online-pod", name: "home1", description: nil,
                    fqdn: "home1.harry.flagship.services",
                    status: .online)
        ])
        let store = freshStore()
        // A leftover pending record for the SAME fqdn that already registered.
        store.add(username: "harry", accountKey: "ABCD", .init(
            podId: "stale-pending", name: "home1", description: "",
            fqdn: "home1.harry.flagship.services",
            authCodeSerial: "USEDSER0", createdAt: 1))

        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = []

        let r = PendingServerReconciler(app: app, server: server, store: store, sign: signer())
        await r.reconcile()

        // Only the online pod remains; no duplicate pending was added.
        XCTAssertEqual(app.pods.map(\.podId), ["online-pod"])
        XCTAssertEqual(app.pods.first?.status, .online)
        // The stale pending record was reconciled away (fqdn registered).
        XCTAssertTrue(store.list(username: "harry").isEmpty)
    }

    // Registration is AUTHORITATIVE for online. A server present in the
    // registered /pods inventory renders as an `.online` pod even though it
    // has NO local pod and NO lastReported/cert side-channel — the live bug
    // (a just-live, content-blind box was stranded Pending / invisible).
    func test_registeredFqdnSurfacesAsOnlinePod_evenWithNoLocalRecord() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = []
        let store = freshStore()

        let r = PendingServerReconciler(
            app: app, server: server, store: store,
            fetchRegisteredFqdns: { _ in ["home.harry.flagship.services"] },
            sign: signer()
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.fqdn, "home.harry.flagship.services")
        // No pending duplicate, no leftover pending record.
        XCTAssertEqual(app.pods.filter { $0.status == .pending }.count, 0)
    }

    // A pending pod whose fqdn becomes registered flips to a SINGLE online
    // pod (identity unified on the fqdn — no stuck-pending duplicate), and the
    // local pending record is dropped.
    func test_pendingPodFlipsAndDedupsWhenFqdnRegisters() async {
        let app = AppState()
        let fqdn = "home.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "home",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOMESER0")
        ])
        let store = freshStore()
        store.add(username: "harry", accountKey: "ABCD", .init(
            podId: PodInfo.podId(forFqdn: fqdn), name: "home", description: "",
            fqdn: fqdn, authCodeSerial: "HOMESER0", createdAt: 1))

        let server = makeServer()
        // The order is still "outstanding" server-side, but the box has now
        // registered — registration must win over the still-pending order.
        server.outstandingOrdersByUser["harry"] = [order("HOMESER0", "home")]

        let r = PendingServerReconciler(
            app: app, server: server, store: store,
            fetchRegisteredFqdns: { _ in [fqdn] },
            sign: signer()
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1, "must collapse to one pod")
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.fqdn, fqdn)
        XCTAssertNil(app.pods.first?.pendingAuthCodeSerial)
        XCTAssertTrue(store.list(username: "harry").isEmpty, "pending record dropped")
    }

    // A registered fqdn keeps the user's typed name from the pending pod
    // rather than falling back to the fqdn label.
    func test_registeredFlipPreservesPendingDisplayName() async {
        let app = AppState()
        let fqdn = "home.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "My Home Box",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOMESER0")
        ])
        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = []

        let r = PendingServerReconciler(
            app: app, server: server,
            fetchRegisteredFqdns: { _ in [fqdn] },
            sign: signer()
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.name, "My Home Box")
    }

    // A nil registered-fqdns fetch (directory unreachable this pass) leaves
    // online state untouched — a pending pod stays pending, not dropped.
    func test_nilRegisteredFetchLeavesOnlineStateUntouched() async {
        let app = AppState()
        let fqdn = "home.harry.flagship.services"
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: PodInfo.podId(forFqdn: fqdn), name: "home",
                    description: nil, fqdn: fqdn,
                    status: .pending, pendingAuthCodeSerial: "HOMESER0")
        ])
        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = [order("HOMESER0", "home")]

        let r = PendingServerReconciler(
            app: app, server: server,
            fetchRegisteredFqdns: { _ in nil },
            sign: signer()
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.first?.status, .pending)
    }

    // REGRESSION (#53): a FRESH INSTALL — empty PendingServerStore, a
    // signed-in user, a registered server in /pods — must surface that server
    // as `.online` on first Home appearance EVEN WHEN the IRK-signed
    // outstanding-orders fetch throws (the previous code early-returned on that
    // throw BEFORE the unauthenticated /pods load, so after a reinstall the
    // live server was invisible). The registered-server load is decoupled from
    // and never gated by the signed fetch.
    func test_freshInstall_registeredServerSurfacesOnlineEvenWhenSignedFetchThrows() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])   // fresh install: no local pods
        let store = freshStore()                              // empty PendingServerStore
        XCTAssertTrue(store.list(username: "harry").isEmpty)

        let server = makeServer()
        server.shouldFail = true   // the IRK-signed outstanding-orders fetch THROWS

        let r = PendingServerReconciler(
            app: app, server: server, store: store,
            fetchRegisteredFqdns: { _ in ["home.harry.flagship.services"] },
            sign: signer()
        )
        await r.reconcile()

        // The registered server is surfaced as online despite the signed throw.
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.fqdn, "home.harry.flagship.services")
        XCTAssertEqual(app.pods.filter { $0.status == .pending }.count, 0)
    }

    // Same fresh-install surfacing must hold when the SIGNER itself throws
    // (biometric unavailable / user-cancelled after sign-in / cold-launch) —
    // not just when the network call fails.
    func test_freshInstall_registeredServerSurfacesOnlineEvenWhenSignerThrows() async {
        struct SignerUnavailable: Error {}
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let store = freshStore()

        let server = makeServer()
        server.outstandingOrdersByUser["harry"] = []

        let throwingSigner: PendingServerReconciler.Signer = { _, _ in
            throw SignerUnavailable()
        }

        let r = PendingServerReconciler(
            app: app, server: server, store: store,
            fetchRegisteredFqdns: { _ in ["home.harry.flagship.services"] },
            sign: throwingSigner
        )
        await r.reconcile()

        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .online)
        XCTAssertEqual(app.pods.first?.fqdn, "home.harry.flagship.services")
    }

    // A failing server (network blip) leaves local state untouched.
    func test_serverFailureLeavesStateUntouched() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "p", name: "home1", description: nil,
                    fqdn: "home1.harry.flagship.services",
                    status: .pending, pendingAuthCodeSerial: "SER0")
        ])
        let server = makeServer()
        server.shouldFail = true
        let store = freshStore()

        let r = PendingServerReconciler(app: app, server: server, store: store, sign: signer())
        await r.reconcile()

        XCTAssertEqual(app.pods.map(\.podId), ["p"])
        XCTAssertNil(app.lastKnownOutstandingSerials)
    }
}
