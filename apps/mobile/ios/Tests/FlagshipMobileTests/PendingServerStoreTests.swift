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
}
