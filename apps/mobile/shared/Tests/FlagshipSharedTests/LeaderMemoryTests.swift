import XCTest
@testable import FlagshipCore

/// The owner's "Make leader" choice survives a cold launch, per account
/// (docs/app-placement.md §1).
final class LeaderMemoryTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "test.leaderMemory.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private let fqdnA = "home.alice.flagship.services"
    private let fqdnB = "work.alice.flagship.services"

    /// A fresh launch: a new AppState over the same on-device store, the
    /// session restored, then `/pods` reconciled oldest-first.
    private func launch(as user: String = "alice", revokedB: Bool = false, includeB: Bool = true) -> AppState {
        let s = AppState()
        s.leaderMemory = UserDefaultsLeaderMemory(defaults: defaults)
        s.restorePersistedSession(username: user)
        s.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        if includeB {
            s.upsertRegisteredPod(
                fqdn: fqdnB, name: "work", liveness: .live,
                revokedAt: revokedB ? 1_700_000_000_000 : nil,
                revocationReason: revokedB ? "lost" : nil
            )
        }
        return s
    }

    private var idA: String { PodInfo.podId(forFqdn: fqdnA) }
    private var idB: String { PodInfo.podId(forFqdn: fqdnB) }

    func test_setLeader_persistsTheChoice() {
        let s = launch()
        XCTAssertEqual(s.leaderPodId, idA, "Without a remembered choice the oldest server leads.")
        s.setLeader(idB)
        XCTAssertEqual(UserDefaultsLeaderMemory(defaults: defaults).leaderPodId(forAccount: "alice"), idB)
    }

    func test_relaunch_restoresTheLeaderAndMakesItCurrent() {
        launch().setLeader(idB)
        let s = launch()
        XCTAssertEqual(s.leaderPodId, idB)
        XCTAssertEqual(s.currentPodId, idB)
        XCTAssertEqual(s.currentPod?.podId, idB, "New apps go to the restored leader, not the oldest server.")
    }

    func test_relaunch_restoresWhicheverOrderThePodsArriveIn() {
        launch().setLeader(idB)
        let s = AppState()
        s.leaderMemory = UserDefaultsLeaderMemory(defaults: defaults)
        s.restorePersistedSession(username: "alice")
        s.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        s.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        XCTAssertEqual(s.leaderPodId, idB)
        XCTAssertEqual(s.currentPodId, idB)
    }

    func test_relaunch_ignoresARememberedLeaderThatIsGone() {
        launch().setLeader(idB)
        let s = launch(includeB: false)
        XCTAssertEqual(s.leaderPodId, idA)
        XCTAssertEqual(s.currentPodId, idA)
    }

    func test_relaunch_ignoresARememberedLeaderThatIsRevoked() {
        launch().setLeader(idB)
        let s = launch(revokedB: true)
        XCTAssertEqual(s.leaderPodId, idA)
        XCTAssertEqual(s.currentPodId, idA)
    }

    func test_restore_keepsAnExplicitCurrentPick() {
        let first = launch()
        first.setLeader(idB)
        let s = AppState()
        s.leaderMemory = UserDefaultsLeaderMemory(defaults: defaults)
        s.restorePersistedSession(username: "alice")
        s.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        s.upsertRegisteredPod(fqdn: "third.alice.flagship.services", name: "third", liveness: .live)
        s.setCurrentPod(PodInfo.podId(forFqdn: "third.alice.flagship.services"))
        s.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        XCTAssertEqual(s.leaderPodId, idB)
        XCTAssertEqual(s.currentPodId, PodInfo.podId(forFqdn: "third.alice.flagship.services"))
    }

    func test_signOut_forgetsTheChoice() {
        let s = launch()
        s.setLeader(idB)
        s.signOut()
        XCTAssertNil(UserDefaultsLeaderMemory(defaults: defaults).leaderPodId(forAccount: "alice"))
        XCTAssertEqual(launch().leaderPodId, idA)
    }

    func test_removingTheRememberedLeader_forgetsIt() {
        let s = launch()
        s.setLeader(idB)
        s.removePod(idB)
        XCTAssertNil(UserDefaultsLeaderMemory(defaults: defaults).leaderPodId(forAccount: "alice"))
        XCTAssertEqual(s.leaderPodId, idA)
    }

    func test_theChoiceIsPerAccount() {
        launch(as: "alice").setLeader(idB)
        let bob = AppState()
        bob.leaderMemory = UserDefaultsLeaderMemory(defaults: defaults)
        bob.restorePersistedSession(username: "bob")
        bob.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        bob.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        XCTAssertEqual(bob.leaderPodId, idA, "Another account on this device doesn't inherit alice's leader.")
        bob.signOut()
        XCTAssertEqual(launch(as: "alice").leaderPodId, idB, "Signing bob out leaves alice's choice alone.")
    }

    func test_switchingProfiles_restoresEachAccountsOwnLeader() {
        let s = AppState()
        s.leaderMemory = UserDefaultsLeaderMemory(defaults: defaults)
        s.addProfile(Profile(cloudName: "alice"))
        s.addProfile(Profile(cloudName: "bob"))
        let bobA = "home.bob.flagship.services", bobB = "work.bob.flagship.services"
        s.upsertRegisteredPod(fqdn: bobA, name: "home", liveness: .live)
        s.upsertRegisteredPod(fqdn: bobB, name: "work", liveness: .live)
        XCTAssertEqual(s.leaderPodId, PodInfo.podId(forFqdn: bobA))
        s.setActiveProfile("alice")
        s.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        s.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        s.setLeader(idB)
        s.setActiveProfile("bob")
        s.upsertRegisteredPod(fqdn: bobA, name: "home", liveness: .live)
        s.upsertRegisteredPod(fqdn: bobB, name: "work", liveness: .live)
        XCTAssertEqual(s.leaderPodId, PodInfo.podId(forFqdn: bobA))
        s.setActiveProfile("alice")
        s.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        s.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        XCTAssertEqual(s.leaderPodId, idB)
    }

    func test_noMemory_keepsTodaysOldestFallback() {
        let s = AppState()
        s.restorePersistedSession(username: "alice")
        s.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        s.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        s.setLeader(idB)
        let next = AppState()
        next.restorePersistedSession(username: "alice")
        next.upsertRegisteredPod(fqdn: fqdnA, name: "home", liveness: .live)
        next.upsertRegisteredPod(fqdn: fqdnB, name: "work", liveness: .live)
        XCTAssertEqual(next.leaderPodId, idA)
    }
}
