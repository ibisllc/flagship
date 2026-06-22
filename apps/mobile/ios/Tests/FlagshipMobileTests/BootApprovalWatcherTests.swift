import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// `BootApprovalWatcher` is the account-level "which boxes are waiting?" poll.
/// It is now DIRECTORY-DRIVEN (no biometric): a `pollAwaiting` closure reads the
/// unauthenticated `/pods` `awaitingUnlock` flags and the watcher publishes the
/// resulting set on AppState. (The old version derived the IRK every 5s, which
/// fired Face ID on a timer on device.)
@MainActor
final class BootApprovalWatcherTests: XCTestCase {
    private let domain = "home.demo1234.flagship.services"

    func test_publishesAwaitingSetsFromDirectory() async {
        let app = AppState(currentUser: "demo1234")
        let w = BootApprovalWatcher(
            app: app,
            pollAwaiting: { [self] in PendingApprovalSets(unlock: [domain], entitlement: [domain]) },
            pollIntervalNanos: 1
        )
        let sets = await w.pollOnce()
        XCTAssertEqual(sets.unlock, [domain])
        XCTAssertEqual(sets.entitlement, [domain])
        XCTAssertEqual(app.serversAwaitingApproval, [domain])
        // The entitlement lane is the new Box Request Inbox surfacing.
        XCTAssertEqual(app.serversAwaitingEntitlement, [domain])
    }

    func test_emptyDirectory_clearsSets() async {
        let app = AppState(currentUser: "demo1234")
        app.serversAwaitingApproval = [domain]
        app.serversAwaitingEntitlement = [domain]
        let w = BootApprovalWatcher(app: app, pollAwaiting: { PendingApprovalSets() }, pollIntervalNanos: 1)
        let sets = await w.pollOnce()
        XCTAssertTrue(sets.unlock.isEmpty)
        XCTAssertTrue(app.serversAwaitingApproval.isEmpty)
        XCTAssertTrue(app.serversAwaitingEntitlement.isEmpty)
    }

    func test_blip_closureReturnsPriorSets_untouched() async {
        // The directory closure is best-effort: on a fetch blip it returns the
        // prior sets, so the published sets are unchanged — no thrash.
        let app = AppState(currentUser: "demo1234")
        app.serversAwaitingApproval = [domain]
        let prior = PendingApprovalSets(
            unlock: app.serversAwaitingApproval,
            entitlement: app.serversAwaitingEntitlement
        )
        let w = BootApprovalWatcher(app: app, pollAwaiting: { prior }, pollIntervalNanos: 1)
        let sets = await w.pollOnce()
        XCTAssertEqual(sets.unlock, [domain])
    }

    /// Regression: a box that STARTS waiting after the last /pods reconcile has
    /// a stale-false per-pod `awaitingUnlock` flag, but the 5s watcher set is
    /// fresh. `isAwaitingUnlock` MUST OR the two — otherwise Home showed
    /// "waiting for approval" while server-detail hid the Approve card (the live
    /// office.harry2 bug). Both the badge and the card now read this one source.
    func test_isAwaitingUnlock_orsLiveWatcherSet_whenPerPodFlagStale() {
        let app = AppState(currentUser: "demo1234")
        let pod = PodInfo(
            podId: PodInfo.podId(forFqdn: domain),
            name: "Home",
            description: nil,
            fqdn: domain,
            status: .online,            // registered; awaitingUnlock defaults false
            pendingAuthCodeSerial: nil
        )
        XCTAssertFalse(app.isAwaitingUnlock(pod))   // not in the live set yet
        app.serversAwaitingApproval = [domain]      // the 5s watcher catches up
        XCTAssertTrue(app.isAwaitingUnlock(pod))    // surfaced (was the regression)
        XCTAssertFalse(app.liveness(for: pod) == .dead) // and never reads as dead
    }
}
