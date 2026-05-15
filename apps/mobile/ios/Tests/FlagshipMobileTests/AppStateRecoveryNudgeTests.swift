import XCTest
@testable import FlagshipCore

/// shouldShowRecoveryNudge() composes three signals — at-least-one
/// online pod, no cloud recovery, no in-session dismissal. The
/// per-signal exercises below pin each branch so a regression
/// reveals itself in the test names rather than as a stale banner
/// in the simulator.
final class AppStateRecoveryNudgeTests: XCTestCase {

    private func onlinePod(_ id: String = "a") -> PodInfo {
        PodInfo(podId: id, name: id.uppercased(), fqdn: "\(id).u.flagship.services", status: .online)
    }
    private func pendingPod(_ id: String = "p") -> PodInfo {
        PodInfo(podId: id, name: id.uppercased(), fqdn: "\(id).u.flagship.services", status: .pending)
    }

    func test_noNudge_whenAlreadyEnrolled() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [onlinePod()],
            hasCloudRecovery: true
        )
        XCTAssertFalse(s.shouldShowRecoveryNudge)
    }

    func test_noNudge_whenNoOnlinePodYet() {
        // Account exists with only pending pods — we don't bug the
        // user during day-0 onboarding. Recovery enrolment is for
        // accounts with real state worth losing.
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [pendingPod()],
            hasCloudRecovery: false
        )
        XCTAssertFalse(s.shouldShowRecoveryNudge)
    }

    func test_noNudge_whenDismissedThisSession() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [onlinePod()],
            hasCloudRecovery: false,
            recoveryNudgeDismissedThisSession: true
        )
        XCTAssertFalse(s.shouldShowRecoveryNudge)
    }

    func test_nudge_whenOnlinePodExistsAndNotEnrolledAndNotDismissed() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [onlinePod()],
            hasCloudRecovery: false,
            recoveryNudgeDismissedThisSession: false
        )
        XCTAssertTrue(s.shouldShowRecoveryNudge)
    }

    func test_nudge_appearsWhenOfflinePodFlipsToOnline() {
        let offline = PodInfo(podId: "z", name: "Z", fqdn: "z.u.flagship.services", status: .offline)
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [offline],
            hasCloudRecovery: false
        )
        XCTAssertFalse(s.shouldShowRecoveryNudge)
        // Simulate the pod transitioning to .online (the Watcher
        // would do this in production via removePod + addPod).
        s.removePod("z")
        s.addPod(PodInfo(podId: "z", name: "Z", fqdn: "z.u.flagship.services", status: .online))
        XCTAssertTrue(s.shouldShowRecoveryNudge)
    }

    func test_defaultHasCloudRecoveryIsTrue() {
        // Default suppresses the nudge — callers must opt-in by
        // setting hasCloudRecovery=false after a real .com check.
        // Avoids a flash of nudge on first launch before the lookup
        // completes.
        let s = AppState(isPaired: true, currentUser: "u", pods: [onlinePod()])
        XCTAssertFalse(s.shouldShowRecoveryNudge)
    }
}
