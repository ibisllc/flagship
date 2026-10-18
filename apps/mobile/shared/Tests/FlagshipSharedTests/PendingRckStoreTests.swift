import XCTest
@testable import FlagshipCore

final class PendingRckStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var clock = Date(timeIntervalSince1970: 1_700_000_000)
    private let domain = "home.harry.flagship.services"

    override func setUp() {
        super.setUp()
        let suite = "pending-rck-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        clock = Date(timeIntervalSince1970: 1_700_000_000)
    }

    private func store() -> PendingRckStore {
        PendingRckStore(defaults: defaults, now: { [unowned self] in self.clock })
    }

    func test_firstMintRecordsItsKey_andARetryReusesIt() {
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "aa" }, "aa")
        XCTAssertEqual(store().reuseOrRecord(for: domain) { XCTFail("must not mint again"); return "bb" }, "aa")
    }

    func test_nameIsCaseInsensitive() {
        _ = store().reuseOrRecord(for: "Home.Harry.flagship.services") { "aa" }
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "bb" }, "aa")
    }

    func test_otherNamesGetTheirOwnKey() {
        _ = store().reuseOrRecord(for: domain) { "aa" }
        XCTAssertEqual(store().reuseOrRecord(for: "home2.harry.flagship.services") { "bb" }, "bb")
    }

    func test_keyExpiresAfter24Hours() {
        _ = store().reuseOrRecord(for: domain) { "aa" }
        clock = clock.addingTimeInterval(PendingRckStore.ttl)
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "bb" }, "aa", "exactly at the limit still reuses")
        clock = clock.addingTimeInterval(1)
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "cc" }, "cc", "past 24 h mints a new key")
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "dd" }, "cc", "and remembers it")
    }

    func test_clearForgetsTheKey() {
        _ = store().reuseOrRecord(for: domain) { "aa" }
        store().clear(for: domain)
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "bb" }, "bb")
    }

    func test_aClockMovedBackwardsDoesNotReuseAFutureEntry() {
        _ = store().reuseOrRecord(for: domain) { "aa" }
        clock = clock.addingTimeInterval(-60)
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "bb" }, "bb")
    }

    func test_aDamagedEntryIsReplaced() {
        defaults.set("garbage", forKey: "flagship.pendingRck.\(domain)")
        XCTAssertEqual(store().reuseOrRecord(for: domain) { "aa" }, "aa")
    }
}
