import XCTest
@testable import FlagshipCore

final class DeadManRemindersAndStoresTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    // MARK: reminder schedule math (pure)

    func testReminderFireDatesAtT6hT1hT15m() {
        // Lease expires at 100h; now = 0.
        let expiry: Int64 = 100 * 3600_000
        let pending = DeadManReminders.pendingFireDates(leaseExpiryMs: expiry, nowMs: 0)
        XCTAssertEqual(pending.map { $0.leadMs }, [6 * 3600_000, 1 * 3600_000, 15 * 60_000])
        XCTAssertEqual(pending.map { $0.fireAtMs }, [
            expiry - 6 * 3600_000,
            expiry - 1 * 3600_000,
            expiry - 15 * 60_000,
        ])
    }

    func testReminderDropsPastLeadTimes() {
        // Lease expires in 30 minutes — only the T-15m reminder is still future.
        let now: Int64 = 1_000_000
        let expiry = now + 30 * 60_000
        let pending = DeadManReminders.pendingFireDates(leaseExpiryMs: expiry, nowMs: now)
        XCTAssertEqual(pending.map { $0.leadMs }, [15 * 60_000])
    }

    func testReminderEmptyWhenLeaseImminent() {
        let now: Int64 = 1_000_000
        let expiry = now + 5 * 60_000   // under the shortest (15m) lead
        XCTAssertTrue(DeadManReminders.pendingFireDates(leaseExpiryMs: expiry, nowMs: now).isEmpty)
    }

    func testReminderIdentifiersPerServer() {
        let id = DeadManReminders.identifier(serverDomain: "A.x", leadMs: 3600_000)
        XCTAssertTrue(id.hasPrefix("flagship.deadman.reminder.a.x."))
        XCTAssertTrue(id.hasSuffix("3600000"))
    }

    // MARK: DiskEncryptionStore

    func testDiskEncryptionDefaultsLuksWhenUnknown() {
        let s = DiskEncryptionStore(defaults: UserDefaults(suiteName: "de-\(UUID())")!)
        XCTAssertTrue(s.isLuks(for: "unknown.box"))
    }

    func testDiskEncryptionRecordsNone() {
        let s = DiskEncryptionStore(defaults: UserDefaults(suiteName: "de-\(UUID())")!)
        s.setLuks(false, for: server)
        XCTAssertFalse(s.isLuks(for: server))
        s.setLuks(true, for: server)
        XCTAssertTrue(s.isLuks(for: server))
    }

    // MARK: DeadManStore

    func testDeadManStoreDefaults() {
        let s = DeadManStore(defaults: UserDefaults(suiteName: "dm-\(UUID())")!)
        XCTAssertFalse(s.isEnabled(for: server))
        XCTAssertEqual(s.windowMs(for: server), 24 * 3600_000)
        XCTAssertEqual(s.graceMs(for: server), 6 * 3600_000)
        XCTAssertEqual(s.lockoutMode(for: server), "off")
        XCTAssertNil(s.leaseExpiry(for: server))
    }

    func testDeadManStoreRoundTrip() {
        let s = DeadManStore(defaults: UserDefaults(suiteName: "dm-\(UUID())")!)
        s.save(serverDomain: server, enabled: true, windowMs: 60_000, graceMs: 1000, lockoutMode: "restart")
        s.setLeaseExpiry(7777, for: server)
        XCTAssertTrue(s.isEnabled(for: server))
        XCTAssertEqual(s.windowMs(for: server), 60_000)
        XCTAssertEqual(s.lockoutMode(for: server), "restart")
        XCTAssertEqual(s.leaseExpiry(for: server), 7777)
    }

    func testWindowPresetNearest() {
        XCTAssertEqual(DeadManStore.WindowPreset.nearest(ms: 24 * 3600_000), .h24)
        XCTAssertEqual(DeadManStore.WindowPreset.nearest(ms: 15 * 60_000), .min15)
        XCTAssertEqual(DeadManStore.WindowPreset.nearest(ms: 50 * 60_000), .h1)
    }
}
