import XCTest
@testable import FlagshipBuilderCore

final class VMInventoryStoreTests: XCTestCase {
    private var root: URL!
    private var store: VMInventoryStore!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vm-store-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = VMInventoryStore(layout: VMBundleLayout(root: root))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func record(name: String) -> VMRecord {
        let cfg = VMConfig(name: name,
                           serverDomain: name,
                           username: "harry",
                           serverName: String(name.split(separator: ".").first ?? "srv"),
                           cpuCount: 4,
                           memoryBytes: 6 * VMResourcePlan.gib,
                           mainDiskSizeBytes: VMResourcePlan.defaultMainDiskSizeBytes,
                           networkMode: .nat,
                           serialConsoleEnabled: false,
                           bootUnlockMode: "auto",
                           diskEncrypted: true)
        return VMRecord(config: cfg,
                        state: .created,
                        createdAt: Date(timeIntervalSince1970: 1_750_000_000),
                        tier: .hostedVM)
    }

    // MARK: - Layout

    func testBundleLayoutPaths() {
        let layout = VMBundleLayout(root: root)
        let dir = layout.bundleDir("home.harry.flagship.services")
        XCTAssertEqual(dir, root.appendingPathComponent("home.harry.flagship.services", isDirectory: true))
        XCTAssertEqual(layout.configURL("a.b").lastPathComponent, "config.json")
        XCTAssertEqual(layout.diskImageURL("a.b").lastPathComponent, "disk.img")
        XCTAssertEqual(layout.installerISOURL("a.b").lastPathComponent, "installer.iso")
        XCTAssertEqual(layout.efiVariableStoreURL("a.b").lastPathComponent, "efi-vars.bin")
        XCTAssertEqual(layout.consoleLogURL("a.b").lastPathComponent, "console.log")
    }

    // MARK: - CRUD

    func testCreateLoadRoundTrip() throws {
        let rec = record(name: "home.harry.flagship.services")
        try store.create(rec)
        let back = try store.load(name: "home.harry.flagship.services")
        XCTAssertEqual(back, rec)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: store.layout.configURL(rec.config.name).path))
    }

    func testLegacyRecordWithoutActivityTimestampsStillLoads() throws {
        let rec = record(name: "legacy.harry.flagship.services")
        try store.create(rec)
        let url = store.layout.configURL(rec.config.name)
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        json.removeValue(forKey: "stateChangedAt")
        json.removeValue(forKey: "lastConnectedAt")
        try JSONSerialization.data(withJSONObject: json).write(to: url)

        let loaded = try store.load(name: rec.config.name)
        XCTAssertNil(loaded.stateChangedAt)
        XCTAssertNil(loaded.lastConnectedAt)
    }

    func testCreateRefusesToClobber() throws {
        let rec = record(name: "home.harry.flagship.services")
        try store.create(rec)
        XCTAssertThrowsError(try store.create(rec)) { err in
            XCTAssertEqual(err as? VMStoreError, .alreadyExists("home.harry.flagship.services"))
        }
    }

    func testSavePersistsAStateChange() throws {
        var rec = record(name: "home.harry.flagship.services")
        try store.create(rec)
        rec.state = .awaitingPhoneUnlock
        try store.save(rec)
        XCTAssertEqual(try store.load(name: rec.config.name).state, .awaitingPhoneUnlock)
    }

    func testSaveWithoutCreateFails() {
        XCTAssertThrowsError(try store.save(record(name: "ghost.x.flagship.services"))) { err in
            XCTAssertEqual(err as? VMStoreError, .notFound("ghost.x.flagship.services"))
        }
    }

    func testDeleteRemovesTheWholeBundle() throws {
        let rec = record(name: "home.harry.flagship.services")
        try store.create(rec)
        // Simulate a disk image sitting in the bundle.
        FileManager.default.createFile(
            atPath: store.layout.diskImageURL(rec.config.name).path, contents: Data([0]))
        try store.delete(name: rec.config.name)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: store.layout.bundleDir(rec.config.name).path))
        XCTAssertThrowsError(try store.load(name: rec.config.name))
    }

    func testDeleteMissingFails() {
        XCTAssertThrowsError(try store.delete(name: "nope.flagship.services")) { err in
            XCTAssertEqual(err as? VMStoreError, .notFound("nope.flagship.services"))
        }
    }

    // MARK: - Listing (multi-server per spec)

    func testListReturnsAllRecordsSortedByName() throws {
        try store.create(record(name: "b.bob.flagship.services"))
        try store.create(record(name: "a.alice.flagship.services"))
        let names = store.list().map { $0.config.name }
        // Different owners on one machine is a supported posture.
        XCTAssertEqual(names, ["a.alice.flagship.services", "b.bob.flagship.services"])
    }

    func testListSkipsCorruptEntriesWithoutFailingTheRest() throws {
        try store.create(record(name: "good.harry.flagship.services"))
        let badDir = root.appendingPathComponent("bad.harry.flagship.services", isDirectory: true)
        try FileManager.default.createDirectory(at: badDir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: badDir.appendingPathComponent("config.json"))
        let names = store.list().map { $0.config.name }
        XCTAssertEqual(names, ["good.harry.flagship.services"])
    }

    func testListOnEmptyOrMissingRootIsEmpty() {
        XCTAssertEqual(store.list(), [])
        let missing = VMInventoryStore(layout: VMBundleLayout(
            root: root.appendingPathComponent("does-not-exist")))
        XCTAssertEqual(missing.list(), [])
    }

    // MARK: - Name validation

    func testHostileNamesAreRejected() {
        for bad in ["", ".", "..", "../escape", "a/b", ".hidden", "UPPER.case", "spa ce"] {
            var rec = record(name: "ok.flagship.services")
            rec = VMRecord(config: VMConfig(name: bad,
                                            serverDomain: bad,
                                            username: "u",
                                            serverName: "s",
                                            cpuCount: 2,
                                            memoryBytes: 1,
                                            mainDiskSizeBytes: 1,
                                            networkMode: .nat,
                                            serialConsoleEnabled: false,
                                            bootUnlockMode: "auto",
                                            diskEncrypted: true),
                           state: rec.state, createdAt: rec.createdAt, tier: rec.tier)
            XCTAssertThrowsError(try store.create(rec), "'\(bad)' must be rejected")
        }
    }
}
