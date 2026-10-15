import XCTest
@testable import FlagshipCore

/// Pins `ServerArchive` to `packages/protocol/test-vectors/server-archive/vectors.json`.
final class ServerArchiveVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-archive/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func testKeysMatchTheSharedVectors() throws {
        let v = try vectors()
        for c in try XCTUnwrap(v["cases"] as? [[String: Any]]) {
            let umk = try XCTUnwrap(HexUtil.decode(try XCTUnwrap(c["umkSeedHex"] as? String)))
            let key = ServerArchive.deriveKey(umkSeed: umk, archiveId: try XCTUnwrap(c["archiveIdHex"] as? String))
            XCTAssertEqual(key.map(HexUtil.encode), c["keyHex"] as? String)
        }
    }

    func testRefusesBadArchiveIds() throws {
        let v = try vectors()
        let umk = Data(repeating: 9, count: 32)
        for bad in try XCTUnwrap(v["invalidArchiveIds"] as? [String]) {
            XCTAssertNil(ServerArchive.deriveKey(umkSeed: umk, archiveId: bad), bad)
        }
        XCTAssertNil(ServerArchive.deriveKey(umkSeed: Data(count: 5), archiveId: String(repeating: "a", count: 32)))
    }

    func testReadsAHeaderAndRefusesOtherFiles() throws {
        let head = Data("{\"magic\":\"flagship-archive\",\"v\":1,\"archiveId\":\"00112233445566778899aabbccddeeff\",\"createdAt\":5,\"sourceServer\":\"home.alice.flagship.services\",\"apps\":[{\"serviceId\":\"alice--wiki\",\"name\":\"Wiki\"}]}\nBINARY".utf8)
        let h = try ServerArchive.parseHeader(head)
        XCTAssertEqual(h.archiveId, "00112233445566778899aabbccddeeff")
        XCTAssertEqual(h.appNames, ["Wiki"])
        XCTAssertThrowsError(try ServerArchive.parseHeader(Data("hello\n".utf8))) { XCTAssertEqual($0 as? ServerArchive.HeaderError, .notABackup) }
        XCTAssertThrowsError(try ServerArchive.parseHeader(Data("{\"magic\":\"flagship-archive\",\"v\":2}\n".utf8))) { XCTAssertEqual($0 as? ServerArchive.HeaderError, .newerVersion) }
        XCTAssertThrowsError(try ServerArchive.parseHeader(Data("{\"magic\":\"flagship-archive\",\"v\":1,\"archiveId\":\"zz\"}\n".utf8))) { XCTAssertEqual($0 as? ServerArchive.HeaderError, .damaged) }
    }

    func testNamesAndSizes() {
        XCTAssertEqual(ServerArchive.fileName(sourceServer: "Home.alice.flagship.services", createdAt: Date(timeIntervalSince1970: 1_792_000_000)), "Home-2026-10-14.flagship-backup")
        XCTAssertEqual(ServerArchive.formatBytes(900 * 1024), "900 KB")
        XCTAssertEqual(ServerArchive.formatBytes(5 * 1024 * 1024), "5.0 MB")
        XCTAssertEqual(ServerArchive.formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB")
    }
}
