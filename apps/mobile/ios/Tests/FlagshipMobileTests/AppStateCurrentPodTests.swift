import XCTest
@testable import FlagshipCore

final class AppStateCurrentPodTests: XCTestCase {

    func test_completeOnboarding_setsCurrentToFirstPod() {
        let s = AppState()
        s.completeOnboarding(username: "u", pods: [
            PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services"),
            PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services")
        ])
        XCTAssertEqual(s.currentPodId, "a")
        XCTAssertEqual(s.currentPod?.podId, "a")
    }

    func test_setCurrentPod_acceptsKnownPodId() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services"),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services")
            ],
            leaderPodId: "a",
            currentPodId: "a"
        )
        s.setCurrentPod("b")
        XCTAssertEqual(s.currentPodId, "b")
    }

    func test_setCurrentPod_rejectsUnknown() {
        let s = AppState(
            isPaired: true, currentUser: "u",
            pods: [PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services")],
            leaderPodId: "a", currentPodId: "a"
        )
        s.setCurrentPod("nope")
        XCTAssertEqual(s.currentPodId, "a")
    }

    func test_setLeader_doesNotChangeCurrent() {
        let s = AppState(
            isPaired: true, currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services"),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services")
            ],
            leaderPodId: "a", currentPodId: "a"
        )
        s.setLeader("b")
        XCTAssertEqual(s.leaderPodId, "b")
        XCTAssertEqual(s.currentPodId, "a",
                       "Leader change is independent of which pod is the active screens-client target.")
    }

    func test_removePod_reassignsCurrent() {
        let s = AppState(
            isPaired: true, currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services"),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services")
            ],
            leaderPodId: "a", currentPodId: "a"
        )
        s.removePod("a")
        XCTAssertEqual(s.currentPodId, "b")
    }

    // MARK: - sessionPod (the box-session anchor must be a LIVE pod)

    /// The bug: the leader/currentPod defaults to the OLDEST pod, liveness-blind.
    /// When that's a dead zombie, PodSessionSync nulls the box base URL → every
    /// pod's detail bricks. `sessionPod` must skip the dead anchor for a live pod.
    func test_sessionPod_prefersLivePodWhenTheLeaderIsOffline() {
        let s = AppState(
            isPaired: true, currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services", status: .offline),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services", status: .online)
            ],
            leaderPodId: "a", currentPodId: "a"
        )
        XCTAssertEqual(s.currentPod?.podId, "a", "currentPod is the dead leader (the old behavior).")
        XCTAssertEqual(s.sessionPod?.podId, "b",
                       "A dead/oldest leader must NOT anchor the box session; a live pod wins.")
    }

    func test_sessionPod_honorsAnExplicitlySelectedOnlinePod() {
        let s = AppState(
            isPaired: true, currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services", status: .online),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services", status: .online)
            ],
            leaderPodId: "a", currentPodId: "b"
        )
        XCTAssertEqual(s.sessionPod?.podId, "b", "An explicitly-selected ONLINE pod is the anchor.")
    }

    func test_sessionPod_isNilWhenNoPodIsOnline() {
        let s = AppState(
            isPaired: true, currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services", status: .offline),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services", status: .pending)
            ],
            leaderPodId: "a", currentPodId: "a"
        )
        XCTAssertNil(s.sessionPod, "No online pod ⇒ no box-session anchor (nothing reachable).")
    }
}
