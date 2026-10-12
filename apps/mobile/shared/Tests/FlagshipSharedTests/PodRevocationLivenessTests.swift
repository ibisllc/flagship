import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Revoked-server listing and the never-came-online liveness rule.
final class PodRevocationLivenessTests: XCTestCase {
    private let grace = PodInfo.comingOnlineGraceMs
    private let registeredAt: Int64 = 1_700_000_000_000

    private func neverPod(registeredAt: Int64) -> PodInfo {
        PodInfo(podId: "p", name: "home", fqdn: "home.harry.flagship.services",
                status: .unknown, cameOnline: false, registeredAt: registeredAt, liveness: .never)
    }

    // MARK: - `liveness == "never"`

    func testNeverInsideGraceIsComingOnline() {
        let pod = neverPod(registeredAt: registeredAt)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: false, now: registeredAt + grace), .comingOnline)
    }

    func testNeverPastGraceIsDead() {
        let pod = neverPod(registeredAt: registeredAt)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: false, now: registeredAt + grace + 1), .dead)
    }

    func testNeverPastGraceWithUnlockRequestIsWaiting() {
        let pod = neverPod(registeredAt: registeredAt)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: true, now: registeredAt + grace * 10), .waitingForApproval)
    }

    func testNeverWithUnknownRegistrationIsDead() {
        let pod = neverPod(registeredAt: 0)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: false, now: registeredAt), .dead)
    }

    // MARK: - Revoked

    func testRevokedWinsOverEverySignal() {
        let pod = PodInfo(podId: "p", name: "home", fqdn: "home.harry.flagship.services",
                          status: .online, liveness: .live, revokedAt: 5, revocationReason: "stolen")
        XCTAssertTrue(pod.isRevoked)
        XCTAssertEqual(pod.livenessState(hasLiveUnlockRequest: true), .revoked)
    }

    @MainActor
    func testRevokedRegistrationIsNeverSessionEligible() {
        let app = AppState(isPaired: true, currentUser: "harry")
        app.upsertRegisteredPod(fqdn: "home.harry.flagship.services", name: "home",
                                liveness: .live, revokedAt: 5, revocationReason: "lost")
        XCTAssertEqual(app.pods.first?.status, .offline)
        XCTAssertNil(app.sessionPod)
    }

    @MainActor
    func testRevokeThenUnrevokeLocally() {
        let app = AppState(isPaired: true, currentUser: "harry")
        let fqdn = "home.harry.flagship.services"
        app.upsertRegisteredPod(fqdn: fqdn, name: "home", liveness: .live)
        app.setPodRevoked(fqdn: fqdn, revokedAt: 9, reason: "stolen")
        XCTAssertEqual(app.liveness(for: app.pods[0]), .revoked)
        XCTAssertEqual(app.pods[0].revocationReason, "stolen")
        app.setPodRevoked(fqdn: fqdn, revokedAt: nil, reason: "stolen")
        XCTAssertFalse(app.pods[0].isRevoked)
        XCTAssertNil(app.pods[0].revocationReason)
        XCTAssertNotEqual(app.liveness(for: app.pods[0]), .revoked)
    }

    @MainActor
    func testUpsertReflowsWhenOnlyRevocationChanges() {
        let app = AppState(isPaired: true, currentUser: "harry")
        let fqdn = "home.harry.flagship.services"
        app.upsertRegisteredPod(fqdn: fqdn, name: "home", cameOnline: true, liveness: .unreachable)
        app.upsertRegisteredPod(fqdn: fqdn, name: "home", cameOnline: true, liveness: .unreachable,
                                revokedAt: 3, revocationReason: "decommissioned")
        XCTAssertEqual(app.pods[0].revokedAt, 3)
    }

    // MARK: - Directory entry

    func testDirectoryEntryDecodesRevocationReason() throws {
        let json = #"{"serverDomain":"home.harry.flagship.services","identityPubKey":"aa","revokedAt":5,"revocationReason":"lost"}"#
        let entry = try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.revocationReason, "lost")
        XCTAssertTrue(entry.isRestorableRevoke)
    }

    func testDirectoryEntryToleratesMissingReason() throws {
        let json = #"{"serverDomain":"home.harry.flagship.services","identityPubKey":"aa","revokedAt":5}"#
        let entry = try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(json.utf8))
        XCTAssertNil(entry.revocationReason)
        XCTAssertFalse(entry.isRestorableRevoke, "a revoke with no reason is a delete, not restorable")
    }

    func testOnlyOwnerReasonsAreRestorable() {
        for reason in ["lost", "stolen", "decommissioned"] {
            XCTAssertTrue(PodDirectoryEntry(serverDomain: "a", identityPubKey: "aa", revokedAt: 1, revocationReason: reason).isRestorableRevoke)
        }
        for reason in ["released", "transferred", "account-deleted", "self-revoked", ""] {
            XCTAssertFalse(PodDirectoryEntry(serverDomain: "a", identityPubKey: "aa", revokedAt: 1, revocationReason: reason).isRestorableRevoke)
        }
        XCTAssertFalse(PodDirectoryEntry(serverDomain: "a", identityPubKey: "aa", revocationReason: "lost").isRestorableRevoke,
                       "not revoked at all")
    }
}
