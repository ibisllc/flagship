import XCTest
@testable import FlagshipCore
@testable import FlagshipUI

/// The Calls list leaves the app's defaults (docs/voici-locked-caller-names.md §8 D6): a file per account, out of
/// backups, protected until the first unlock; what an older build kept in defaults moves over once.
@MainActor
final class VoiciCallHistoryStoreTests: XCTestCase {
    private var dir: URL!
    private var legacy: UserDefaults!

    override func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("call-history-\(UUID())", isDirectory: true)
        legacy = UserDefaults(suiteName: "call-history-legacy-\(UUID())")!
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func record(_ id: String) -> VoiciCallRecord {
        VoiciCallRecord(callId: id, direction: .outgoing, outcome: .answered, peer: .page(username: "bob", pageId: String(repeating: "b", count: 32)), video: false, at: 1)
    }

    func test_recordsLiveInAFileOutOfBackups() throws {
        let store = FileCallHistoryStore(dir: dir, legacy: legacy)
        let h = VoiciCallHistory(store: store)
        h.configure(username: "Me")
        h.record(record("a"))
        let file = dir.appendingPathComponent("me.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(try dir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertNil(legacy.data(forKey: "flagship.voici.callHistory.me"))
        let again = VoiciCallHistory(store: store)
        again.configure(username: "me")
        XCTAssertEqual(again.records.map(\.callId), ["a"])
    }

    func test_anOlderBuildsDefaultsMoveOverOnce() throws {
        legacy.set(try JSONEncoder().encode([record("old")]), forKey: "flagship.voici.callHistory.me")
        let store = FileCallHistoryStore(dir: dir, legacy: legacy)
        let h = VoiciCallHistory(store: store)
        h.configure(username: "me")
        XCTAssertEqual(h.records.map(\.callId), ["old"])
        XCTAssertNil(legacy.data(forKey: "flagship.voici.callHistory.me"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("me.json").path))
    }

    func test_forgetRemovesTheFileAndAnyLegacyCopy() throws {
        let store = FileCallHistoryStore(dir: dir, legacy: legacy)
        store.write("me", try JSONEncoder().encode([record("a")]))
        store.write("you", try JSONEncoder().encode([record("b")]))
        legacy.set(Data([1]), forKey: "flagship.voici.callHistory.me")
        VoiciCallHistory.forget(username: "me", allProfiles: false, store: store)
        XCTAssertNil(store.read("me"))
        XCTAssertNotNil(store.read("you"))
        VoiciCallHistory.forget(username: nil, allProfiles: true, store: store)
        XCTAssertNil(store.read("you"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }
}
