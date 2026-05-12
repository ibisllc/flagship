import XCTest
@testable import FlagshipCore

final class AppStateTests: XCTestCase {

    func test_completeOnboarding_setsLeaderToFirstPod() {
        let s = AppState()
        let a = PodInfo(podId: "a", name: "A", fqdn: "a.user.flagship.services")
        let b = PodInfo(podId: "b", name: "B", fqdn: "b.user.flagship.services")
        s.completeOnboarding(username: "harry", pods: [a, b])
        XCTAssertTrue(s.isPaired)
        XCTAssertEqual(s.currentUser, "harry")
        XCTAssertEqual(s.leaderPodId, "a")
        XCTAssertEqual(s.leaderPod?.podId, "a")
    }

    func test_addPod_setsLeaderWhenNonePresent() {
        let s = AppState()
        s.completeOnboarding(username: "u", pods: [])
        XCTAssertNil(s.leaderPodId)
        let p = PodInfo(podId: "first", name: "First", fqdn: "first.u.flagship.services")
        s.addPod(p)
        XCTAssertEqual(s.leaderPodId, "first")
    }

    func test_addPod_doesNotChangeLeaderIfOneExists() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services")],
            leaderPodId: "a"
        )
        s.addPod(PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services"))
        XCTAssertEqual(s.leaderPodId, "a")
    }

    func test_setLeader_onlyAcceptsExistingPodIds() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services"),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services")
            ],
            leaderPodId: "a"
        )
        s.setLeader("b")
        XCTAssertEqual(s.leaderPodId, "b")
        s.setLeader("nonexistent")
        XCTAssertEqual(s.leaderPodId, "b", "Unknown podIds should be ignored.")
    }

    func test_removePod_reassignsLeaderWhenLeaderRemoved() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [
                PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services"),
                PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services")
            ],
            leaderPodId: "a"
        )
        s.removePod("a")
        XCTAssertEqual(s.leaderPodId, "b")
    }

    func test_signOut_clearsEverything() {
        let s = AppState(
            isPaired: true,
            currentUser: "u",
            pods: [PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services")],
            leaderPodId: "a"
        )
        s.signOut()
        XCTAssertFalse(s.isPaired)
        XCTAssertNil(s.currentUser)
        XCTAssertTrue(s.pods.isEmpty)
        XCTAssertNil(s.leaderPodId)
    }
}
