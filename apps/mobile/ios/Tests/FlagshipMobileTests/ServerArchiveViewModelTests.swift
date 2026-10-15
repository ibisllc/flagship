import XCTest
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

@MainActor
final class ServerArchiveViewModelTests: XCTestCase {
    private func tmp() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("archive-vm-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func client() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    func testBackupMakesDownloadsAndForgets() async throws {
        let c = client()
        let dir = tmp()
        let vm = ServerBackupViewModel(
            serverFqdn: "Home.alice.flagship.services",
            clients: .shared(c),
            keyProvider: { _ in Data(repeating: 0xab, count: 32) },
            pollNs: 1_000,
            directory: dir
        )
        await vm.start()
        guard case .ready(let bytes) = vm.phase else { return XCTFail("expected ready, got \(vm.phase)") }
        XCTAssertEqual(bytes, 5_000)
        // The box got the id and the derived key, hex, never anything else.
        XCTAssertEqual(c.archiveStarts.count, 1)
        XCTAssertTrue(ServerArchive.isArchiveId(c.archiveStarts[0].archiveId))
        XCTAssertEqual(c.archiveStarts[0].key, String(repeating: "ab", count: 32))

        await vm.download()
        guard case .saved(let url) = vm.phase else { return XCTFail("expected saved, got \(vm.phase)") }
        XCTAssertEqual(try Data(contentsOf: url), c.archiveBytes)
        XCTAssertTrue(c.archiveForgotten, "the server drops its copy once the file is safe here")
        XCTAssertTrue(url.lastPathComponent.hasSuffix(".flagship-backup"))
    }

    func testBackupFailureIsShownNotThrown() async {
        let c = client()
        c.shouldFail = true
        let vm = ServerBackupViewModel(serverFqdn: "home.alice.flagship.services", clients: .shared(c),
                                       keyProvider: { _ in Data(count: 32) }, pollNs: 1_000, directory: tmp())
        await vm.start()
        if case .failed = vm.phase {} else { XCTFail("expected failed, got \(vm.phase)") }
    }

    private func backupFile(id: String = "00112233445566778899aabbccddeeff", extra: Int = 6_000) throws -> URL {
        let head = "{\"magic\":\"flagship-archive\",\"v\":1,\"archiveId\":\"\(id)\",\"createdAt\":5,\"sourceServer\":\"home.alice.flagship.services\",\"apps\":[{\"serviceId\":\"alice--wiki\",\"name\":\"Wiki\"}]}\n"
        var d = Data(head.utf8)
        d.append(Data(repeating: 1, count: extra))
        let url = tmp().appendingPathComponent("b.flagship-backup")
        try d.write(to: url)
        return url
    }

    func testImportSendsInOrderThenCommitsWithTheDerivedKey() async throws {
        let c = client()
        let vm = ImportBackupViewModel(
            targets: [.init(fqdn: "clone.alice.flagship.services", label: "clone")],
            clients: .shared(c),
            keyProvider: { id in
                XCTAssertEqual(id, "00112233445566778899aabbccddeeff")
                return Data(repeating: 0xcd, count: 32)
            },
            pollNs: 1_000
        )
        vm.choose(try backupFile())
        guard case .chosen(let header, let size) = vm.phase else { return XCTFail("expected chosen, got \(vm.phase)") }
        XCTAssertEqual(header.appNames, ["Wiki"])
        XCTAssertGreaterThan(size, 6_000)
        XCTAssertTrue(vm.canImport)

        await vm.startImport()
        guard case .done(let apps) = vm.phase else { return XCTFail("expected done, got \(vm.phase)") }
        XCTAssertEqual(apps.map(ImportBackupViewModel.describe), ["Wiki: restored"])
        XCTAssertEqual(c.restoreStarts, [ServerRestoreStartRequest(archiveId: header.archiveId, bytes: size)])
        XCTAssertEqual(c.restoreChunks.map(\.offset), [0])
        XCTAssertEqual(c.restoreChunks.map { Int64($0.count) }.reduce(0, +), size)
        XCTAssertEqual(c.restoreCommits, [ServerRestoreCommitRequest(key: String(repeating: "cd", count: 32))])
    }

    func testImportShowsTheServersReasonWhenItFails() async throws {
        let c = client()
        c.restoreFailure = "the archive can't be opened: wrong key, or it was changed or cut short"
        let vm = ImportBackupViewModel(targets: [.init(fqdn: "clone.alice.flagship.services", label: "clone")],
                                       clients: .shared(c), keyProvider: { _ in Data(count: 32) }, pollNs: 1_000)
        vm.choose(try backupFile())
        await vm.startImport()
        guard case .failed(let message) = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
        XCTAssertTrue(message.contains("wrong key"))
    }

    func testPickingSomethingElseExplainsWhy() throws {
        let url = tmp().appendingPathComponent("x.txt")
        try Data("hello\n".utf8).write(to: url)
        let vm = ImportBackupViewModel(targets: [], clients: .shared(client()), keyProvider: { _ in Data() })
        vm.choose(url)
        XCTAssertEqual(vm.fileError, "That isn't a Flagship backup.")
        XCTAssertEqual(vm.phase, .picking)
        XCTAssertFalse(vm.canImport)
    }

    func testBoxEventLabelsDropGenericWritesAndNameTheRest() {
        XCTAssertNil(BoxEventLabels.title(BoxActivityEntry(ts: 1, action: "post /api/screens/x")))
        XCTAssertEqual(BoxEventLabels.title(BoxActivityEntry(ts: 1, action: "server.backup.created", kind: "server.backup.created")), "Backup ready")
        XCTAssertEqual(BoxEventLabels.title(BoxActivityEntry(ts: 1, action: "x", kind: "server.something.new")), "Server something new")
    }
}
