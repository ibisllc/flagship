import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// `BootApprovalWatcher` is the account-level "what is each box asking me?" poll.
/// It is DIRECTORY-DRIVEN (no biometric): a `pollAwaiting` closure reads the
/// unauthenticated `/pods` `pendingRequests` digest and the watcher publishes the
/// resulting UNIFIED Box Request Inbox (`AppState.boxRequestInbox`, keyed by fqdn
/// → typed `[BoxRequest]`) — `unlock-key` and `entitlement` are two `type` values
/// in one inbox, not two parallel sets. (The old version derived the IRK every
/// 5s, firing Face ID on a timer.)
@MainActor
final class BootApprovalWatcherTests: XCTestCase {
    private let domain = "home.demo1234.flagship.services"

    private func req(_ type: SecretPurpose, _ nonce: String = "n1") -> BoxRequest {
        BoxRequest(nonceHex: nonce, serverDomain: domain, type: type, issuedAt: 1, expiresAt: 9_999_999_999_999)
    }

    func test_publishesUnifiedInboxFromDirectory() async {
        let app = AppState(currentUser: "demo1234")
        let inbox: [String: [BoxRequest]] = [domain: [req(.unlockKey, "u"), req(.entitlement, "e")]]
        let w = BootApprovalWatcher(
            app: app,
            pollAwaiting: { inbox },
            pollIntervalNanos: 1
        )
        let published = await w.pollOnce()
        XCTAssertEqual(published, inbox)
        XCTAssertEqual(app.boxRequestInbox, inbox)
        // The two lanes derive off the ONE inbox by `type`.
        XCTAssertTrue(app.hasLiveUnlockRequest(forFqdn: domain))
        XCTAssertTrue(app.hasLiveEntitlementRequest(forFqdn: domain))
        XCTAssertEqual(app.serversAwaiting(.unlockKey), [domain])
        XCTAssertEqual(app.serversAwaiting(.entitlement), [domain])
        // The flat inbox view sees both requests.
        XCTAssertEqual(app.boxRequests.count, 2)
    }

    func test_emptyDirectory_clearsInbox() async {
        let app = AppState(currentUser: "demo1234")
        app.boxRequestInbox = [domain: [req(.unlockKey), req(.entitlement, "e")]]
        let w = BootApprovalWatcher(app: app, pollAwaiting: { [:] }, pollIntervalNanos: 1)
        let published = await w.pollOnce()
        XCTAssertTrue(published.isEmpty)
        XCTAssertTrue(app.boxRequestInbox.isEmpty)
        XCTAssertFalse(app.hasLiveUnlockRequest(forFqdn: domain))
        XCTAssertFalse(app.hasLiveEntitlementRequest(forFqdn: domain))
    }

    func test_blip_closureReturnsPriorInbox_untouched() async {
        // The directory closure is best-effort: on a fetch blip it returns the
        // prior inbox, so the published inbox is unchanged — no thrash.
        let app = AppState(currentUser: "demo1234")
        app.boxRequestInbox = [domain: [req(.unlockKey)]]
        let prior = app.boxRequestInbox
        let w = BootApprovalWatcher(app: app, pollAwaiting: { prior }, pollIntervalNanos: 1)
        let published = await w.pollOnce()
        XCTAssertEqual(published, prior)
        XCTAssertTrue(app.hasLiveUnlockRequest(forFqdn: domain))
    }

    /// One pod can carry BOTH a unlock and an entitlement request at once — they
    /// coexist in the SAME inbox entry rather than racing across two sets.
    func test_oneInbox_holdsBothTypesForOnePod() {
        let app = AppState(currentUser: "demo1234")
        app.boxRequestInbox = [domain: [req(.unlockKey, "u"), req(.entitlement, "e")]]
        XCTAssertEqual(app.boxRequests(forFqdn: domain, type: .unlockKey).count, 1)
        XCTAssertEqual(app.boxRequests(forFqdn: domain, type: .entitlement).count, 1)
        let pod = PodInfo(podId: PodInfo.podId(forFqdn: domain), name: "Home", fqdn: domain, status: .online)
        XCTAssertTrue(app.isAwaitingApproval(pod))
        XCTAssertTrue(app.isAwaitingUnlock(pod))
        XCTAssertTrue(app.isAwaitingEntitlement(pod))
    }

    /// Regression: a box that STARTS waiting after the last /pods reconcile has
    /// a stale-false per-pod `awaitingUnlock` flag, but the 5s watcher inbox is
    /// fresh. `isAwaitingUnlock` MUST OR the two — otherwise Home showed
    /// "waiting for approval" while server-detail hid the Approve card (the live
    /// office.harry2 bug). Both the badge and the card now read this one source.
    func test_isAwaitingUnlock_orsLiveInbox_whenPerPodFlagStale() {
        let app = AppState(currentUser: "demo1234")
        let pod = PodInfo(
            podId: PodInfo.podId(forFqdn: domain),
            name: "Home",
            description: nil,
            fqdn: domain,
            status: .online,            // registered; awaitingUnlock defaults false
            pendingAuthCodeSerial: nil
        )
        XCTAssertFalse(app.isAwaitingUnlock(pod))   // not in the live inbox yet
        app.boxRequestInbox = [domain: [req(.unlockKey)]]  // the 5s watcher catches up
        XCTAssertTrue(app.isAwaitingUnlock(pod))    // surfaced (was the regression)
        XCTAssertFalse(app.liveness(for: pod) == .dead) // and never reads as dead
    }
}
