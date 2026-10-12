import XCTest
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class PendingUpdateStoreTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let from = "1234567890abcdef1234567890abcdef12345678"
    private let target = "9f2c1ab3de4567890abcdef1234567890abcdef1"
    private let orderedAt: Int64 = 1_000_000_000

    private func freshStore() -> PendingUpdateStore {
        PendingUpdateStore(defaults: UserDefaults(suiteName: "pending-update-\(UUID().uuidString)")!)
    }

    private func order(tag: String? = "v1.4.0") -> PendingUpdateOrder {
        PendingUpdateOrder(targetCommit: target, targetTag: tag, fromCommit: from, orderedAt: orderedAt)
    }

    // MARK: - Card mode

    func testARefusalAfterTheOrderClearsItThoughItNamesNoTarget() {
        let o = PendingUpdateOrder(targetCommit: String(repeating: "b", count: 40), fromCommit: String(repeating: "a", count: 40), orderedAt: 1_000)
        XCTAssertTrue(o.isResolved(currentCommit: String(repeating: "a", count: 40), lastUpdate: LastUpdate(outcome: "refused", at: 2_000, reason: "not-endorsed")))
        XCTAssertFalse(o.isResolved(currentCommit: String(repeating: "a", count: 40), lastUpdate: LastUpdate(outcome: "refused", at: 500, reason: "not-endorsed")))
    }

    func testCardShowsButtonWithNoPendingOrder() {
        let mode = UpdateCardMode(pending: nil, now: orderedAt)
        XCTAssertEqual(mode, .ready)
        XCTAssertTrue(mode.showsUpdateButton)
    }

    func testCardShowsPendingAndHidesButton() {
        let o = order()
        let mode = UpdateCardMode(pending: o, now: orderedAt + 3 * 60_000)
        XCTAssertEqual(mode, .pending(o))
        XCTAssertFalse(mode.showsUpdateButton)
        XCTAssertEqual(
            o.sentCopy(now: orderedAt + 3 * 60_000),
            "Update to v1.4.0 sent 3 minutes ago. The server picks it up within about five minutes, restarts, and goes back on its own if the new version doesn't start."
        )
    }

    func testCopyFallsBackToShortCommitAndJustNow() {
        let o = order(tag: nil)
        XCTAssertTrue(o.sentCopy(now: orderedAt + 5_000).hasPrefix("Update to 9f2c1ab3 sent just now."))
        XCTAssertEqual(PendingUpdateOrder.ago(ms: 60_000), "1 minute ago")
        XCTAssertEqual(PendingUpdateOrder.ago(ms: 2 * 3_600_000), "2 hours ago")
    }

    func testStaleAfterThirtyMinutes() {
        let o = order()
        XCTAssertEqual(UpdateCardMode(pending: o, now: orderedAt + 29 * 60_000 + 59_999), .pending(o))
        let stale = UpdateCardMode(pending: o, now: orderedAt + 30 * 60_000)
        XCTAssertEqual(stale, .stale(o))
        XCTAssertFalse(stale.showsUpdateButton)
        XCTAssertEqual(PendingUpdateOrder.staleCopy, "The server hasn't applied this update yet. It may be offline.")
    }

    func testForgetClearsAStaleOrder() {
        let store = freshStore()
        store.save(order(), serverFqdn: server)
        store.clear(serverFqdn: server)
        XCTAssertEqual(UpdateCardMode(pending: store.load(serverFqdn: server), now: orderedAt + 31 * 60_000), .ready)
    }

    // MARK: - Sheet

    func testSheetOpensInPostSendStateWhilePending() {
        XCTAssertTrue(UpdateServerSheet.showsPostSend(phase: .idle, pending: order()))
        XCTAssertTrue(UpdateServerSheet.showsPostSend(phase: .done, pending: nil))
        XCTAssertFalse(UpdateServerSheet.showsPostSend(phase: .idle, pending: nil))
        XCTAssertFalse(UpdateServerSheet.showsPostSend(phase: .failed("x"), pending: nil))
    }

    // MARK: - Reconcile

    func testClearedWhenBoxRunsTarget() {
        let store = freshStore()
        store.save(order(), serverFqdn: server)
        XCTAssertNotNil(store.reconcile(serverFqdn: server, currentCommit: from, lastUpdate: nil))
        XCTAssertNil(store.reconcile(serverFqdn: server, currentCommit: target.uppercased(), lastUpdate: nil))
        XCTAssertNil(store.load(serverFqdn: server))
    }

    func testClearedByMatchingNewerLastUpdateForEachOutcome() {
        for outcome in ["applied", "rolled-back", "refused"] {
            let store = freshStore()
            store.save(order(), serverFqdn: server)
            let lu = LastUpdate(outcome: outcome, at: orderedAt + 1, targetCommit: target, previousCommit: from, reason: outcome == "refused" ? "unendorsed" : nil)
            XCTAssertNil(store.reconcile(serverFqdn: server, currentCommit: from, lastUpdate: lu), outcome)
            XCTAssertNil(store.load(serverFqdn: server), outcome)
        }
    }

    func testLastUpdateAtOrderTimeCounts() {
        let store = freshStore()
        store.save(order(), serverFqdn: server)
        let lu = LastUpdate(outcome: "applied", at: orderedAt, targetCommit: target)
        XCTAssertNil(store.reconcile(serverFqdn: server, currentCommit: from, lastUpdate: lu))
    }

    func testKeptForOlderOrOtherLastUpdate() {
        let store = freshStore()
        store.save(order(), serverFqdn: server)
        let older = LastUpdate(outcome: "rolled-back", at: orderedAt - 1, targetCommit: target, previousCommit: from)
        XCTAssertNotNil(store.reconcile(serverFqdn: server, currentCommit: from, lastUpdate: older))
        let other = LastUpdate(outcome: "applied", at: orderedAt + 10, targetCommit: from)
        XCTAssertNotNil(store.reconcile(serverFqdn: server, currentCommit: from, lastUpdate: other))
        let noTarget = LastUpdate(outcome: "refused", at: orderedAt - 10, reason: "stale")
        XCTAssertNotNil(store.reconcile(serverFqdn: server, currentCommit: from, lastUpdate: noTarget))
        XCTAssertNotNil(store.load(serverFqdn: server))
    }

    func testOlderBoxWithoutCommitStaysPending() {
        let store = freshStore()
        store.save(order(), serverFqdn: server)
        XCTAssertNotNil(store.reconcile(serverFqdn: server, currentCommit: nil, lastUpdate: nil))
    }

    func testPerServerIsolation() {
        let store = freshStore()
        let other = "work.alice.flagship.services"
        store.save(order(), serverFqdn: server)
        XCTAssertNil(store.load(serverFqdn: other))
        XCTAssertNil(store.reconcile(serverFqdn: other, currentCommit: target, lastUpdate: nil))
        XCTAssertNotNil(store.load(serverFqdn: server), "another server's outcome never clears this one")
        XCTAssertNil(store.reconcile(serverFqdn: server, currentCommit: target, lastUpdate: nil))
    }

    func testCorruptStorageReadsAsNoOrder() {
        let defaults = UserDefaults(suiteName: "pending-update-\(UUID().uuidString)")!
        defaults.set(Data("not json".utf8), forKey: "flagship.pendingUpdate.\(server)")
        XCTAssertNil(PendingUpdateStore(defaults: defaults).load(serverFqdn: server))
    }
}
