import XCTest
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore
@testable import FlagshipUI

/// The server page's Backups section against the mock box.
@MainActor
final class ServerBackupsViewModelTests: XCTestCase {
    private let fqdn = "home.alice.flagship.services"
    private let umk = Data(repeating: 0x2a, count: 32)
    private let admin = Curve25519.Signing.PrivateKey()
    private let now: Int64 = 1_792_000_000_000

    private func dir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("sbvm-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func client() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let t = now
        c.savedNow = { t }
        return c
    }

    private final class Counter: @unchecked Sendable { var mints = 0; var counts: [Int] = [] }

    private func vm(_ c: MockScreensClient, admin isAdmin: Bool = true, silent: Bool = true, counter: Counter = Counter()) -> ServerBackupsViewModel {
        let umk = self.umk, key = admin, t = now
        let store = PhoneBackupStore(root: dir(), defaults: UserDefaults(suiteName: "sbvm-\(UUID().uuidString)")!)
        return ServerBackupsViewModel(
            serverFqdn: fqdn, isAdminDevice: isAdmin, clients: .shared(c),
            mintKeys: { n, _ in
                counter.mints += 1
                counter.counts.append(n)
                return (ArchiveKeys.mint(umkSeed: umk, count: n), key)
            },
            canMintSilently: { silent },
            policySigner: { _ in key },
            now: { t }, pollNs: 1_000_000, directory: dir(), phoneStore: store)
    }

    // MARK: the "should deposit" rule

    func testAnAdminDeviceDepositsOnceWhenTheBoxAsksAndSignsTheBatch() async throws {
        let c = client()
        let counter = Counter()
        let m = vm(c, counter: counter)
        await m.start()
        XCTAssertEqual(counter.counts, [400], "the box's keysWanted, capped at a deposit's worth")
        let dep = try XCTUnwrap(c.savedKeyDeposits.first)
        XCTAssertEqual(dep.deposit.serverDomain, fqdn)
        XCTAssertEqual(dep.deposit.digest, try ArchiveKeys.digest(dep.keys))
        XCTAssertTrue(admin.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(dep.signature)), for: try dep.deposit.canonicalBytes()))
        for k in dep.keys.prefix(3) {
            XCTAssertEqual(ServerArchive.deriveKey(umkSeed: umk, archiveId: k.archiveId).map(HexUtil.encode), k.kekHex)
        }
        XCTAssertEqual(m.saved?.keysWanted, 0)
        XCTAssertNotNil(m.nextLine.flatMap { $0.hasPrefix("Next backup: ") ? $0 : nil })
        await m.reload()
        await m.start()
        XCTAssertEqual(counter.mints, 1, "never again while the pool is full enough")
    }

    func testANonAdminDeviceNeverDepositsAndShowsTheBoxReason() async throws {
        let c = client()
        let counter = Counter()
        let m = vm(c, admin: false, counter: counter)
        await m.start()
        XCTAssertEqual(counter.mints, 0)
        XCTAssertTrue(c.savedKeyDeposits.isEmpty)
        XCTAssertFalse(m.needsApproval)
        XCTAssertEqual(m.nextLine, BoxSentence.display(MockScreensClient.noKeysSentence))
        XCTAssertFalse(m.canRun)
        await m.backUpNow()
        XCTAssertEqual(c.savedRuns, 0)
    }

    func testAnAdminDeviceThatMustAskForFaceIdShowsTheButtonInstead() async {
        let c = client()
        let counter = Counter()
        let m = vm(c, silent: false, counter: counter)
        await m.start()
        XCTAssertEqual(counter.mints, 0, "no prompt on page open")
        XCTAssertTrue(m.needsApproval)
        await m.depositKeys()
        XCTAssertEqual(counter.mints, 1)
        XCTAssertFalse(m.needsApproval)
    }

    // MARK: Back up now

    func testBackUpNowWithNoKeysDepositsThenRetriesOnce() async throws {
        let c = client()
        c.savedRunReads = 0
        let counter = Counter()
        let m = vm(c, silent: false, counter: counter)
        await m.start()
        await m.backUpNow()
        XCTAssertEqual(counter.mints, 1, "the 409 no-keys is answered with a deposit")
        XCTAssertEqual(c.savedRuns, 1, "and the run is tried again once")
        try await waitFor { m.saved?.running == nil && m.saved?.backups.count == 1 }
        XCTAssertTrue(m.statusLine.hasPrefix("Last backup: "))
        XCTAssertEqual(m.saved?.backups.first?.trigger, "now")
    }

    func testRunningShowsProgressAndAFailureShowsTheBoxSentence() async throws {
        let c = client()
        c.seedKeyPool(40)
        c.savedRunReads = 1
        c.savedRunFailure = "needs about 4.0 GB, has 1.0 GB"
        let m = vm(c)
        await m.start()
        XCTAssertEqual(m.statusLine, "No backups yet.")
        await m.backUpNow()
        XCTAssertTrue(m.statusLine.hasPrefix("Backing up… "), m.statusLine)
        try await waitFor { m.saved?.running == nil }
        XCTAssertEqual(m.failedLine, "The last backup failed: needs about 4.0 GB, has 1.0 GB.")
    }

    // MARK: Schedule

    func testWeeklyInLocalTimeIsSentInUtc() async throws {
        let c = client()
        c.seedKeyPool(40)
        let m = vm(c)
        await m.start()
        let chicago = TimeZone(identifier: "America/Chicago")!
        var d = m.scheduleDraft(timeZone: chicago)
        XCTAssertEqual(d.minute, 22 * 60, "03:00 UTC is 10 PM in Chicago (CDT)")
        d.frequency = "weekly"
        d.weekday = 0
        d.keepWeekly = 8
        let ok = await m.saveSchedule(d, timeZone: chicago)
        XCTAssertTrue(ok)
        XCTAssertEqual(c.savedSchedulePuts.last, BackupSchedule(frequency: "weekly", minuteOfDayUtc: 180, weekdayUtc: 1, keepDaily: 7, keepWeekly: 8),
                       "Sunday 10 PM in Chicago is Monday 03:00 UTC")
        XCTAssertEqual(m.scheduleLine(timeZone: chicago).hasPrefix("Weekly on Sunday at "), true)
    }

    func testARefusedScheduleShowsTheBoxSentence() async {
        let c = client()
        let m = vm(c)
        await m.start()
        var d = m.scheduleDraft()
        d.keepDaily = 0
        d.keepWeekly = 0
        let ok = await m.saveSchedule(d)
        XCTAssertFalse(ok)
        XCTAssertEqual(m.scheduleError, "Keep at least one backup.")
    }

    // MARK: Download and delete

    func testDownloadIsTheOneFileAndTheServerKeepsItsCopy() async throws {
        let c = client()
        c.archiveBytes = Data(ServerBackupFormat.dataMagic.utf8) + Data(repeating: 3, count: 9 << 20)
        let b = c.makeSavedBackup(createdAt: now - 1_000)
        c.savedBackupsList = [b]
        c.seedKeyPool(40)
        let m = vm(c)
        await m.start()
        await m.download(b)
        guard case .done(let url) = m.downloads[b.archiveId] else { return XCTFail("\(String(describing: m.downloads[b.archiveId]))") }
        XCTAssertEqual(url.pathExtension, "flagship")
        XCTAssertEqual(try Data(contentsOf: url), c.archiveBundle)
        XCTAssertEqual(c.savedBackupsList.count, 1, "a saved backup is not removed after a download")
        XCTAssertFalse(c.archiveForgotten)
    }

    func testDeleteIsAdminOnlyAndRemovesTheRow() async {
        let c = client()
        let b = c.makeSavedBackup(createdAt: now - 1_000)
        c.savedBackupsList = [b]
        c.seedKeyPool(40)
        let viewer = vm(c, admin: false)
        await viewer.start()
        await viewer.delete(b)
        XCTAssertTrue(c.savedDeletes.isEmpty)
        let m = vm(c)
        await m.start()
        await m.delete(b)
        XCTAssertEqual(c.savedDeletes, [b.archiveId])
        XCTAssertEqual(m.saved?.backups.count, 0)
    }

    // MARK: Policy

    func testPolicyLinesAndAChangeIsSigned() async throws {
        let c = client()
        c.policyCurrent = BackupPolicyCurrent(policy: "phone", phoneReserveBytes: 32 << 30, issuedAt: now - 10)
        let m = vm(c)
        await m.start()
        XCTAssertEqual(m.policyLine, "Backup policy: On my phone · up to 32.0 GB")
        XCTAssertEqual(m.usageLine, "Apps use 3.2 GB of 32.0 GB")
        XCTAssertTrue(m.phoneCopyShown)
        let ok = await m.changePolicy(to: .peer, reserveBytes: 32 << 30)
        XCTAssertTrue(ok)
        let sent = try XCTUnwrap(c.policyOrders.last)
        XCTAssertEqual(sent.order, BackupPolicyOrder(serverDomain: fqdn, policy: "peer", phoneReserveBytes: 0, issuedAt: now))
        XCTAssertTrue(admin.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(sent.signatureHex)), for: try sent.order.canonicalBytes()))
        XCTAssertEqual(m.usageLine, "Apps use 3.2 GB of 120.0 GB (a third of this server's disk)")
        XCTAssertFalse(m.phoneCopyShown)
    }

    func testAPolicyOverTheLimitIsRefusedWithTheBoxSentence() async {
        let c = client()
        c.policyCurrent = BackupPolicyCurrent(policy: "peer", phoneReserveBytes: 0, issuedAt: now - 10)
        c.policyUsedBytes = 150 << 30
        c.policyPeer = PeerBackupEngineStatus(state: "at-risk", healthyBricks: 2, totalBricks: 5, hostingBytes: 1 << 30, holders: 3, reason: "two holders are offline")
        let m = vm(c)
        await m.start()
        XCTAssertTrue(m.overLimitLine?.hasPrefix("This server holds 150 GB of app data, over its backup limit of 120 GB") == true)
        XCTAssertEqual(m.peerLines.first, "Peer backups: at risk. Two holders are offline.")
        XCTAssertTrue(m.peerLines.contains("2 of 5 pieces safe"))
        let ok = await m.changePolicy(to: .phoneOnly, reserveBytes: 8 << 30)
        XCTAssertFalse(ok)
        XCTAssertEqual(m.policyError, "This server holds 150 GB of app data, more than the 8.0 GB your device would keep. Reserve at least 150 GB on that device, or remove apps or data first.")
    }

    func testNoBackupsHidesTheScheduleButKeepsBackUpNow() async {
        let c = client()
        c.seedKeyPool(40)
        c.policyCurrent = BackupPolicyCurrent(policy: "none", phoneReserveBytes: 0, issuedAt: now - 10)
        let m = vm(c)
        await m.start()
        XCTAssertFalse(m.scheduleShown)
        XCTAssertNil(m.nextLine)
        XCTAssertTrue(m.canRun)
        XCTAssertEqual(m.policyLine, "Backup policy: No backup")
    }

    // MARK: The phone's copy

    func testTheBackgroundPassKeepsTheNewestCopyWithinTheReserve() async throws {
        let c = client()
        c.archiveBytes = Data(ServerBackupFormat.dataMagic.utf8) + Data(repeating: 5, count: 1 << 20)
        c.policyCurrent = BackupPolicyCurrent(policy: "phone", phoneReserveBytes: 3 << 20, issuedAt: now - 10)
        let first = c.makeSavedBackup(createdAt: now - 2_000)
        c.savedBackupsList = [first]
        let store = PhoneBackupStore(root: dir(), defaults: UserDefaults(suiteName: "sbvm-\(UUID().uuidString)")!)
        store.remember(.init(fqdn: fqdn, policy: "unset", reserveBytes: 0))
        let big: () -> Int64 = { 100 << 30 }
        var out = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: big)
        XCTAssertEqual(out[fqdn], .downloaded(archiveId: first.archiveId))
        out = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: big)
        XCTAssertEqual(out[fqdn], .upToDate)
        let second = c.makeSavedBackup(createdAt: now - 1_000)
        c.savedBackupsList.insert(second, at: 0)
        _ = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: big)
        XCTAssertEqual(store.copies(fqdn).map(\.archiveId), [second.archiveId, first.archiveId], "both fit the 3 MB reserve")
        let third = c.makeSavedBackup(createdAt: now - 500)
        c.savedBackupsList.insert(third, at: 0)
        _ = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: big)
        XCTAssertEqual(store.copies(fqdn).map(\.archiveId), [third.archiveId, second.archiveId], "never more than two")
        XCTAssertEqual(try Data(contentsOf: store.url(of: store.copies(fqdn)[0], server: fqdn)), c.archiveBundle)

        // Not enough room: skipped with the sentence.
        let fourth = c.makeSavedBackup(createdAt: now - 100)
        c.savedBackupsList.insert(fourth, at: 0)
        out = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: { 1 << 20 })
        guard case .skipped(let why) = out[fqdn] else { return XCTFail("\(String(describing: out[fqdn]))") }
        XCTAssertTrue(why.hasPrefix("This phone needs about "), why)
        XCTAssertEqual(store.skipSentence(fqdn), why)

        // Turned off, or a policy that isn't phone-side: nothing is fetched.
        store.setKeepsCopy(false, for: fqdn)
        out = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: big)
        XCTAssertEqual(out[fqdn], .off)
        XCTAssertTrue(store.copies(fqdn).isEmpty, "turning it off removes the copies")
        store.setKeepsCopy(true, for: fqdn)
        c.policyCurrent = BackupPolicyCurrent(policy: "peer", phoneReserveBytes: 0, issuedAt: now)
        out = await PhoneBackupFetcher.runOnce(store: store, clients: .shared(c), freeBytes: big)
        XCTAssertEqual(out[fqdn], .off)
    }

    private func waitFor(_ cond: @MainActor () -> Bool, timeout: TimeInterval = 10) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end { return XCTFail("timed out") }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
    }
}
