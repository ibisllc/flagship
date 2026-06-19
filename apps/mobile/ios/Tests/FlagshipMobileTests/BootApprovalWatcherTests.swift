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

    func test_publishesAwaitingSetFromDirectory() async {
        let app = AppState(currentUser: "demo1234")
        let w = BootApprovalWatcher(app: app, pollAwaiting: { [self] in [domain] }, pollIntervalNanos: 1)
        let set = await w.pollOnce()
        XCTAssertEqual(set, [domain])
        XCTAssertEqual(app.serversAwaitingApproval, [domain])
    }

    func test_emptyDirectory_clearsSet() async {
        let app = AppState(currentUser: "demo1234")
        app.serversAwaitingApproval = [domain]
        let w = BootApprovalWatcher(app: app, pollAwaiting: { [] }, pollIntervalNanos: 1)
        let set = await w.pollOnce()
        XCTAssertTrue(set.isEmpty)
        XCTAssertTrue(app.serversAwaitingApproval.isEmpty)
    }

    func test_blip_closureReturnsPriorSet_untouched() async {
        // The directory closure is best-effort: on a fetch blip it returns the
        // prior set, so the published set is unchanged — no thrash.
        let app = AppState(currentUser: "demo1234")
        app.serversAwaitingApproval = [domain]
        let prior = app.serversAwaitingApproval
        let w = BootApprovalWatcher(app: app, pollAwaiting: { prior }, pollIntervalNanos: 1)
        let set = await w.pollOnce()
        XCTAssertEqual(set, [domain])
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
