import XCTest
import CryptoKit
@testable import FlagshipCore

final class ArchiveDownloaderTests: XCTestCase {
    private func dir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("dl-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private let blob: Data = Data((0..<10_000).map { UInt8(($0 * 31 + 7) & 0xff) })
    private var sha: String { SHA256.hash(data: blob).map { String(format: "%02x", $0) }.joined() }

    private actor Log {
        var offsets: [Int64] = []
        var inFlight = 0
        var maxInFlight = 0
        func begin(_ o: Int64) { offsets.append(o); inFlight += 1; maxInFlight = max(maxInFlight, inFlight) }
        func end() { inFlight -= 1 }
    }

    func testDownloadsPartsConcurrentlyAndChecksTheHash() async throws {
        let d = dir()
        let file = d.appendingPathComponent("b.part"), state = d.appendingPathComponent("b.json")
        let log = Log()
        let blob = self.blob
        try await ArchiveDownloader.download(total: Int64(blob.count), sha256: sha, to: file, stateFile: state, chunkBytes: 1_000, parallel: 3, fetch: { o in
            await log.begin(o)
            try await Task.sleep(nanoseconds: 2_000_000)
            await log.end()
            return blob.subdata(in: Int(o)..<min(Int(o) + 1_000, blob.count))
        })
        XCTAssertEqual(try Data(contentsOf: file), blob)
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.path), "progress file is dropped when done")
        let offsets = await log.offsets
        let maxInFlight = await log.maxInFlight
        XCTAssertEqual(Set(offsets).count, 10)
        XCTAssertGreaterThan(maxInFlight, 1, "parts are fetched at once")
    }

    func testResumesOnlyTheMissingParts() async throws {
        let d = dir()
        let file = d.appendingPathComponent("b.part"), state = d.appendingPathComponent("b.json")
        let blob = self.blob
        struct Boom: Error {}
        // First attempt dies after a few parts.
        do {
            try await ArchiveDownloader.download(total: Int64(blob.count), sha256: sha, to: file, stateFile: state, chunkBytes: 1_000, parallel: 1, fetch: { o in
                if o >= 4_000 { throw Boom() }
                return blob.subdata(in: Int(o)..<Int(o) + 1_000)
            })
            XCTFail("expected the first attempt to fail")
        } catch is Boom {}
        let log = Log()
        try await ArchiveDownloader.download(total: Int64(blob.count), sha256: sha, to: file, stateFile: state, chunkBytes: 1_000, parallel: 2, fetch: { o in
            await log.begin(o); await log.end()
            return blob.subdata(in: Int(o)..<min(Int(o) + 1_000, blob.count))
        })
        let offsets = await log.offsets
        XCTAssertEqual(Set(offsets), Set(stride(from: Int64(4_000), to: 10_000, by: 1_000)), "only the missing parts are fetched again")
        XCTAssertEqual(try Data(contentsOf: file), blob)
    }

    func testRefusesADamagedResultAndStartsOverNextTime() async throws {
        let d = dir()
        let file = d.appendingPathComponent("b.part"), state = d.appendingPathComponent("b.json")
        let blob = self.blob
        do {
            try await ArchiveDownloader.download(total: Int64(blob.count), sha256: sha, to: file, stateFile: state, chunkBytes: 1_000, fetch: { o in
                var part = blob.subdata(in: Int(o)..<min(Int(o) + 1_000, blob.count))
                if o == 2_000 { part[0] ^= 1 }
                return part
            })
            XCTFail("expected damaged")
        } catch let e as ArchiveDownloader.DownloadError {
            XCTAssertEqual(e, .damaged)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
    }

    func testRefusesAShortPart() async {
        let d = dir()
        do {
            try await ArchiveDownloader.download(total: 3_000, sha256: nil, to: d.appendingPathComponent("p"), stateFile: d.appendingPathComponent("s"), chunkBytes: 1_000, fetch: { _ in Data(count: 10) })
            XCTFail("expected shortPart")
        } catch let e as ArchiveDownloader.DownloadError {
            if case .shortPart = e {} else { XCTFail("\(e)") }
        } catch { XCTFail("\(error)") }
    }
}
