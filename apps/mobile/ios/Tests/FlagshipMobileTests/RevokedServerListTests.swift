import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// A server revoked as lost / stolen / decommissioned stays in the list with a
/// "Revoked" status; any other revoke (delete, transfer, retire) stays hidden.
@MainActor
final class RevokedServerListTests: XCTestCase {

    private func reconcile(_ app: AppState, _ entries: [PodDirectoryEntry]) async {
        let reconciler = PendingServerReconciler(
            app: app,
            store: PendingServerStore(defaults: UserDefaults(suiteName: "revoked-\(UUID().uuidString)")!),
            fetchPods: { _ in PodsDirectoryResponse(username: "harry", pods: entries, pending: []) }
        )
        await reconciler.reconcile()
    }

    private func entry(_ name: String, revokedAt: Int64? = nil, reason: String? = nil, liveness: String = "unreachable") -> PodDirectoryEntry {
        PodDirectoryEntry(
            serverDomain: "\(name).harry.flagship.services",
            identityPubKey: String(repeating: "cd", count: 32),
            revokedAt: revokedAt,
            revocationReason: reason,
            lastReported: 1,
            liveness: liveness
        )
    }

    func testOwnerRevokesAreListedAsRevoked() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await reconcile(app, [
            entry("lost", revokedAt: 1, reason: "lost"),
            entry("stolen", revokedAt: 1, reason: "stolen"),
            entry("retired", revokedAt: 1, reason: "decommissioned"),
        ])
        XCTAssertEqual(app.pods.map(\.name), ["lost", "stolen", "retired"])
        for pod in app.pods {
            XCTAssertTrue(pod.isRevoked)
            XCTAssertEqual(app.liveness(for: pod), .revoked)
            XCTAssertEqual(pod.identityPubKeyHex, String(repeating: "cd", count: 32), "delete needs the STK")
        }
        XCTAssertNil(app.sessionPod, "a revoked box never anchors the session")
    }

    func testOtherRevokesStayHidden() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await reconcile(app, [
            entry("gone", revokedAt: 1, reason: "released"),
            entry("given", revokedAt: 1, reason: "transferred"),
            entry("old", revokedAt: 1, reason: nil),
            entry("live", liveness: "live"),
        ])
        XCTAssertEqual(app.pods.map(\.name), ["live"])
    }

    func testDeletedElsewhereDropsAPreviouslyListedPod() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await reconcile(app, [entry("home", liveness: "live")])
        XCTAssertEqual(app.pods.count, 1)
        await reconcile(app, [entry("home", revokedAt: 2, reason: "released")])
        XCTAssertTrue(app.pods.isEmpty)
    }

    func testRevokeThenUnrevokeFlipsTheSamePod() async {
        let app = AppState(isPaired: true, currentUser: "harry")
        await reconcile(app, [entry("home", liveness: "live")])
        await reconcile(app, [entry("home", revokedAt: 2, reason: "stolen")])
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.liveness(for: app.pods[0]), .revoked)
        await reconcile(app, [entry("home", liveness: "live")])
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.liveness(for: app.pods[0]), .online)
    }

    func testListedEntriesPreferLiveRegistrationAndLatestRevoke() {
        let live = entry("home", liveness: "live")
        let staleRevoke = entry("home", revokedAt: 1, reason: "lost")
        XCTAssertEqual(PendingServerReconciler.listedEntries([staleRevoke, live]), [live])

        let older = entry("box", revokedAt: 1, reason: "lost")
        let newer = entry("box", revokedAt: 5, reason: "stolen")
        XCTAssertEqual(PendingServerReconciler.listedEntries([older, newer]), [newer])
    }

    func testRevokedPillStyling() {
        XCTAssertEqual(PodStatusStyle.label(liveness: .revoked, status: .offline), "Revoked")
        XCTAssertEqual(PodStatusStyle.pillKind(liveness: .revoked, status: .offline), .offline)
        XCTAssertEqual(PodStatusStyle.pillAccessibilityId(liveness: .revoked, status: .offline), "pod-card-revoked")
        let pod = PodInfo(podId: "p", name: "p", fqdn: "p", status: .offline, revokedAt: 1, revocationReason: "lost")
        XCTAssertTrue(HomeStatusFilter.offline.matches(pod: pod, liveness: .revoked))
        XCTAssertFalse(HomeStatusFilter.online.matches(pod: pod, liveness: .revoked))
    }

    func testAuditLabels() {
        XCTAssertEqual(AuditLogViewModel.label(for: "server-revoked"), "Revoked server")
        XCTAssertEqual(AuditLogViewModel.label(for: "server-unrevoked"), "Restored server")
        XCTAssertEqual(WatchProtocol.SecurityAlertsProjection.label(for: "server-revoked"), "Revoked server")
        XCTAssertEqual(WatchProtocol.SecurityAlertsProjection.label(for: "server-unrevoked"), "Restored server")
    }
}
