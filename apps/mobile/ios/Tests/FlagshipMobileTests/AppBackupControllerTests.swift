import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// "Back up now" on an app's page: the box packs the app, then hands the
/// archive to this phone, which keeps it as a file to save.
final class AppBackupControllerTests: XCTestCase {
    @MainActor
    func testBackUpDownloadsTheArchiveTheBoxPacked() async throws {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let ctrl = AppBackupController(serviceId: "harry--notes", client: client, directory: dir,
                                       now: { Date(timeIntervalSince1970: 1_760_000_000) })
        ctrl.password = "pw"
        await ctrl.backUp()
        guard case .ready(let file, let bytes, let encrypted) = ctrl.phase else {
            return XCTFail("expected a ready backup, got \(ctrl.phase)")
        }
        XCTAssertTrue(encrypted)
        XCTAssertEqual(file.lastPathComponent, "notes-backup-2025-10-09-0853.tar.gz.enc")
        XCTAssertEqual(try Data(contentsOf: file), Data("mock app backup".utf8))
        XCTAssertEqual(bytes, 15)
        XCTAssertEqual(client.appBackupFetches.count, 1)
        XCTAssertTrue(client.appBackupFetches[0].hasPrefix("/api/backups/"))
        XCTAssertEqual(ctrl.password, "", "the password isn't kept once used")
    }

}
