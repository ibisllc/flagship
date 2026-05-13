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
}
