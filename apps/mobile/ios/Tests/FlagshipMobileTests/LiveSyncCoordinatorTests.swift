import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// LiveSync — the iOS app-scope single live-update canal. ONE `/stream`
/// long-poll feeds the SAME shared state the views read (AppState.pods via the
/// reconciler + AppState.boxRequestInbox), so a waiting box / an advancing
/// install phase / a new pod surfaces with no manual refresh. Driven by the
/// MockSecretMailboxClient — no real network, no hang.
@MainActor
final class LiveSyncCoordinatorTests: XCTestCase {

    private func freshStore() -> PendingServerStore {
        PendingServerStore(defaults: UserDefaults(suiteName: "livesync-\(UUID().uuidString)")!)
    }

    /// Build a coordinator over a fresh AppState + the given mock mailbox. The
    /// reconciler uses a per-test store so pods land in AppState deterministically.
    private func makeCoordinator(
        app: AppState,
        mailbox: MockSecretMailboxClient,
        active: @escaping @MainActor () -> Bool = { true }
    ) -> LiveSyncCoordinator {
        let store = freshStore()
        return LiveSyncCoordinator(
            app: app,
            mailbox: mailbox,
            isActive: active,
            makeReconciler: { fetch in
                PendingServerReconciler(app: app, store: store, fetchPods: fetch)
            },
            jitter: { 0 }
        )
    }

    private func pod(_ domain: String, requests: [PendingRequestSummaryWire] = []) -> PodDirectoryEntry {
        PodDirectoryEntry(serverDomain: domain, identityPubKey: "22", pendingRequests: requests)
    }
    private func unlockReq(_ nonce: String) -> PendingRequestSummaryWire {
        PendingRequestSummaryWire(id: nonce, type: SecretPurpose.unlockKey.rawValue, issuedAt: 1, expiresAt: 9_999_999_999_999)
    }
    private func order(_ name: String, phase: String) -> PendingPodEntry {
        PendingPodEntry(
            orderRef: OrderRef.compute(serial: "S-\(name)"), serverName: name,
            fqdn: "\(name).harry.flagship.services", phase: phase, createdAt: 1_000
        )
    }

    // The cursor we last saw is echoed back on the next request.
    func test_echoesCursor() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        mailbox.liveSyncScript = [
            LiveSyncResponse(cursor: "c1", username: "harry", pods: []),
            LiveSyncResponse(cursor: "c2", username: "harry", pods: []),
        ]
        let coord = makeCoordinator(app: app, mailbox: mailbox)
        _ = await coord.tickOnce() // first connect: cursor nil → returns c1
        _ = await coord.tickOnce() // echoes c1 → returns c2
        XCTAssertEqual(mailbox.liveSyncCursors, [nil, "c1"])
    }

    // A new pendingRequest in the stream surfaces in the Box Request Inbox
    // ("authorize boot" becomes actionable) — no extra fetch.
    func test_newPendingRequestSurfacesInInbox() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        let domain = "home.harry.flagship.services"
        mailbox.liveSyncScript = [
            LiveSyncResponse(cursor: "c1", username: "harry", pods: [pod(domain)]),
            LiveSyncResponse(cursor: "c2", username: "harry", pods: [pod(domain, requests: [unlockReq("u1")])]),
        ]
        let coord = makeCoordinator(app: app, mailbox: mailbox)
        _ = await coord.tickOnce()
        XCTAssertTrue(app.boxRequestInbox.isEmpty, "no requests yet")
        _ = await coord.tickOnce()
        XCTAssertEqual(app.serversAwaiting(.unlockKey), [domain], "a waiting box surfaces an Approve affordance")
    }

    // A phase change in a pending order advances the checklist (the pending pod
    // is reconciled into AppState from the stream snapshot).
    func test_pendingOrderSurfacesFromStream() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        mailbox.liveSyncScript = [
            LiveSyncResponse(cursor: "p1", username: "harry", pods: [], pending: [order("blog", phase: "partitioning")]),
        ]
        let coord = makeCoordinator(app: app, mailbox: mailbox)
        _ = await coord.tickOnce()
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .pending)
        XCTAssertEqual(app.pods.first?.name, "blog")
    }

    // A new registered pod appears in AppState (flips to .online).
    func test_newRegisteredPodAppears() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        mailbox.liveSyncScript = [
            LiveSyncResponse(cursor: "r1", username: "harry", pods: [pod("home.harry.flagship.services")]),
        ]
        let coord = makeCoordinator(app: app, mailbox: mailbox)
        _ = await coord.tickOnce()
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.status, .online)
    }

    // An unchanged cursor (a held timeout) does NOT churn the shared state.
    func test_unchangedCursorDoesNotRefeed() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        let domain = "home.harry.flagship.services"
        mailbox.liveSyncScript = [
            LiveSyncResponse(cursor: "c1", username: "harry", pods: [pod(domain, requests: [unlockReq("u1")])]),
            LiveSyncResponse(cursor: "c1", username: "harry", pods: []), // same cursor: a timeout hold (the empty pods must be IGNORED)
        ]
        let coord = makeCoordinator(app: app, mailbox: mailbox)
        _ = await coord.tickOnce() // c1 → feeds inbox
        XCTAssertEqual(app.serversAwaiting(.unlockKey), [domain])
        _ = await coord.tickOnce() // c1 again → no re-feed, inbox unchanged
        XCTAssertEqual(app.serversAwaiting(.unlockKey), [domain], "a held timeout (same cursor) must not blank the inbox")
    }

    // When inactive (backgrounded / locked / signed out) it does NOT poll.
    func test_doesNotPollWhenInactive() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        mailbox.liveSyncScript = [LiveSyncResponse(cursor: "c1", username: "harry", pods: [pod("home.harry.flagship.services", requests: [unlockReq("u1")])])]
        let coord = makeCoordinator(app: app, mailbox: mailbox, active: { false })
        coord.start()
        // Give the loop a beat; the inactive gate means it must NOT consume the
        // scripted response.
        try? await Task.sleep(nanoseconds: 50_000_000)
        coord.stop()
        XCTAssertTrue(mailbox.liveSyncCursors.isEmpty, "no /stream request while inactive")
        XCTAssertTrue(app.boxRequestInbox.isEmpty)
    }

    // On a /stream error it falls back to /pods (behavior never degrades).
    func test_fallsBackToPodsOnStreamError() async {
        let app = AppState(); app.completeOnboarding(username: "harry", pods: [])
        let mailbox = MockSecretMailboxClient()
        let domain = "home.harry.flagship.services"
        // /stream throws; the /pods fallback (built from `directory`) carries the
        // request, so the shared state is still fed.
        mailbox.liveSyncError = ScreensClientError.http(status: 503, message: "stream down")
        mailbox.directory = [pod(domain, requests: [unlockReq("u1")])]
        let coord = makeCoordinator(app: app, mailbox: mailbox)
        let delay = await coord.tickOnce()
        XCTAssertTrue(coord.degraded, "marked degraded after a stream error")
        XCTAssertEqual(app.serversAwaiting(.unlockKey), [domain], "the /pods fallback still feeds the inbox")
        // Fallback waits the longer cadence (not an immediate reconnect).
        XCTAssertGreaterThanOrEqual(delay, LiveSyncCoordinator.fallbackNanos)
    }
}
