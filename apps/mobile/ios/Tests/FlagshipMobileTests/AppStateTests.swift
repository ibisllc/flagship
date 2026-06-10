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

    func test_restorePersistedSession_pairsWithUsernameAndNoPods() {
        // Cold-launch restore: the Keystore still holds an identity, so
        // the shell rebinds the session instead of forcing a fresh
        // sign-in. Pods are intentionally empty — the tabs refetch them.
        let s = AppState()
        XCTAssertFalse(s.isPaired)
        s.restorePersistedSession(username: "harry")
        XCTAssertTrue(s.isPaired)
        XCTAssertEqual(s.currentUser, "harry")
        XCTAssertEqual(s.activeProfileCloudName, "harry")
        XCTAssertTrue(s.pods.isEmpty)
    }

    func test_restorePersistedSession_isNoOpWhenAlreadyPaired() {
        // A live pairing / smoke mode must win over a stale restore.
        let s = AppState()
        s.completeOnboarding(
            username: "alice",
            pods: [PodInfo(podId: "p", name: "P", fqdn: "p.alice.flagship.services")]
        )
        s.restorePersistedSession(username: "mallory")
        XCTAssertEqual(s.currentUser, "alice")
        XCTAssertEqual(s.leaderPodId, "p")
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

    // #50 — registration is authoritative for online.
    func test_upsertRegisteredPod_addsOnlinePodWhenAbsent() {
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [])
        let id = s.upsertRegisteredPod(fqdn: "home.harry.flagship.services", name: "Home")
        XCTAssertEqual(s.pods.count, 1)
        XCTAssertEqual(s.pods.first?.status, .online)
        XCTAssertEqual(id, PodInfo.podId(forFqdn: "home.harry.flagship.services"))
    }

    func test_upsertRegisteredPod_flipsPendingPodInPlace() {
        let fqdn = "home.harry.flagship.services"
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "pending-id", name: "My Home", description: "desc",
                    fqdn: fqdn, status: .pending, pendingAuthCodeSerial: "SER")
        ])
        s.setLeader("pending-id")
        let id = s.upsertRegisteredPod(fqdn: fqdn, name: "ignored")
        XCTAssertEqual(s.pods.count, 1, "no duplicate")
        XCTAssertEqual(id, "pending-id", "flipped in place, podId preserved")
        XCTAssertEqual(s.pods.first?.status, .online)
        XCTAssertEqual(s.pods.first?.name, "My Home", "kept the user's typed name")
        XCTAssertNil(s.pods.first?.pendingAuthCodeSerial)
        XCTAssertEqual(s.leaderPodId, "pending-id", "leader selection undisturbed")
    }

    func test_upsertRegisteredPod_isIdempotentForOnlinePod() {
        let fqdn = "home.harry.flagship.services"
        let s = AppState()
        s.completeOnboarding(username: "harry", pods: [
            PodInfo(podId: "online-id", name: "Home", fqdn: fqdn, status: .online)
        ])
        let id = s.upsertRegisteredPod(fqdn: fqdn, name: "ignored")
        XCTAssertEqual(s.pods.count, 1)
        XCTAssertEqual(id, "online-id")
        XCTAssertEqual(s.pods.first?.name, "Home")
    }

    // MARK: - upsertPendingPod (delivered-page instant surface)

    func test_upsertPendingPod_insertsFreshPodKeyedOnFqdn() {
        let s = AppState()
        let id = s.upsertPendingPod(
            name: "abc", description: "box",
            fqdn: "abc.harry.flagship.services", serial: "SER-1"
        )
        XCTAssertEqual(s.pods.count, 1)
        XCTAssertEqual(id, PodInfo.podId(forFqdn: "abc.harry.flagship.services"))
        XCTAssertEqual(s.pods.first?.status, .pending)
        XCTAssertEqual(s.pods.first?.pendingAuthCodeSerial, "SER-1")
    }

    func test_upsertPendingPod_isIdempotent_noDuplicate() {
        // Fires on delivered-page appear AND again on "Done".
        let s = AppState()
        let first = s.upsertPendingPod(
            name: "abc", description: nil,
            fqdn: "abc.harry.flagship.services", serial: "SER-1"
        )
        let second = s.upsertPendingPod(
            name: "abc", description: nil,
            fqdn: "ABC.harry.flagship.services", serial: "SER-1"
        )
        XCTAssertEqual(s.pods.count, 1)
        XCTAssertEqual(first, second)
        XCTAssertEqual(s.pods.first?.pendingAuthCodeSerial, "SER-1")
    }

    func test_upsertPendingPod_attachesSerialToReconcilerSurfacedTwin() {
        // The /pods reconciler can surface the order serial-less BEFORE the
        // create flow upserts (the directory only carries opaque orderRefs).
        // The creating device's upsert must attach its locally-known serial
        // in place — restoring deep progress + cancel — not duplicate.
        let s = AppState()
        s.addPod(PodInfo(
            podId: PodInfo.podId(forFqdn: "abc.harry.flagship.services"),
            name: "abc", description: nil,
            fqdn: "abc.harry.flagship.services",
            status: .pending, pendingAuthCodeSerial: nil
        ))
        let id = s.upsertPendingPod(
            name: "abc", description: "my box",
            fqdn: "abc.harry.flagship.services", serial: "SER-9"
        )
        XCTAssertEqual(s.pods.count, 1)
        XCTAssertEqual(id, PodInfo.podId(forFqdn: "abc.harry.flagship.services"))
        XCTAssertEqual(s.pods.first?.pendingAuthCodeSerial, "SER-9")
        XCTAssertEqual(s.pods.first?.description, "my box")
    }

    func test_upsertPendingPod_neverDowngradesKnownSerialOrOnlinePod() {
        let fqdn = "abc.harry.flagship.services"
        let s = AppState()
        s.addPod(PodInfo(
            podId: "p1", name: "abc", fqdn: fqdn,
            status: .pending, pendingAuthCodeSerial: "SER-1"
        ))
        s.upsertPendingPod(name: "abc", description: nil, fqdn: fqdn, serial: nil)
        XCTAssertEqual(s.pods.first?.pendingAuthCodeSerial, "SER-1", "nil never clobbers a known serial")

        let online = AppState()
        online.addPod(PodInfo(podId: "o1", name: "abc", fqdn: fqdn, status: .online))
        let id = online.upsertPendingPod(name: "abc", description: nil, fqdn: fqdn, serial: "SER-2")
        XCTAssertEqual(id, "o1")
        XCTAssertEqual(online.pods.first?.status, .online, "online pod always wins")
    }
}
