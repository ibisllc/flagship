import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// The owner's server order (docs/server-order.md): one order state in
/// `AppState` that Home and server detail both read.
@MainActor
final class ServerOrderTests: XCTestCase {
    private let stkA = String(repeating: "a1", count: 32)
    private let stkB = String(repeating: "b2", count: 32)
    private let stkC = String(repeating: "c3", count: 32)

    private func pod(_ id: String, _ stk: String, registeredAt: Int64, status: PodInfo.Status = .online) -> PodInfo {
        PodInfo(podId: id, name: id, fqdn: "\(id).harry.flagship.services", status: status,
                registeredAt: registeredAt, identityPubKeyHex: stk)
    }

    private func state() -> AppState {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [
            pod("home3", stkA, registeredAt: 100),
            pod("leticia", stkB, registeredAt: 200),
            pod("work", stkC, registeredAt: 300),
        ])
        return s
    }

    private final class Signer {
        let key = Curve25519.Signing.PrivateKey()
        var calls: [String] = []
        var error: Error?
        func sign(_ reason: String) throws -> Curve25519.Signing.PrivateKey {
            calls.append(reason)
            if let error { throw error }
            return key
        }
    }

    private func saver(_ app: AppState, _ mailbox: MockSecretMailboxClient, _ signer: Signer) -> ServerOrderSaver {
        ServerOrderSaver(app: app, mailbox: mailbox, signer: { try signer.sign($0) }, now: { 1_760_000_000_000 })
    }

    private func homeOrder(_ app: AppState) -> [String] { app.pods.map(\.podId) }

    /// A device without the admin root never signs a server order with the
    /// IRK: `.com` and the boxes would refuse it. The list goes back and the
    /// owner reads why.
    func testADeviceWithoutTheAdminRootDoesNotSignTheOrder() async throws {
        let app = state()
        let mailbox = MockSecretMailboxClient()
        let outcome = await ServerOrderSaver(app: app, mailbox: mailbox, now: { 1_760_000_000_000 }).makeLeader(podId: "work")
        XCTAssertEqual(outcome, .failed(AdminOrderGate.server))
        XCTAssertTrue(mailbox.serverOrders.isEmpty)
        XCTAssertEqual(homeOrder(app), ["home3", "leticia", "work"])
    }

    // MARK: - Make leader from server detail, then Home

    func testMakeLeaderFromServerDetailPutsTheServerFirstOnHome() async throws {
        let app = state()
        XCTAssertEqual(homeOrder(app), ["home3", "leticia", "work"])
        XCTAssertEqual(app.leaderPodId, "home3")
        let mailbox = MockSecretMailboxClient()
        let signer = Signer()

        // Server detail's "Make leader" on `work`.
        let outcome = await saver(app, mailbox, signer).makeLeader(podId: "work")

        XCTAssertEqual(outcome, .saved)
        // Back on Home: same AppState, already first with the Leader badge.
        XCTAssertEqual(homeOrder(app), ["work", "home3", "leticia"])
        XCTAssertEqual(app.leaderPodId, "work")
        XCTAssertEqual(app.currentPodId, "work")
        // Only the leader is labelled; the rest read their place from position.
        XCTAssertEqual(HomeScreen.leaderLabel(pods: app.pods), .init(podId: "work", standingInFor: nil))
        // Signed once with the sensitive-order key and posted.
        XCTAssertEqual(signer.calls, [ServerOrderSaver.reason])
        let posted = try XCTUnwrap(mailbox.serverOrders.first)
        XCTAssertEqual(posted.username, "harry")
        XCTAssertEqual(posted.body.order.stks, [stkC, stkA, stkB])
        let order = ServerOrder(user: posted.body.order.user, stks: posted.body.order.stks,
                                issuedAt: posted.body.order.issuedAt, nonce: posted.body.order.nonce)
        XCTAssertTrue(order.verify(signatureHex: posted.body.signature, publicKey: signer.key.publicKey))
        XCTAssertFalse(app.isSavingServerOrder)
    }

    func testAFailedPostPutsHomeBack() async {
        let app = state()
        let mailbox = MockSecretMailboxClient()
        mailbox.serverOrderError = ScreensClientError.http(status: 500, message: "boom")
        let outcome = await saver(app, mailbox, Signer()).makeLeader(podId: "work")
        guard case .failed = outcome else { return XCTFail("expected failure, got \(outcome)") }
        XCTAssertEqual(homeOrder(app), ["home3", "leticia", "work"])
        XCTAssertEqual(app.leaderPodId, "home3")
        XCTAssertEqual(app.currentPodId, "home3")
        XCTAssertFalse(app.isSavingServerOrder)
    }

    func testACancelledPromptPutsHomeBackAndPostsNothing() async {
        let app = state()
        let mailbox = MockSecretMailboxClient()
        let signer = Signer()
        signer.error = CancellationError()
        let outcome = await saver(app, mailbox, signer).save(podIds: ["leticia", "work", "home3"])
        guard case .failed = outcome else { return XCTFail("expected failure") }
        XCTAssertEqual(homeOrder(app), ["home3", "leticia", "work"])
        XCTAssertTrue(mailbox.serverOrders.isEmpty)
    }

    func testANewerOrderElsewhereIsReportedAndRevertsLocally() async {
        let app = state()
        let mailbox = MockSecretMailboxClient()
        mailbox.serverOrderError = ScreensClientError.http(status: 409, message: "newer order stored")
        let outcome = await saver(app, mailbox, Signer()).makeLeader(podId: "leticia")
        XCTAssertEqual(outcome, .superseded)
        XCTAssertEqual(homeOrder(app), ["home3", "leticia", "work"])
    }

    func testADemoAccountReordersLocallyWithoutKeys() async {
        let demo = DemoServerBlock(fqdn: "demo.harry.flagship.services", status: "up")
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "a", name: "a", fqdn: "a.harry.flagship.services", status: .online, demoServer: demo, registeredAt: 1),
            PodInfo(podId: "b", name: "b", fqdn: "b.harry.flagship.services", status: .online, demoServer: demo, registeredAt: 2),
        ])
        XCTAssertTrue(app.isDemoAccount)
        let mailbox = MockSecretMailboxClient()
        let signer = Signer()
        let outcome = await saver(app, mailbox, signer).makeLeader(podId: "b")
        XCTAssertEqual(outcome, .local)
        XCTAssertEqual(homeOrder(app), ["b", "a"])
        XCTAssertTrue(app.holdsServerOrder("b"), "a demo leader is never left gray")
        XCTAssertTrue(signer.calls.isEmpty)
        XCTAssertTrue(mailbox.serverOrders.isEmpty)
    }

    // MARK: - Acknowledgement

    func testTheLeaderIsUnconfirmedUntilItHoldsTheOrderOnScreen() async {
        let app = state()
        // Never ordered: boxes and apps both rank oldest first.
        XCTAssertTrue(app.holdsServerOrder("home3"))
        let mailbox = MockSecretMailboxClient()
        let saver = ServerOrderSaver(app: app, mailbox: mailbox, signer: { _ in Curve25519.Signing.PrivateKey() },
                                     now: { 1_760_000_000_000 })
        _ = await saver.makeLeader(podId: "work")
        XCTAssertFalse(app.holdsServerOrder("work"))
        // A stale heartbeat never moves the acknowledgement back.
        app.recordServerOrderAck(podId: "work", issuedAt: 1_760_000_000_000)
        app.recordServerOrderAck(podId: "work", issuedAt: 5)
        XCTAssertTrue(app.holdsServerOrder("work"))
        XCTAssertFalse(app.holdsServerOrder("home3"))
    }

    func testTheSavedOrderIsHandedToEveryServerThatIsUp() async throws {
        let app = state()
        app.upsertRegisteredPod(fqdn: "leticia.harry.flagship.services", name: "leticia",
                                registeredAt: 200, liveness: .unreachable, identityPubKeyHex: stkB)
        let boxes = ["home3": MockScreensClient(), "work": MockScreensClient(), "leticia": MockScreensClient()]
        boxes["home3"]!.deliverServerOrderError = ScreensClientError.http(status: 404, message: "old box")
        let clients = PodScreensClientFactory { fqdn in boxes[String(fqdn.prefix(while: { $0 != "." }))]! }
        let wire = SignedServerOrderWire(
            order: .init(user: "harry", stks: [stkC, stkA, stkB], issuedAt: 42, nonce: String(repeating: "0", count: 64)),
            signature: String(repeating: "0", count: 128)
        )
        await ServerOrderSaver(app: app, mailbox: MockSecretMailboxClient(), clients: clients).deliver(wire)
        XCTAssertEqual(boxes["work"]!.deliveredServerOrders, [wire])
        XCTAssertTrue(boxes["leticia"]!.deliveredServerOrders.isEmpty, "an offline box gets it from .com")
        XCTAssertEqual(app.serverOrderAcks, ["work": 42])
    }

    func testTheReconcilerRecordsEachBoxsAcknowledgement() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let dir = PodsDirectoryResponse(
            username: "harry",
            pods: [
                PodDirectoryEntry(serverDomain: "home3.harry.flagship.services", identityPubKey: stkA, lastReported: 1,
                                  registeredAt: 100, liveness: "live", orderIssuedAt: 7),
                PodDirectoryEntry(serverDomain: "leticia.harry.flagship.services", identityPubKey: stkB, lastReported: 1,
                                  registeredAt: 200, liveness: "live"),
            ]
        )
        let store = PendingServerStore(defaults: UserDefaults(suiteName: "ack-\(UUID().uuidString)")!)
        await PendingServerReconciler(app: app, store: store, fetchPods: { _ in dir }).reconcile()
        XCTAssertEqual(app.serverOrderAcks, [PodInfo.podId(forFqdn: "home3.harry.flagship.services"): 7])
    }

    func testOrderJsonDecodesTheAcknowledgement() throws {
        let json = #"{"serverDomain":"a.harry.flagship.services","identityPubKey":"aa","orderIssuedAt":1760000000000}"#
        let entry = try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.orderIssuedAt, 1_760_000_000_000)
    }

    // MARK: - Ranking and succession

    func testTheRolePassesDownWhileTheFirstIsDownAndComesBack() {
        let app = state()
        app.applyRemoteServerOrder(stks: [stkB, stkA, stkC], issuedAt: 10)
        XCTAssertEqual(homeOrder(app), ["leticia", "home3", "work"])
        XCTAssertEqual(app.leaderPodId, "leticia")

        app.upsertRegisteredPod(fqdn: "leticia.harry.flagship.services", name: "leticia",
                                registeredAt: 200, liveness: .unreachable, identityPubKeyHex: stkB)
        XCTAssertEqual(app.leaderPodId, "home3")
        XCTAssertEqual(app.currentPodId, "home3")
        XCTAssertEqual(HomeScreen.leaderLabel(pods: app.pods), .init(podId: "home3", standingInFor: "leticia"))

        app.upsertRegisteredPod(fqdn: "leticia.harry.flagship.services", name: "leticia",
                                registeredAt: 200, liveness: .live, identityPubKeyHex: stkB)
        XCTAssertEqual(app.leaderPodId, "leticia")
        XCTAssertEqual(app.currentPodId, "leticia")
    }

    func testANewServerRanksLastAndNeverSeizesTheLead() {
        let app = state()
        app.applyRemoteServerOrder(stks: [stkC], issuedAt: 10)
        XCTAssertEqual(homeOrder(app), ["work", "home3", "leticia"])
        app.addPod(pod("fresh", String(repeating: "d4", count: 32), registeredAt: 400))
        XCTAssertEqual(homeOrder(app), ["work", "home3", "leticia", "fresh"])
        XCTAssertEqual(app.leaderPodId, "work")
    }

    func testAStaleSnapshotNeverUndoesANewerOrderOrOneBeingSaved() {
        let app = state()
        app.applyRemoteServerOrder(stks: [stkC, stkA, stkB], issuedAt: 20)
        app.applyRemoteServerOrder(stks: [stkA, stkB, stkC], issuedAt: 10)
        XCTAssertEqual(app.leaderPodId, "work")
        app.beginServerOrderChange(podIds: ["leticia", "work", "home3"], issuedAt: 30)
        app.applyRemoteServerOrder(stks: [stkC, stkA, stkB], issuedAt: 40)
        XCTAssertEqual(homeOrder(app), ["leticia", "work", "home3"])
        app.finishServerOrderChange()
        app.applyRemoteServerOrder(stks: [stkC, stkA, stkB], issuedAt: 40)
        XCTAssertEqual(homeOrder(app), ["work", "home3", "leticia"])
    }

    func testTheReconcilerAppliesTheOrderFromPods() async {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        let dir = PodsDirectoryResponse(
            username: "harry",
            pods: [
                PodDirectoryEntry(serverDomain: "home3.harry.flagship.services", identityPubKey: stkA, lastReported: 1, registeredAt: 100, liveness: "live"),
                PodDirectoryEntry(serverDomain: "leticia.harry.flagship.services", identityPubKey: stkB, lastReported: 1, registeredAt: 200, liveness: "live"),
            ],
            serverOrder: SignedServerOrderWire(
                order: .init(user: "harry", stks: [stkB, stkA], issuedAt: 5, nonce: String(repeating: "0", count: 64)),
                signature: String(repeating: "0", count: 128)
            )
        )
        let store = PendingServerStore(defaults: UserDefaults(suiteName: "order-\(UUID().uuidString)")!)
        await PendingServerReconciler(app: app, store: store, fetchPods: { _ in dir }).reconcile()
        XCTAssertEqual(app.pods.map(\.name), ["leticia", "home3"])
        XCTAssertEqual(app.leaderPodId, app.pods.first?.podId)
    }

    // MARK: - Locked server list (docs/account-read-token.md)

    func testARefusedListWithNothingCachedIsLockedNotEmpty() {
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        XCTAssertFalse(app.isServerListLocked)
        app.accountStatusPaused = true
        XCTAssertTrue(app.isServerListLocked)
        app.addPod(pod("home3", stkA, registeredAt: 1))
        XCTAssertFalse(app.isServerListLocked, "with servers on screen it's only paused")
    }

    func testADemoAccountIsNeverLocked() {
        let app = AppState()
        app.completeOnboarding(username: "demo", pods: [], demoServer: DemoServerBlock(fqdn: "demo.demo.flagship.services", status: "up"))
        app.accountStatusPaused = true
        XCTAssertFalse(app.isServerListLocked)
    }
}
