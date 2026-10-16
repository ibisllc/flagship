import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

final class ScheduledBackupHelperTests: XCTestCase {
    private func dir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("sb-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    // MARK: local time <-> the box's UTC schedule

    private let chicago = TimeZone(identifier: "America/Chicago")!
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    /// Wed 2026-10-14 12:00 UTC (Chicago on CDT, UTC-5).
    private let october = Date(timeIntervalSince1970: 1_792_000_000)
    /// Wed 2026-01-14 12:00 UTC (Chicago on CST, UTC-6).
    private let january = Date(timeIntervalSince1970: 1_768_392_000)

    func testDailyLocalTimeBecomesTheUtcMinute() {
        let r = BackupScheduleClock.toUtc(localMinute: 3 * 60, localWeekday: 3, timeZone: chicago, reference: october)
        XCTAssertEqual(r.minuteOfDayUtc, 8 * 60, "3:00 AM CDT is 08:00 UTC")
        let w = BackupScheduleClock.toUtc(localMinute: 3 * 60, localWeekday: 3, timeZone: chicago, reference: january)
        XCTAssertEqual(w.minuteOfDayUtc, 9 * 60, "in winter the offset is CST")
    }

    func testWeeklyAcrossMidnightMovesTheWeekday() {
        // Sunday 9:30 PM in Chicago is Monday 02:30 UTC.
        let late = BackupScheduleClock.toUtc(localMinute: 21 * 60 + 30, localWeekday: 0, timeZone: chicago, reference: october)
        XCTAssertEqual(late.minuteOfDayUtc, 2 * 60 + 30)
        XCTAssertEqual(late.weekdayUtc, 1)
        // Monday 1:00 AM in Tokyo is Sunday 16:00 UTC.
        let early = BackupScheduleClock.toUtc(localMinute: 60, localWeekday: 1, timeZone: tokyo, reference: october)
        XCTAssertEqual(early.minuteOfDayUtc, 16 * 60)
        XCTAssertEqual(early.weekdayUtc, 0)
    }

    func testUtcComesBackAsTheSameLocalTime() {
        for tz in [chicago, tokyo, TimeZone(identifier: "UTC")!, TimeZone(identifier: "Asia/Kolkata")!] {
            for weekday in 0..<7 {
                for minute in [0, 59, 3 * 60, 12 * 60 + 15, 23 * 60 + 59] {
                    let u = BackupScheduleClock.toUtc(localMinute: minute, localWeekday: weekday, timeZone: tz, reference: october)
                    let l = BackupScheduleClock.toLocal(minuteOfDayUtc: u.minuteOfDayUtc, weekdayUtc: u.weekdayUtc, timeZone: tz, reference: october)
                    XCTAssertEqual(l.minute, minute, "\(tz.identifier) \(weekday) \(minute)")
                    XCTAssertEqual(l.weekday, weekday, "\(tz.identifier) \(weekday) \(minute)")
                }
            }
        }
    }

    func testScheduleSummary() {
        let en = Locale(identifier: "en_US")
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(BackupScheduleClock.summary(.boxDefault, timeZone: utc, locale: en, reference: october),
                       "Daily at 3:00 AM · keeps 7 daily and 4 weekly")
        let weekly = BackupSchedule(frequency: "weekly", minuteOfDayUtc: 2 * 60 + 30, weekdayUtc: 1, keepDaily: 0, keepWeekly: 8)
        XCTAssertEqual(BackupScheduleClock.summary(weekly, timeZone: chicago, locale: en, reference: october),
                       "Weekly on Sunday at 9:30 PM · keeps 0 daily and 8 weekly")
        XCTAssertEqual(BackupScheduleClock.summary(BackupSchedule(frequency: "off", minuteOfDayUtc: 0, weekdayUtc: 0, keepDaily: 1, keepWeekly: 0)),
                       "Scheduled backups are off.")
    }

    // MARK: copies kept on the phone

    func testThePhoneKeepsTheNewestAndThePreviousOnlyWhileBothFit() {
        let copies = [
            PhoneBackupRetention.Copy(archiveId: "a", createdAt: 1, bytes: 10),
            PhoneBackupRetention.Copy(archiveId: "c", createdAt: 3, bytes: 12),
            PhoneBackupRetention.Copy(archiveId: "b", createdAt: 2, bytes: 11),
        ]
        XCTAssertEqual(PhoneBackupRetention.keep(copies, reserveBytes: nil), ["c", "b"], "never more than two")
        XCTAssertEqual(PhoneBackupRetention.keep(copies, reserveBytes: 23), ["c", "b"])
        XCTAssertEqual(PhoneBackupRetention.keep(copies, reserveBytes: 22), ["c"], "the previous only while both fit")
        XCTAssertEqual(PhoneBackupRetention.keep(copies, reserveBytes: 1), ["c"], "the newest always")
        XCTAssertEqual(PhoneBackupRetention.keep([], reserveBytes: 5), [])
    }

    func testTheDefaultReserveIsAQuarterOfFreeSpaceInWholeGb() {
        let gb: Int64 = 1 << 30
        XCTAssertEqual(PhoneBackupRetention.defaultReserveBytes(freeBytes: 100 * gb), 25 * gb)
        XCTAssertEqual(PhoneBackupRetention.defaultReserveBytes(freeBytes: 10 * gb), 2 * gb, "rounded down")
        XCTAssertEqual(PhoneBackupRetention.defaultReserveBytes(freeBytes: gb), 2 * gb, "at least 2 GB")
        XCTAssertFalse(PhoneBackupRetention.fits(bytes: 5 * gb, freeBytes: 5 * gb))
        XCTAssertTrue(PhoneBackupRetention.fits(bytes: 4 * gb, freeBytes: 5 * gb))
    }

    // MARK: box sentences

    func testBoxSentencesAreShownAsTheBoxWroteThem() {
        let e = ScreensClientError.http(status: 409, message: #"{"error":"an admin device of your account hasn't approved backups for this server yet","code":"no-keys"}"#)
        XCTAssertEqual(BoxSentence.of(e), "An admin device of your account hasn't approved backups for this server yet.")
        XCTAssertEqual(BoxSentence.code(e), "no-keys")
        XCTAssertEqual(BoxSentence.display("Done already."), "Done already.")
    }

    // MARK: views from the box

    func testSavedBackupsViewParsesTheBoxShape() throws {
        let json = """
        {"schedule":{"frequency":"weekly","minuteOfDayUtc":180,"weekdayUtc":2,"keepDaily":7,"keepWeekly":4},
         "scheduleActive":false,"nextRunAt":null,"lastRun":{"at":5,"ok":false,"trigger":"schedule","reason":"needs about 4.0 GB, has 1.0 GB"},
         "running":{"archiveId":"00112233445566778899aabbccddeeff","trigger":"now","startedAt":9,"progress":{"done":1,"total":3,"app":"Wiki"}},
         "keysLeft":0,"keysWanted":400,"waitingReason":"an admin device …","usedBytes":123,
         "backups":[{"archiveId":"ffeeddccbbaa99887766554433221100","createdAt":7,"trigger":"schedule","bytes":100,"sha256":"aa",
                     "backupBytes":23,"backupFileName":"home-2026-10-16-0300.flagship-backup","dataFileName":"home-2026-10-16-0300.flagship-data",
                     "apps":[{"serviceId":"a--b","name":"B"}],"left":[{"serviceId":"a--c","name":"C","reason":"no source"}],
                     "bundleFileName":"home-2026-10-16-0300.flagship","bundleBytes":139,"bundleSha256":"bb"}]}
        """
        let v = try JSONDecoder().decode(SavedBackupsView.self, from: Data(json.utf8))
        XCTAssertFalse(v.scheduleActive)
        XCTAssertNil(v.nextRunAt)
        XCTAssertEqual(v.lastRun?.reason, "needs about 4.0 GB, has 1.0 GB")
        XCTAssertEqual(v.running?.progress.app, "Wiki")
        XCTAssertEqual(v.keysWanted, 400)
        XCTAssertEqual(v.backups.first?.fileName, "home-2026-10-16-0300.flagship")
        XCTAssertEqual(v.backups.first?.fileBytes, 139)
        XCTAssertEqual(v.backups.first?.left.first?.reason, "no source")

        let policy = """
        {"policy":{"policy":"peer","phoneReserveBytes":0,"issuedAt":3},
         "cap":{"limitBytes":100,"usedBytes":120,"measuredAt":4,"overLimit":true,"diskBytes":300,"reservedForPeersBytes":200,
                "apps":[{"serviceId":"a--b","bytes":120}],"overReason":"This server holds …"},
         "peer":{"state":"placing","healthyBricks":3,"totalBricks":5,"holders":["x","y"]}}
        """
        let p = try JSONDecoder().decode(BackupPolicyView.self, from: Data(policy.utf8))
        XCTAssertTrue(p.cap.overLimit)
        XCTAssertEqual(p.peer?.holders, 2, "a list of holders counts")
        XCTAssertEqual(p.peer?.healthyBricks, 3)
        let unset = try JSONDecoder().decode(BackupPolicyView.self, from: Data(#"{"policy":{"policy":"unset","phoneReserveBytes":0,"issuedAt":null},"cap":{"limitBytes":null,"usedBytes":null,"measuredAt":null,"overLimit":false,"diskBytes":0,"reservedForPeersBytes":null,"apps":[]},"peer":null}"#.utf8))
        XCTAssertEqual(unset.policy.policy, "unset")
        XCTAssertNil(unset.peer)
    }

    // MARK: the one file, streamed

    /// A multi-GB `.flagship` file (sparse: the data part is mostly a hole,
    /// so it costs no disk) is opened from its header and metadata alone and
    /// its data part checked in slices, never held in memory.
    func testAMultiGigabyteBundleIsCheckedWithoutLoadingIt() async throws {
        let d = dir()
        defer { try? FileManager.default.removeItem(at: d) }
        let url = d.appendingPathComponent("big.flagship")
        let dataBytes: Int64 = (5 << 29) // 2.5 GiB, past any 32-bit offset
        let meta = Data(#"{"magic":"flagship-backup","v":2,"archiveId":"00112233445566778899aabbccddeeff","slots":[{"kind":"account","nonceHex":"000000000000000000000000","wrappedHex":"\#(String(repeating: "00", count: 48))"}],"bodyNonceHex":"000000000000000000000000","bodyHex":"\#(String(repeating: "00", count: 17))"}"#.utf8)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let fh = try FileHandle(forWritingTo: url)
        try fh.write(contentsOf: try ServerBackupBundle.header(metaLength: meta.count) + meta + Data(ServerBackupFormat.dataMagic.utf8))
        try fh.truncate(atOffset: UInt64(16 + meta.count) + UInt64(dataBytes))
        try fh.close()

        let opened = try ServerBackupBundle.read(url)
        XCTAssertEqual(opened.file.archiveId, "00112233445566778899aabbccddeeff")
        XCTAssertEqual(opened.layout.dataLength, dataBytes)

        // The SHA-256 of the data part: the magic line, then zeros.
        var h = SHA256()
        h.update(data: Data(ServerBackupFormat.dataMagic.utf8))
        let zeros = Data(count: 8 << 20)
        var left = dataBytes - Int64(ServerBackupFormat.dataMagic.utf8.count)
        while left > 0 {
            let n = Int(min(Int64(zeros.count), left))
            h.update(data: n == zeros.count ? zeros : zeros.prefix(n))
            left -= Int64(n)
        }
        let sha = HexUtil.encode(Data(h.finalize()))
        let info = ServerBackupFormat.DataInfo(fileName: "big.flagship-data", bytes: dataBytes, sha256: sha, frameBytes: 1 << 20)
        try await ServerBackupBundle.checkData(url, layout: opened.layout, against: info)

        // One byte changed deep in the data part: refused with the sentence.
        let w = try FileHandle(forWritingTo: url)
        try w.seek(toOffset: UInt64(opened.layout.dataOffset) + UInt64(dataBytes) - 10)
        try w.write(contentsOf: Data([1]))
        try w.close()
        do {
            try await ServerBackupBundle.checkData(url, layout: opened.layout, against: info)
            XCTFail("a changed file must be refused")
        } catch {
            XCTAssertEqual(error as? ServerBackupBundle.BundleError, .dataChanged)
        }
        // The restore upload reads its slices from past the header.
        let r = try FileHandle(forReadingFrom: url)
        defer { try? r.close() }
        XCTAssertEqual(try ServerBackupBundle.readData(r, layout: opened.layout, offset: 0, count: 8), Data(ServerBackupFormat.dataMagic.utf8.prefix(8)))
    }

    func testATruncatedBundleIsRefusedWithTheSentence() throws {
        let d = dir()
        defer { try? FileManager.default.removeItem(at: d) }
        let url = d.appendingPathComponent("cut.flagship")
        try (try ServerBackupBundle.header(metaLength: 40) + Data(repeating: 0x7b, count: 20)).write(to: url)
        XCTAssertThrowsError(try ServerBackupBundle.read(url)) { e in
            XCTAssertEqual((e as? LocalizedError)?.errorDescription, "This backup is cut short: it ends before its data.")
        }
        try Data("not a backup at all, just text".utf8).write(to: url)
        XCTAssertThrowsError(try ServerBackupBundle.read(url)) { e in
            XCTAssertEqual((e as? LocalizedError)?.errorDescription, "This file isn't a Flagship backup.")
        }
    }

    /// A download of the one file over many parts resumes after a cut-off
    /// and ends with the whole file's SHA-256 checked.
    func testTheOneFileDownloadResumesAndChecksTheWholeFile() async throws {
        let d = dir()
        defer { try? FileManager.default.removeItem(at: d) }
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        mock.archiveBytes = Data(ServerBackupFormat.dataMagic.utf8) + Data((0..<(18 << 20)).map { UInt8(($0 * 7) & 0xff) })
        let saved = mock.makeSavedBackup(createdAt: 1_792_000_000_000)
        mock.savedBackupsList = [saved]
        let url = try await ArchiveDownloader.downloadBundle(
            client: mock, route: .saved(archiveId: saved.archiveId), bytes: saved.fileBytes, sha256: saved.bundleSha256,
            fileName: saved.fileName, into: d)
        XCTAssertEqual(url.lastPathComponent, saved.fileName)
        XCTAssertEqual(try Data(contentsOf: url), mock.archiveBundle)
        let opened = try ServerBackupBundle.read(url)
        XCTAssertEqual(opened.layout.dataLength, Int64(mock.archiveBytes.count))
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.appendingPathComponent("\(saved.fileName).part").path))
    }
}
