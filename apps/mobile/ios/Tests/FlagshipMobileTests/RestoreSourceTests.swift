import XCTest
@testable import FlagshipUI
@testable import FlagshipCore

/// Home's one "Restore from backup": the phone-copies source lists the saved
/// copies by server and date (newest first), and says why when there are none.
@MainActor
final class RestoreSourceTests: XCTestCase {

    private func store() -> PhoneBackupStore {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("restore-source-\(UUID().uuidString)")
        let suite = "restore-source-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return PhoneBackupStore(root: root, defaults: defaults)
    }

    private func save(_ s: PhoneBackupStore, server: String, id: String, at ms: Int64) throws {
        s.remember(.init(fqdn: server, policy: "phone", reserveBytes: 1 << 30))
        let dir = s.root.appendingPathComponent(server.lowercased()).appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: dir.appendingPathComponent("b.flagship"))
        let copy = PhoneBackupStore.Copy(archiveId: id, createdAt: ms, bytes: 1, fileName: "b.flagship")
        try JSONEncoder().encode(copy).write(to: dir.appendingPathComponent("copy.json"))
    }

    func test_noCopiesMeansNoEntries() {
        XCTAssertTrue(PhoneBackupsScreen.entries(in: store()).isEmpty)
        XCTAssertTrue(PhoneBackupsScreen.emptyLine.contains("On my phone"))
    }

    func test_entriesAreByServerAndNewestFirst() throws {
        let s = store()
        try save(s, server: "home.harry.flagship.services", id: "a1", at: 1_000)
        try save(s, server: "office.harry.flagship.services", id: "b1", at: 3_000)
        try save(s, server: "home.harry.flagship.services", id: "a2", at: 2_000)
        let e = PhoneBackupsScreen.entries(in: s)
        XCTAssertEqual(e.map(\.copy.archiveId), ["b1", "a2", "a1"])
        XCTAssertEqual(e.map { PhoneBackupsScreen.serverName($0.server) }, ["office", "home", "home"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: e[0].url.path), "each entry points at the file to import")
    }

    func test_sourceLinesAreOneShortSentenceEach() {
        for line in [RestoreSourceScreen.fileLine, RestoreSourceScreen.peersLine, RestoreSourceScreen.phoneLine] {
            XCTAssertLessThan(line.count, 80)
            XCTAssertEqual(line.filter { $0 == "." }.count, line.hasPrefix("A .") ? 2 : 1, line)
        }
    }

    func test_nothingIsPresentedInATestHost() {
        XCTAssertFalse(PresentationSweeper.hasPresentation)
        PresentationSweeper.dismissAll()
    }
}
