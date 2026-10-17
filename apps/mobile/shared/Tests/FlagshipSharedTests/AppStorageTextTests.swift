import XCTest
@testable import FlagshipAPI

/// Per-app disk limits (docs/app-runtimes.md 5.3): the lines on the app page,
/// the notes on the server's Backups section, how the box's JSON decodes and
/// the app-storage-full alert. Twin of the webapp's webappAppStorage test.
final class AppStorageTextTests: XCTestCase {
    private let gb: Int64 = 1_073_741_824

    func test_showsFilesAndDatabaseUseAgainstTheirLimits() {
        let lines = AppStorageText.appLines(AppDiskUsage(
            files: StoreUsage(usedBytes: 2 * gb, limitBytes: 5 * gb),
            postgres: StoreUsage(usedBytes: 300 * 1_048_576, limitBytes: gb)))
        XCTAssertEqual(lines.map(\.label), ["Files", "Database"])
        XCTAssertTrue(lines.allSatisfy { !$0.full && $0.note.isEmpty })
        XCTAssertEqual(lines[0].text, "2.0 GB of 5.0 GB")
        XCTAssertTrue(lines[1].text.hasPrefix("300 MB"))
    }

    func test_saysWhyNewDataIsRefusedWhenFullOrClosed() {
        let lines = AppStorageText.appLines(AppDiskUsage(
            files: StoreUsage(usedBytes: 5 * gb, limitBytes: 5 * gb, full: true),
            postgres: StoreUsage(usedBytes: 2 * gb, limitBytes: gb, writesBlocked: true, stopped: true)))
        XCTAssertEqual(lines[0].note, AppStorageText.fullSentence)
        XCTAssertTrue(lines[1].full)
        XCTAssertEqual(lines[1].note, AppStorageText.stoppedSentence)
    }

    func test_nothingForABoxThatSendsNoStorage() {
        XCTAssertEqual(AppStorageText.appLines(nil), [])
        XCTAssertEqual(AppStorageText.serverNotes(nil), [])
    }

    func test_listsFullAppsByNameAndTheDiskBrake() {
        let notes = AppStorageText.serverNotes(ServerStorage(brake: "on", capped: true, apps: [
            AppStorageEntry(serviceId: "a--plants", files: StoreUsage(usedBytes: 1, limitBytes: 5)),
            AppStorageEntry(serviceId: "a--wiki", files: StoreUsage(usedBytes: 5, limitBytes: 5, full: true)),
        ])) { $0.components(separatedBy: "--").last!.capitalized }
        XCTAssertEqual(notes, [
            "The server's disk is nearly full: apps can't save more until there's room.",
            "Wiki is full: new data is refused until you free space or raise the limit.",
        ])
        XCTAssertEqual(AppStorageText.serverNotes(ServerStorage(brake: "hard")),
                       ["The server's disk is full: apps' folders are read-only until there's room."])
    }

    func test_decodesTheBoxJsonAndTheAlert() throws {
        let d = JSONDecoder()
        let s = try d.decode(AppDiskUsage.self, from: Data(#"{"files":{"usedBytes":10,"limitBytes":20,"full":true},"postgres":{"usedBytes":1}}"#.utf8))
        XCTAssertEqual(s.files?.full, true)
        XCTAssertNil(s.postgres?.limitBytes)
        let alert = try d.decode(PhoneAlert.self, from: Data(#"{"kind":"app-storage-full","serviceId":"a--wiki","store":"files"}"#.utf8))
        XCTAssertEqual(alert, .appStorageFull(serviceId: "a--wiki", store: "files"))
        let bare = try d.decode(PhoneAlert.self, from: Data(#"{"kind":"app-storage-full"}"#.utf8))
        XCTAssertEqual(bare, .other(kind: "app-storage-full"))
    }
}
