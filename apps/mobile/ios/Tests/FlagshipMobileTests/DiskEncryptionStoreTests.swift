import XCTest
@testable import FlagshipCore

final class DiskEncryptionStoreTests: XCTestCase {
    private let server = "home.alice.flagship.services"

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
}
