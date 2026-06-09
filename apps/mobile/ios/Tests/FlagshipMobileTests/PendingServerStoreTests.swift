import XCTest
@testable import FlagshipCore

/// Local persistence of pending (in-flight) servers so they survive an app
/// restart and stay cancellable until the box registers with .com.
final class PendingServerStoreTests: XCTestCase {

    private func fresh() -> (PendingServerStore, UserDefaults) {
        let d = UserDefaults(suiteName: "pending-test-\(UUID().uuidString)")!
        return (PendingServerStore(defaults: d), d)
    }

    private func rec(_ pod: String, fqdn: String) -> PendingServerStore.Record {
        .init(podId: pod, name: "Home", description: "d", fqdn: fqdn, authCodeSerial: "01ABC", createdAt: 1)
    }

    func test_addListRemoveRoundTrip() {
        let (s, _) = fresh()
        XCTAssertTrue(s.list(username: "u").isEmpty)
        s.add(username: "u", rec("pod-1", fqdn: "home.u.flagship.services"))
        XCTAssertEqual(s.list(username: "u").map(\.podId), ["pod-1"])
        s.remove(username: "u", podId: "pod-1")
        XCTAssertTrue(s.list(username: "u").isEmpty)
    }

    /// Re-minting the same name replaces the old pending record (upsert by fqdn).
    func test_addUpsertsByFqdn() {
        let (s, _) = fresh()
        s.add(username: "u", rec("pod-1", fqdn: "home.u.flagship.services"))
        s.add(username: "u", rec("pod-2", fqdn: "Home.U.Flagship.Services"))
        let recs = s.list(username: "u")
        XCTAssertEqual(recs.count, 1)
        XCTAssertEqual(recs.first?.podId, "pod-2")
    }

    /// Once the box registers (fqdn appears in the live list), the pending
    /// record is dropped — case-insensitively.
    func test_reconcileDropsRegistered() {
        let (s, _) = fresh()
        s.add(username: "u", rec("pod-1", fqdn: "a.u.flagship.services"))
        s.add(username: "u", rec("pod-2", fqdn: "b.u.flagship.services"))
        s.reconcile(username: "u", liveFqdns: ["A.U.flagship.services"])
        XCTAssertEqual(s.list(username: "u").map(\.podId), ["pod-2"])
    }

    func test_persistsAcrossInstances() {
        let (s, d) = fresh()
        s.add(username: "u", rec("pod-1", fqdn: "home.u.flagship.services"))
        XCTAssertEqual(PendingServerStore(defaults: d).list(username: "u").count, 1)
    }

    func test_perUsernameIsolation() {
        let (s, _) = fresh()
        s.add(username: "alice", rec("pod-1", fqdn: "home.alice.flagship.services"))
        XCTAssertTrue(s.list(username: "bob").isEmpty)
    }

    // MARK: - #43 — account-IRK keying (rule d)

    /// Re-using the same username under a DIFFERENT account identity (a new
    /// IRK) must NOT inherit the prior account's pending ghosts.
    func test_bindToAccount_wipesOnDifferentIdentity() {
        let (s, _) = fresh()
        s.add(username: "u", accountKey: "AAAA", rec("pod-1", fqdn: "home.u.flagship.services"))
        // Same name, brand-new identity → start clean.
        s.bindToAccount(username: "u", accountKey: "BBBB")
        XCTAssertTrue(s.list(username: "u").isEmpty)
    }

    /// The SAME identity reusing the name keeps its records (and a legacy
    /// nil-keyed envelope is adopted, not wiped).
    func test_bindToAccount_keepsRecordsForSameIdentity() {
        let (s, _) = fresh()
        // Legacy add (no key) then bind — adoption, records survive.
        s.add(username: "u", rec("pod-1", fqdn: "home.u.flagship.services"))
        s.bindToAccount(username: "u", accountKey: "AAAA")
        XCTAssertEqual(s.list(username: "u").map(\.podId), ["pod-1"])
        // Re-binding the same identity is idempotent.
        s.bindToAccount(username: "u", accountKey: "aaaa")  // case-insensitive
        XCTAssertEqual(s.list(username: "u").map(\.podId), ["pod-1"])
    }

    // MARK: - #43 — drop ghosts against server truth (rule b/c)

    /// A local pending record whose serial is in NEITHER the outstanding
    /// orders NOR the registered set is a ghost — dropped, and its podId
    /// returned so the caller can purge AppState too.
    func test_dropGhosts_removesDeadSerial() {
        let (s, _) = fresh()
        s.add(username: "u", .init(podId: "ghost", name: "Home1", description: "", fqdn: "home1.u.flagship.services", authCodeSerial: "DEAD", createdAt: 1))
        s.add(username: "u", .init(podId: "live", name: "Home2", description: "", fqdn: "home2.u.flagship.services", authCodeSerial: "LIVE", createdAt: 2))
        let dropped = s.dropGhosts(username: "u", outstandingSerials: ["LIVE"], liveFqdns: [])
        XCTAssertEqual(dropped, ["ghost"])
        XCTAssertEqual(s.list(username: "u").map(\.podId), ["live"])
    }

    /// A record whose fqdn has registered is kept (the caller flips it
    /// online), not treated as a ghost even if its serial isn't outstanding.
    func test_dropGhosts_keepsRegisteredFqdn() {
        let (s, _) = fresh()
        s.add(username: "u", .init(podId: "reg", name: "Home", description: "", fqdn: "home.u.flagship.services", authCodeSerial: "USED", createdAt: 1))
        let dropped = s.dropGhosts(username: "u", outstandingSerials: [], liveFqdns: ["HOME.u.flagship.services"])
        XCTAssertTrue(dropped.isEmpty)
        XCTAssertEqual(s.list(username: "u").map(\.podId), ["reg"])
    }
}
