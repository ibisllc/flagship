import XCTest
@testable import FlagshipCore

/// The three states of a registered-but-not-yet-online server, plus the
/// online short-circuit. A box actively trying to boot (a live unlock request)
/// or freshly registered must NOT read as "dead"; only a genuinely-stale box
/// (no request, past the grace window) is `dead` and thus deletable.
final class PodLivenessStateTests: XCTestCase {
    private let now: Int64 = 1_000_000_000_000

    private func pod(
        status: PodInfo.Status = .online,
        cameOnline: Bool = false,
        registeredAt: Int64 = 0
    ) -> PodInfo {
        PodInfo(
            podId: "pod-x",
            name: "X",
            fqdn: "box.harry.flagship.services",
            status: status,
            cameOnline: cameOnline,
            registeredAt: registeredAt
        )
    }

    func test_online_whenCheckedIn() {
        let p = pod(status: .online, cameOnline: true, registeredAt: now)
        XCTAssertEqual(p.livenessState(hasLiveUnlockRequest: false, now: now), .online)
    }

    func test_waitingForApproval_whenLiveUnlockRequestExists() {
        // Registered long ago (would otherwise be dead) but a live unlock
        // request overrides: the box is actively waiting for the owner.
        let p = pod(registeredAt: now - 60 * 60 * 1000)
        XCTAssertEqual(p.livenessState(hasLiveUnlockRequest: true, now: now), .waitingForApproval)
    }

    func test_comingOnline_withinGraceWindow() {
        let p = pod(registeredAt: now - 5 * 60 * 1000)
        XCTAssertEqual(p.livenessState(hasLiveUnlockRequest: false, now: now), .comingOnline)
    }

    func test_dead_pastGraceWindowWithNoRequest() {
        let p = pod(registeredAt: now - (PodInfo.comingOnlineGraceMs + 1000))
        XCTAssertEqual(p.livenessState(hasLiveUnlockRequest: false, now: now), .dead)
    }

    func test_pendingPod_isComingOnlineNeverDead() {
        // A pre-registration pending pod has registeredAt 0 — it must never
        // classify as dead (the list keeps its own Pending pill for it).
        let p = pod(status: .pending, registeredAt: 0)
        XCTAssertEqual(p.livenessState(hasLiveUnlockRequest: false, now: now), .comingOnline)
    }

    func test_appState_livenessUsesAwaitingSet() {
        let s = AppState(currentUser: "harry")
        let fqdn = "box.harry.flagship.services"
        s.pods = [pod(registeredAt: now - 60 * 60 * 1000)]
        // No waiting set ⇒ dead (old registration, no check-in).
        XCTAssertEqual(s.liveness(for: s.pods[0]), .dead)
        // Mark it waiting ⇒ waitingForApproval, never dead.
        s.serversAwaitingApproval = [fqdn]
        XCTAssertEqual(s.liveness(for: s.pods[0]), .waitingForApproval)
    }

    func test_upsertRegisteredPod_threadsRegisteredAt() {
        let s = AppState(currentUser: "harry")
        _ = s.upsertRegisteredPod(
            fqdn: "box.harry.flagship.services",
            name: "Box",
            cameOnline: false,
            registeredAt: now
        )
        XCTAssertEqual(s.pods.first?.registeredAt, now)
    }
}
