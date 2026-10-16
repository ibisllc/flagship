import XCTest
import CryptoKit
import Flagship
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

    private let accountKek = Data(repeating: 0xab, count: 32)
    private func fakePasscodeSlot() -> @Sendable (String, Data, String) async throws -> ServerBackupSlot {
        { id, key, _ in
            try ServerBackupFormat.wrapPasscodeSlot(archiveId: id, contentKey: key, kek: Data(repeating: 0x11, count: 32),
                                                   kdf: ServerBackupKdf(m: 64, t: 1, p: 1, saltHex: String(repeating: "00", count: 16)),
                                                   nonce: Data(count: 12))
        }
    }

    // MARK: Backup

    func testBackupAsksForThePasscodeThenSendsBothSlots() async throws {
        let c = client()
        let kek = accountKek
        let vm = ServerBackupViewModel(serverFqdn: "Home.alice.flagship.services", clients: .shared(c),
                                       accountKek: { _ in kek }, passcodeSlot: fakePasscodeSlot(),
                                       suggestedPasscode: "k7qm-2xhd-9twp-4frn-6cyb", pollNs: 1_000, directory: tmp())
        await vm.load()
        XCTAssertEqual(vm.phase, .passcode)
        XCTAssertFalse(vm.canStart, "not until the passcode is saved")
        vm.useOwnPasscode = true
        vm.ownPasscode = "short"
        XCTAssertNotNil(vm.ownPasscodeHint)
        XCTAssertNil(vm.chosenPasscode)
        vm.useOwnPasscode = false
        vm.passcodeSaved = true
        XCTAssertTrue(vm.canStart)
        await vm.start()
        guard case .ready(let bytes) = vm.phase else { return XCTFail("expected ready, got \(vm.phase)") }
        XCTAssertEqual(bytes, 5_000)
        let start = try XCTUnwrap(c.archiveStarts.first)
        XCTAssertTrue(ServerArchive.isArchiveId(start.archiveId))
        XCTAssertEqual(start.slots.map(\.kind), ["passcode", "account"])
        // The account slot opens with this account's key to the content key the box got.
        let key = try XCTUnwrap(HexUtil.decode(start.key))
        XCTAssertEqual(ServerBackupFormat.unwrap(archiveId: start.archiveId, slot: start.slots[1], kek: accountKek), key)
        XCTAssertFalse(String(data: try JSONEncoder().encode(start), encoding: .utf8)!.contains("k7qm"), "the passcode never leaves the phone")

        await vm.download()
        guard case .saved(let urls) = vm.phase else { return XCTFail("expected saved, got \(vm.phase)") }
        XCTAssertEqual(urls.map { $0.pathExtension }, ["flagship-backup", "flagship-data"])
        XCTAssertEqual(try Data(contentsOf: urls[0]), c.archiveBackupFile)
        XCTAssertEqual(try Data(contentsOf: urls[1]), c.archiveBytes)
        XCTAssertTrue(c.archiveForgotten, "the server drops its copy once the files are safe here")
    }

    func testBackupDownloadIsPartsAtOnceAndChecked() async throws {
        let c = client()
        c.archiveBytes = Data((0..<(9 * 1024 * 1024)).map { UInt8($0 & 0xff) })
        let kek = accountKek
        let vm = ServerBackupViewModel(serverFqdn: "home.alice.flagship.services", clients: .shared(c),
                                       accountKek: { _ in kek }, passcodeSlot: fakePasscodeSlot(), pollNs: 1_000, directory: tmp())
        await vm.load()
        vm.passcodeSaved = true
        await vm.start()
        await vm.download()
        guard case .saved(let urls) = vm.phase else { return XCTFail("expected saved, got \(vm.phase)") }
        XCTAssertEqual(try Data(contentsOf: urls[1]), c.archiveBytes)
    }

    func testBackupFailureIsShownNotThrown() async {
        let c = client()
        let kek = accountKek
        let vm = ServerBackupViewModel(serverFqdn: "home.alice.flagship.services", clients: .shared(c),
                                       accountKek: { _ in kek }, passcodeSlot: fakePasscodeSlot(), pollNs: 1_000, directory: tmp())
        await vm.load()
        vm.passcodeSaved = true
        c.shouldFail = true
        await vm.start()
        if case .failed = vm.phase {} else { XCTFail("expected failed, got \(vm.phase)") }
    }

    // MARK: Restore

    private struct Backup {
        let backupURL: URL
        let dataURL: URL
        let archiveId: String
        let contentKey: Data
        let dataBytes: Int64
        let sha256: String
    }

    private func makeBackup(name: String = "home", corruptData: Bool = false) throws -> Backup {
        let dir = tmp()
        let id = "00112233445566778899aabbccddeeff"
        let key = Data(repeating: 0x42, count: 32)
        var data = Data(ServerBackupFormat.dataMagic.utf8)
        data.append(Data(repeating: 9, count: 9 * 1024 * 1024))
        let sha = HexUtil.encode(Data(SHA256.hash(data: data)))
        let body: [String: Any] = [
            "createdAt": 1_792_000_000_000,
            "server": ["name": name, "domain": "\(name).alice.flagship.services", "bootUnlockMode": "approve", "diskEncryption": "luks"],
            "apps": [["serviceId": "alice--wiki", "name": "Wiki"]],
            "left": [],
            "includes": [],
            "excludes": [],
            "data": ["fileName": "\(name)-2026-10-14.flagship-data", "bytes": data.count, "sha256": sha, "frameBytes": 1_048_576],
        ]
        let account = try ServerBackupFormat.wrapAccountSlot(archiveId: id, contentKey: key, kek: accountKek, nonce: Data(count: 12))
        let file = try ServerBackupFormat.sealFile(archiveId: id, contentKey: key, slots: [account],
                                                   bodyJson: try JSONSerialization.data(withJSONObject: body), nonce: Data(repeating: 1, count: 12))
        let text = "{\"magic\":\"flagship-backup\",\"v\":2,\"archiveId\":\"\(id)\",\"slots\":[{\"kind\":\"account\",\"nonceHex\":\"\(account.nonceHex)\",\"wrappedHex\":\"\(account.wrappedHex)\"}],\"bodyNonceHex\":\"\(file.bodyNonceHex)\",\"bodyHex\":\"\(file.bodyHex)\"}\n"
        let backupURL = dir.appendingPathComponent("\(name)-2026-10-14.flagship-backup")
        try Data(text.utf8).write(to: backupURL)
        let dataURL = dir.appendingPathComponent("\(name)-2026-10-14.flagship-data")
        if corruptData { data[data.count - 1] ^= 1 }
        try data.write(to: dataURL)
        return Backup(backupURL: backupURL, dataURL: dataURL, archiveId: id, contentKey: key, dataBytes: Int64(data.count), sha256: sha)
    }

    private func importVM(_ c: MockScreensClient, taken: Set<String> = [], waiting: [String: String] = [:],
                          kek: Data? = nil, onRestored: @escaping (String) -> Void = { _ in }) -> ImportBackupViewModel {
        let k = kek ?? accountKek
        return ImportBackupViewModel(
            username: "alice", takenNames: taken, waitingServers: waiting, clients: .shared(c),
            accountKek: { _ in k },
            openWithPasscode: { _, _ in throw ServerBackupFormat.FormatError.wrongPasscode },
            onRestored: onRestored, pollNs: 1_000
        )
    }

    func testPicksOpensChecksNamesCreatesAndSends() async throws {
        let b = try makeBackup()
        let c = client()
        var restored: [String] = []
        let vm = importVM(c, onRestored: { restored.append($0) })
        await vm.choose([b.backupURL])
        XCTAssertEqual(vm.phase, .pick, "the data file is still missing")
        XCTAssertTrue(vm.filesSummary.contains("home-2026-10-14.flagship-data"), "it names the file it still needs")
        await vm.choose([b.dataURL])
        XCTAssertEqual(vm.phase, .name)
        XCTAssertEqual(vm.name, "home", "the saved name, since the account has no server called that")
        XCTAssertEqual(vm.settingsLine, "Copied from the backup: asks your phone at every start, disk encrypted.")
        XCTAssertTrue(vm.canCreate)
        vm.create()
        XCTAssertEqual(vm.phase, .creating)
        XCTAssertEqual(vm.createTarget, .init(name: "home", bootUnlockMode: "approve", diskEncryption: "luks",
                                              restore: .init(archiveId: b.archiveId, bytes: b.dataBytes, sha256: b.sha256)))

        // The new server comes up waiting for exactly this backup.
        c.restoreWaiting = ServerRestoreWaiting(archiveId: b.archiveId, bytes: b.dataBytes, sha256: b.sha256)
        vm.send(to: "home.alice.flagship.services")
        vm.leaveCreate(fqdn: "home.alice.flagship.services")
        try await waitFor { if case .done = vm.phase { return true }; return false }
        XCTAssertEqual(c.restoreStarts.first, ServerRestoreStartRequest(archiveId: b.archiveId, bytes: b.dataBytes))
        XCTAssertEqual(c.restoreChunks.map(\.offset), [0, 4 * 1024 * 1024, 8 * 1024 * 1024])
        XCTAssertEqual(c.restoreChunks.map { Int64($0.count) }.reduce(0, +), b.dataBytes)
        XCTAssertEqual(c.restoreCommits, [ServerRestoreCommitRequest(key: HexUtil.encode(b.contentKey))])
        XCTAssertEqual(restored, ["home.alice.flagship.services"])
    }

    func testTheCreateScreenStaysUpUntilDoneWhileTheSendRunsUnderIt() async throws {
        let b = try makeBackup()
        let c = client()
        c.restoreWaiting = ServerRestoreWaiting(archiveId: b.archiveId, bytes: b.dataBytes, sha256: b.sha256)
        let vm = importVM(c)
        await vm.choose([b.backupURL, b.dataURL])
        vm.create()
        vm.send(to: "home.alice.flagship.services")
        try await waitFor { !c.restoreCommits.isEmpty }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(vm.phase, .creating, "the delivered page (or a Studio pairing) stays up")
        vm.leaveCreate(fqdn: "home.alice.flagship.services")
        try await waitFor { if case .done = vm.phase { return true }; return false }
    }

    func testANameTheAccountUsesIsNotSuggestedAndIsRefused() async throws {
        let b = try makeBackup()
        let vm = importVM(client(), taken: ["home"])
        await vm.choose([b.backupURL, b.dataURL])
        XCTAssertEqual(vm.phase, .name)
        XCTAssertEqual(vm.name, "")
        XCTAssertEqual(vm.nameProblem, "You already have a server called \"home\": pick another name.")
        vm.name = "home"
        XCTAssertFalse(vm.canCreate)
        vm.name = "home2"
        XCTAssertNil(vm.nameProblem)
        XCTAssertTrue(vm.canCreate)
        vm.name = "-bad"
        XCTAssertNotNil(vm.nameProblem)
    }

    func testAnotherAccountsBackupAsksForThePasscode() async throws {
        let b = try makeBackup()
        let vm = importVM(client(), kek: Data(count: 32))
        await vm.choose([b.backupURL, b.dataURL])
        XCTAssertEqual(vm.phase, .passcode)
        vm.passcode = "wrong one"
        await vm.unlock()
        XCTAssertEqual(vm.phase, .passcode)
        XCTAssertEqual(vm.fileError, "That passcode doesn't open this backup.")
    }

    func testAChangedDataFileIsRefusedBeforeAnythingIsMade() async throws {
        let b = try makeBackup(corruptData: true)
        let vm = importVM(client())
        await vm.choose([b.backupURL, b.dataURL])
        XCTAssertEqual(vm.phase, .pick)
        XCTAssertEqual(vm.fileError, "The data file doesn't match the backup file: it was changed or is damaged.")
        XCTAssertNil(vm.dataFileName, "it asks for the data file again")
    }

    func testAServerWaitingForThisBackupIsOffered() async throws {
        let b = try makeBackup()
        let vm = importVM(client(), waiting: [b.archiveId: "clone.alice.flagship.services"])
        await vm.choose([b.backupURL, b.dataURL])
        XCTAssertEqual(vm.phase, .chooseTarget(fqdn: "clone.alice.flagship.services"))
    }

    func testAnUploadResumesWhereTheServerGotTo() async throws {
        let b = try makeBackup()
        let c = client()
        c.restoreWaiting = ServerRestoreWaiting(archiveId: b.archiveId, bytes: b.dataBytes, sha256: b.sha256)
        c.restoreAlreadyReceived = 4 * 1024 * 1024
        let vm = importVM(c, waiting: [b.archiveId: "clone.alice.flagship.services"])
        await vm.choose([b.backupURL, b.dataURL])
        vm.send(to: "clone.alice.flagship.services")
        try await waitFor { if case .done = vm.phase { return true }; return false }
        XCTAssertEqual(c.restoreChunks.map(\.offset), [4 * 1024 * 1024, 8 * 1024 * 1024])
    }

    func testAFailedRestoreSaysTheServerKeepsWaiting() async throws {
        let b = try makeBackup()
        let c = client()
        c.restoreWaiting = ServerRestoreWaiting(archiveId: b.archiveId, bytes: b.dataBytes, sha256: b.sha256)
        c.restoreFailure = "the backup's data file can't be opened: wrong key, or it was changed or cut short"
        let vm = importVM(c, waiting: [b.archiveId: "clone.alice.flagship.services"])
        await vm.choose([b.backupURL, b.dataURL])
        vm.send(to: "clone.alice.flagship.services")
        try await waitFor { if case .failed = vm.phase { return true }; return false }
        guard case .failed(let message, let keepsWaiting) = vm.phase else { return XCTFail() }
        XCTAssertTrue(message.contains("wrong key"))
        XCTAssertTrue(keepsWaiting)
    }

    func testPickingSomethingElseExplainsWhy() async throws {
        let url = tmp().appendingPathComponent("x.txt")
        try Data("hello\n".utf8).write(to: url)
        let vm = importVM(client())
        await vm.choose([url])
        XCTAssertEqual(vm.fileError, "x.txt isn't a Flagship backup file or data file.")
        XCTAssertEqual(vm.phase, .pick)
    }

    func testBoxEventLabelsDropGenericWritesAndNameTheRest() {
        XCTAssertNil(BoxEventLabels.title(BoxActivityEntry(ts: 1, action: "post /api/screens/x")))
        XCTAssertEqual(BoxEventLabels.title(BoxActivityEntry(ts: 1, action: "server.backup.created", kind: "server.backup.created")), "Backup ready")
        XCTAssertEqual(BoxEventLabels.title(BoxActivityEntry(ts: 1, action: "x", kind: "server.something.new")), "Server something new")
    }

    func testCorruptStateEntryReadsAsAWarning() {
        let e = BoxActivityEntry(ts: 1, action: "server.state.corrupt", kind: "server.state.corrupt", detail: "service-access.json couldn't be read and was set aside.", ok: false)
        XCTAssertEqual(BoxEventLabels.title(e), "This server found a damaged settings file and locked it down")
        XCTAssertEqual(BoxEventLabels.symbol(e), "exclamationmark.triangle.fill")
        XCTAssertEqual(AuditLogViewModel.label(for: "server-migration-taken-over"), "Moved a server to a new machine / VM")
        XCTAssertEqual(AuditLogViewModel.label(for: "brand-new.kind"), "Brand new kind")
        XCTAssertEqual(AuditLogViewModel.label(for: ""), "Account event")
    }

    private func waitFor(_ cond: @MainActor () -> Bool, timeout: TimeInterval = 10) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end { return XCTFail("timed out") }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
    }
}

/// Pins the passcode slot's Argon2id to packages/protocol/test-vectors/server-backup.
final class ServerBackupPasscodeTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-backup/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func kdf(_ o: Any?) throws -> ServerBackupKdf {
        let k = try XCTUnwrap(o as? [String: Any])
        return ServerBackupKdf(m: (k["m"] as! NSNumber).intValue, t: (k["t"] as! NSNumber).intValue,
                               p: (k["p"] as! NSNumber).intValue, saltHex: k["saltHex"] as! String)
    }

    func testArgon2idMatchesTheVectors() throws {
        let v = try vectors()
        let slot = try XCTUnwrap((v["slots"] as? [String: Any])?["passcode"] as? [String: Any])
        let small = try kdf(slot["kdf"])
        XCTAssertEqual(HexUtil.encode(try ServerBackupPasscode.kek(passcode: v["passcode"] as! String, kdf: small)), v["passcodeKekHex"] as? String)
        for n in v["normalize"] as! [[String: Any]] {
            XCTAssertEqual(HexUtil.encode(try ServerBackupPasscode.kek(passcode: n["input"] as! String, kdf: small)), n["kekHex"] as? String)
        }
        let d = v["defaultParamsKdf"] as! [String: Any]
        XCTAssertEqual(HexUtil.encode(try ServerBackupPasscode.kek(passcode: d["passcode"] as! String, kdf: try kdf(d["kdf"]))), d["kekHex"] as? String)
    }

    func testOpensTheVectorFileWithThePasscode() async throws {
        let v = try vectors()
        let file = try ServerBackupFormat.parse(Data((v["file"] as! String).utf8))
        let opened = try await ServerBackupPasscode.open(file, passcode: v["passcode"] as! String)
        XCTAssertEqual(HexUtil.encode(opened.contentKey), v["contentKeyHex"] as? String)
        do {
            _ = try await ServerBackupPasscode.open(file, passcode: v["wrongPasscode"] as! String)
            XCTFail("a wrong passcode opened it")
        } catch {
            XCTAssertEqual(error as? ServerBackupFormat.FormatError, .wrongPasscode)
        }
    }
}

@MainActor
final class BackupDownloadApprovalViewModelTests: XCTestCase {
    func testApprovesWithASignatureTheServerCanCheck() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let key = Curve25519.Signing.PrivateKey()
        let vm = BackupDownloadApprovalViewModel(
            serverFqdn: "Home.harry.flagship.services",
            archiveId: "00112233445566778899aabbccddeeff",
            requestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
            clients: .shared(c),
            signer: { _ in key },
            now: { 1_700_000_000_000 }
        )
        XCTAssertEqual(vm.code, ArchiveDownloadApproval.code(requestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0"))
        await vm.approve()
        XCTAssertEqual(vm.phase, .approved)
        let sent = try XCTUnwrap(c.archiveApprovals.first)
        XCTAssertEqual(sent.approval, ArchiveDownloadApproval(serverDomain: "home.harry.flagship.services",
                                                              archiveId: "00112233445566778899aabbccddeeff",
                                                              requestId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
                                                              issuedAt: 1_700_000_000_000))
        XCTAssertTrue(key.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(sent.signature)), for: sent.approval.canonicalBytes()))
    }

    func testAFailedSignIsShownNotThrown() async {
        struct Cancelled: Error {}
        let vm = BackupDownloadApprovalViewModel(serverFqdn: "home.harry.flagship.services", archiveId: String(repeating: "0", count: 32),
                                                 requestId: String(repeating: "1", count: 32), clients: .shared(MockScreensClient()),
                                                 signer: { _ in throw Cancelled() })
        await vm.approve()
        if case .failed = vm.phase {} else { XCTFail("expected failed, got \(vm.phase)") }
    }
}
