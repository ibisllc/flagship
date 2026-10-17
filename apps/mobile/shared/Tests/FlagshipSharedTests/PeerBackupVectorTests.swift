import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Pins the device's side of peer backup to
/// packages/protocol/test-vectors/peer-backup/vectors.json: the SWK and PBK
/// from the account key, and opening a sealed record with them.
final class PeerBackupVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/peer-backup/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func test_swkAndPbkFollowTheVectors() throws {
        let v = try vectors()
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let id = v["serverId"] as! String
        XCTAssertEqual(HexUtil.encode(try XCTUnwrap(ServerKeys.deriveSwk(umkSeed: umk, serverId: id))), v["swkHex"] as? String)
        XCTAssertEqual(HexUtil.encode(try PeerBackupKeys.pbk(umkSeed: umk, serverId: id)), v["pbkHex"] as? String)
        XCTAssertEqual(HexUtil.encode(try PeerBackupKeys.pbk(umkSeed: umk, serverId: " \(id.uppercased()) ")), v["pbkHex"] as? String)
    }

    func test_refusesWhatIsNotAServerAddress() throws {
        let umk = Data(repeating: 1, count: 32)
        XCTAssertThrowsError(try PeerBackupKeys.pbk(umkSeed: umk, serverId: "not a server")) {
            XCTAssertEqual($0 as? PeerBackupKeys.Failure, .notAServer)
        }
    }

    func test_opensTheSealedRecordAndSummarisesIt() throws {
        let v = try vectors()
        let pbk = try XCTUnwrap(HexUtil.decode(v["pbkHex"] as! String))
        let id = v["serverId"] as! String
        let sealed = try XCTUnwrap(v["root"] as? [String: Any])["sealed"] as! [String: String]
        let s = try PeerBackupKeys.openSealedRoot(
            PeerSealedRoot(nonceHex: sealed["nonceHex"]!, ciphertextHex: sealed["ciphertextHex"]!), pbk: pbk, serverId: id)
        XCTAssertEqual(s.serverId, id)
        XCTAssertEqual(s.generation, 3)
        XCTAssertEqual(s.revision, 2)
        XCTAssertEqual(s.archive.archiveId, "00112233445566778899aabbccddeeff")
        XCTAssertEqual(s.archive.bytes, 1000)
        XCTAssertEqual(s.needed, 1)
        XCTAssertGreaterThan(s.holders, 0)
        XCTAssertGreaterThan(s.keepUntil, 0)
        // Another server's key, or another server's name, opens nothing.
        XCTAssertThrowsError(try PeerBackupKeys.openSealedRoot(
            PeerSealedRoot(nonceHex: sealed["nonceHex"]!, ciphertextHex: sealed["ciphertextHex"]!),
            pbk: Data(repeating: 9, count: 32), serverId: id)) { XCTAssertEqual($0 as? PeerBackupKeys.Failure, .wouldNotOpen) }
        XCTAssertThrowsError(try PeerBackupKeys.openSealedRoot(
            PeerSealedRoot(nonceHex: sealed["nonceHex"]!, ciphertextHex: sealed["ciphertextHex"]!),
            pbk: pbk, serverId: "other.harry.flagship.services")) { XCTAssertEqual($0 as? PeerBackupKeys.Failure, .wouldNotOpen) }
    }

    func test_words() {
        XCTAssertEqual(PeerBackupText.stateTitle("protected"), "Protected")
        XCTAssertEqual(PeerBackupText.holderLine(PeerHolderRow(label: "Server 1", state: "ok", lastProofAt: 5, bricks: 1)) { "T\($0)" },
                       "Answering · last proof T5 · 1 piece")
        XCTAssertEqual(PeerBackupText.holderLine(PeerHolderRow(label: "Server 2", state: "offline", bricks: 3)) { "T\($0)" },
                       "Offline · no proof yet · 3 pieces")
        XCTAssertEqual(PeerBackupText.restoreByLine(keepUntil: 1_000 + 3 * 86_400_000, now: 1_000) { "D\($0)" }, "Restore by D259201000 (3 days left).")
        XCTAssertEqual(PeerBackupText.restoreByLine(keepUntil: 5, now: 10) { "\($0)" }, "The pieces of this backup are no longer kept.")
        XCTAssertEqual(PeerBackupText.restoreByLine(keepUntil: 0, now: 10) { "\($0)" }, "")
        XCTAssertEqual(PeerBackupText.hostingLines(nil), [])
    }
}
