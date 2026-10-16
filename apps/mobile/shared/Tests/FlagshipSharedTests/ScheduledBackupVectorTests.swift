import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins the scheduled-backup ports to the protocol's vectors:
/// packages/protocol/test-vectors/server-archive-keys/vectors.json,
/// packages/protocol/test-vectors/backup-policy/vectors.json and
/// packages/protocol/test-vectors/server-backup-bundle/vectors.json.
final class ScheduledBackupVectorTests: XCTestCase {
    private func vectors(_ name: String) throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/\(name)/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(name)/vectors.json not found above \(#filePath)")
    }

    private func key(_ v: [String: Any]) throws -> (Curve25519.Signing.PrivateKey, Data) {
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk)))
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        return (key, umk)
    }

    private func int64(_ v: Any?) -> Int64 { (v as? NSNumber)?.int64Value ?? -999 }

    // MARK: flagship/server-archive-keys/v1

    func testArchiveKeysDigestCanonicalAndSignatureMatchTheVectors() throws {
        let v = try vectors("server-archive-keys")
        let (key, umk) = try key(v)
        for c in try XCTUnwrap(v["cases"] as? [[String: Any]]) {
            let keys = try XCTUnwrap(c["keys"] as? [[String: String]]).map { ArchiveKey(archiveId: $0["archiveId"]!, kekHex: $0["kekHex"]!) }
            for k in keys {
                XCTAssertEqual(ServerArchive.deriveKey(umkSeed: umk, archiveId: k.archiveId).map(HexUtil.encode), k.kekHex,
                               "kekHex is the account's key for that backup")
            }
            XCTAssertEqual(try ArchiveKeys.digest(keys), c["digest"] as? String)
            let d = try ArchiveKeys.deposit(serverDomain: c["serverDomain"] as! String, keys: keys, issuedAt: int64(c["issuedAt"]))
            XCTAssertEqual(String(data: try d.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: try d.canonicalBytes()))
            XCTAssertTrue(key.publicKey.isValidSignature(try key.signature(for: try d.canonicalBytes()), for: try d.canonicalBytes()))
        }
    }

    func testArchiveKeysRefuseEveryInvalidDeposit() throws {
        let v = try vectors("server-archive-keys")
        for c in try XCTUnwrap(v["invalid"] as? [[String: Any]]) {
            let d = ArchiveKeysDeposit(serverDomain: c["serverDomain"] as! String, count: Int(int64(c["count"])),
                                       digest: c["digest"] as! String, issuedAt: int64(c["issuedAt"]))
            XCTAssertThrowsError(try d.canonicalBytes(), "\(c)")
        }
        XCTAssertThrowsError(try ArchiveKeys.digest([ArchiveKey(archiveId: "zz", kekHex: String(repeating: "0", count: 64))]))
    }

    func testMintedKeysAreFreshAndTheAccountsOwn() throws {
        let umk = Data(repeating: 0x2a, count: 32)
        let keys = ArchiveKeys.mint(umkSeed: umk, count: 5)
        XCTAssertEqual(keys.count, 5)
        XCTAssertEqual(Set(keys.map(\.archiveId)).count, 5)
        for k in keys {
            XCTAssertTrue(ServerArchive.isArchiveId(k.archiveId))
            XCTAssertEqual(ServerArchive.deriveKey(umkSeed: umk, archiveId: k.archiveId).map(HexUtil.encode), k.kekHex)
        }
        XCTAssertEqual(try ArchiveKeys.deposit(serverDomain: "Home.Harry.flagship.services", keys: keys, issuedAt: 1).serverDomain,
                       "home.harry.flagship.services")
    }

    func testDepositsOnlyFromAnAdminDeviceAndOnlyWhenAsked() {
        XCTAssertTrue(ArchiveKeys.shouldDeposit(isAdminDevice: true, keysWanted: 400))
        XCTAssertFalse(ArchiveKeys.shouldDeposit(isAdminDevice: true, keysWanted: 0), "never while the pool is full enough")
        XCTAssertFalse(ArchiveKeys.shouldDeposit(isAdminDevice: false, keysWanted: 400), "never from a non-admin device")
        XCTAssertEqual(ArchiveKeys.count(wanted: 770), 400)
        XCTAssertEqual(ArchiveKeys.count(wanted: 12), 12)
    }

    // MARK: flagship/backup-policy/v1

    func testBackupPolicyCanonicalAndSignatureMatchTheVectors() throws {
        let v = try vectors("backup-policy")
        let (key, _) = try key(v)
        for c in try XCTUnwrap(v["cases"] as? [[String: Any]]) {
            let o = BackupPolicyOrder(serverDomain: c["serverDomain"] as! String, policy: c["policy"] as! String,
                                      phoneReserveBytes: int64(c["phoneReserveBytes"]), issuedAt: int64(c["issuedAt"]))
            XCTAssertEqual(String(data: try o.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: try o.canonicalBytes()))
        }
    }

    func testBackupPolicyRefusesEveryInvalidOrder() throws {
        let v = try vectors("backup-policy")
        for c in try XCTUnwrap(v["invalid"] as? [[String: Any]]) {
            let o = BackupPolicyOrder(serverDomain: c["serverDomain"] as! String, policy: c["policy"] as! String,
                                      phoneReserveBytes: int64(c["phoneReserveBytes"]), issuedAt: int64(c["issuedAt"]))
            XCTAssertThrowsError(try o.canonicalBytes(), "\(c)")
        }
    }

    func testThePolicyRidesBesideThePairingOrder() throws {
        let o = BackupPolicyOrder.make(serverDomain: "Home.Harry.flagship.services", draft: .phoneOnly, reserveBytes: 32 << 30, issuedAt: 7)
        XCTAssertEqual(o.policy, "phone")
        XCTAssertEqual(o.serverDomain, "home.harry.flagship.services")
        XCTAssertEqual(BackupPolicyOrder.make(serverDomain: "a.b", draft: .peer, reserveBytes: 5, issuedAt: 1).phoneReserveBytes, 0)
        let json = ServerBackupFormat.attachBackupPolicy(toPairingJson: #"{"request":{"x":1},"signature":"ab"}"#, order: o, signatureHex: "cd")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let bp = try XCTUnwrap(obj["backupPolicy"] as? [String: Any])
        XCTAssertEqual(bp["signatureHex"] as? String, "cd")
        let order = try XCTUnwrap(bp["order"] as? [String: Any])
        XCTAssertEqual(order["policy"] as? String, "phone")
        XCTAssertEqual((order["phoneReserveBytes"] as? NSNumber)?.int64Value, 32 << 30)
        XCTAssertEqual(order["serverDomain"] as? String, "home.harry.flagship.services")
        XCTAssertEqual(obj["signature"] as? String, "ab", "the pairing order itself is unchanged")
    }

    // MARK: the one .flagship file

    func testBundleHeadersMatchTheVectors() throws {
        let v = try vectors("server-backup-bundle")
        for h in try XCTUnwrap(v["headers"] as? [[String: Any]]) {
            let n = Int(int64(h["metaLength"]))
            XCTAssertEqual(HexUtil.encode(try ServerBackupBundle.header(metaLength: n)), h["headerHex"] as? String)
        }
        XCTAssertThrowsError(try ServerBackupBundle.header(metaLength: 0))
        XCTAssertThrowsError(try ServerBackupBundle.header(metaLength: 262_145))
        let ex = try XCTUnwrap(v["example"] as? [String: Any])
        let meta = try XCTUnwrap(HexUtil.decode(ex["metaHex"] as! String))
        let data = try XCTUnwrap(HexUtil.decode(ex["dataHex"] as! String))
        let bundle = try ServerBackupBundle.make(meta: meta, data: data)
        XCTAssertEqual(HexUtil.encode(bundle), ex["bundleHex"] as? String)
        let layout = try ServerBackupBundle.parseHeader(bundle, fileBytes: Int64(bundle.count))
        XCTAssertEqual(layout.metaLength, int64(ex["metaLength"]))
        XCTAssertEqual(layout.dataOffset, int64(ex["dataOffset"]))
        XCTAssertEqual(layout.dataLength, Int64(data.count))
    }

    func testBundleRefusesEveryInvalidHeaderWithASentence() throws {
        let v = try vectors("server-backup-bundle")
        for c in try XCTUnwrap(v["invalid"] as? [[String: Any]]) {
            let head = try XCTUnwrap(HexUtil.decode(c["headHex"] as! String))
            XCTAssertThrowsError(try ServerBackupBundle.parseHeader(head, fileBytes: int64(c["fileBytes"])), "\(c["why"] ?? "")") { e in
                let sentence = (e as? LocalizedError)?.errorDescription ?? ""
                XCTAssertFalse(sentence.isEmpty)
                XCTAssertTrue(sentence.hasSuffix("."), sentence)
            }
        }
    }

    func testFileNames() {
        XCTAssertEqual(ServerBackupBundle.fileName(forPart: "home-2026-10-16-0300.flagship-backup"), "home-2026-10-16-0300.flagship")
        XCTAssertEqual(ServerBackupBundle.fileName(forPart: "home-2026-10-16-0300.flagship-data"), "home-2026-10-16-0300.flagship")
        XCTAssertEqual(ServerArchiveRoute.bundleName(forPart: "home.flagship-data"), "home.flagship")
        XCTAssertEqual(ServerArchiveRoute.saved(archiveId: "ab").base, "/api/screens/server-archive/backups/ab")
    }
}
