import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins `ServerBackupFormat` to packages/protocol/test-vectors/server-backup
/// and server-restore (the passcode's Argon2id is pinned in the iOS package's
/// ServerBackupPasscodeTests; here the vectors' passcode key is the input).
final class ServerBackupFormatTests: XCTestCase {
    private func vectors(_ name: String) throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/\(name)/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ v: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(v as? String))) }

    func testRecreatesTheSlotsAndOpensTheFileBothWays() throws {
        let b = try vectors("server-backup")
        let id = b["archiveId"] as! String
        let key = try hex(b["contentKeyHex"])
        let accountKek = try hex(b["accountKekHex"])
        XCTAssertEqual(ServerArchive.deriveKey(umkSeed: try hex(b["umkSeedHex"]), archiveId: id), accountKek)
        let n = b["slotNonces"] as! [String: Any]
        let slots = b["slots"] as! [String: Any]
        let passSlot = try XCTUnwrap(ServerBackupFormat.parseSlot(slots["passcode"]))
        let acctSlot = try XCTUnwrap(ServerBackupFormat.parseSlot(slots["account"]))
        let passKek = try hex(b["passcodeKekHex"])
        XCTAssertEqual(try ServerBackupFormat.wrapPasscodeSlot(archiveId: id, contentKey: key, kek: passKek, kdf: passSlot.kdf!, nonce: try hex(n["passcodeNonceHex"])), passSlot)
        XCTAssertEqual(try ServerBackupFormat.wrapAccountSlot(archiveId: id, contentKey: key, kek: accountKek, nonce: try hex(n["accountNonceHex"])), acctSlot)

        let file = try ServerBackupFormat.parse(Data((b["file"] as! String).utf8))
        let viaAccount = try XCTUnwrap(try ServerBackupFormat.openWithAccountKey(file, kek: accountKek))
        XCTAssertEqual(viaAccount.contentKey, key)
        let viaPass = try ServerBackupFormat.openWithPasscodeKey(file, kek: passKek)
        XCTAssertEqual(viaPass.body, viaAccount.body)
        let body = b["body"] as! [String: Any]
        XCTAssertEqual(viaPass.body.server.name, (body["server"] as! [String: Any])["name"] as? String)
        XCTAssertEqual(viaPass.body.server.bootUnlockMode, "approve")
        XCTAssertEqual(viaPass.body.apps.map(\.name), ["Notes", "Chess Club"])
        XCTAssertEqual(viaPass.body.left.count, 1)
        XCTAssertEqual(viaPass.body.data.bytes, 123_456_789)
        XCTAssertEqual(viaPass.body.data.sha256, String(repeating: "ab", count: 32))

        // Another account's key opens nothing; a wrong passcode key is refused.
        let other = try XCTUnwrap(ServerArchive.deriveKey(umkSeed: try hex(b["wrongUmkSeedHex"]), archiveId: id))
        XCTAssertNil(try ServerBackupFormat.openWithAccountKey(file, kek: other))
        XCTAssertThrowsError(try ServerBackupFormat.openWithPasscodeKey(file, kek: Data(count: 32))) {
            XCTAssertEqual($0 as? ServerBackupFormat.FormatError, .wrongPasscode)
        }
    }

    func testRefusesTamperedAndMalformedFiles() throws {
        let b = try vectors("server-backup")
        let accountKek = try hex(b["accountKekHex"])
        let passKek = try hex(b["passcodeKekHex"])
        for t in b["tampered"] as! [[String: Any]] {
            let why = t["why"] as! String
            let f = try ServerBackupFormat.parse(Data((t["file"] as! String).utf8))
            XCTAssertThrowsError(try ServerBackupFormat.openWithPasscodeKey(f, kek: passKek), why)
            let acct: ServerBackupFormat.Opened? = (try? ServerBackupFormat.openWithAccountKey(f, kek: accountKek)) ?? nil
            if why == "passcode params changed" {
                XCTAssertEqual(acct?.via, "account", why)
            } else {
                XCTAssertNil(acct, why)
            }
        }
        for m in b["malformed"] as! [[String: Any]] {
            let why = m["why"] as! String
            XCTAssertThrowsError(try ServerBackupFormat.parse(Data((m["file"] as! String).utf8)), why) { e in
                let fe = e as? ServerBackupFormat.FormatError
                if m["code"] as? String == "version" {
                    XCTAssertTrue(fe == .newerVersion || fe == .olderVersion, why)
                } else {
                    XCTAssertTrue(fe == .notABackup || fe == .damaged, why)
                }
            }
        }
    }

    func testPasscodeRulesAndGenerator() throws {
        let b = try vectors("server-backup")
        let rules = b["passcodeRules"] as! [String: [String]]
        for p in rules["ok"]! { XCTAssertNil(ServerBackupFormat.passcodeProblem(p), p) }
        for p in rules["weak"]! { XCTAssertNotNil(ServerBackupFormat.passcodeProblem(p), p) }
        XCTAssertEqual(String(ServerBackupFormat.passcodeAlphabet), b["alphabet"] as? String)
        let g = b["generatedPasscode"] as! [String: Any]
        var bytes = try hex(g["rngBytesHex"])
        let made = ServerBackupFormat.generatePasscode { n in
            let out = bytes.prefix(n)
            bytes = bytes.dropFirst(n)
            return Data(out)
        }
        XCTAssertEqual(made, g["passcode"] as? String)
        XCTAssertEqual(ServerBackupFormat.normalizePasscode("  Cafe\u{301} \n"), "Caf\u{e9}")
    }

    func testRestoreOrderMatchesTheVectorsAndRidesBesideThePairingOrder() throws {
        let r = try vectors("server-restore")
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: try hex(r["umkSeedHex"])))
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(irk.publicKey.rawRepresentation), r["pub"] as? String)
        for c in r["cases"] as! [[String: Any]] {
            let o = c["order"] as! [String: Any]
            let order = ServerBackupFormat.RestoreOrder(
                serverDomain: o["serverDomain"] as! String, archiveId: o["archiveId"] as! String,
                bytes: (o["bytes"] as! NSNumber).int64Value, sha256: o["sha256"] as! String,
                issuedAt: (o["issuedAt"] as! NSNumber).int64Value
            )
            let canonical = try order.canonicalBytes()
            XCTAssertEqual(String(data: canonical, encoding: .utf8), c["canonical"] as? String)
            XCTAssertTrue(irk.publicKey.isValidSignature(try hex(c["signature"]), for: canonical))
            let json = ServerBackupFormat.attachRestore(toPairingJson: "{\"request\":{},\"signature\":\"ab\"}", order: order, signatureHex: c["signature"] as! String)
            let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            let restore = try XCTUnwrap(parsed["restore"] as? [String: Any])
            XCTAssertEqual(restore["signatureHex"] as? String, c["signature"] as? String)
            XCTAssertEqual((restore["order"] as? NSDictionary), o as NSDictionary)
            XCTAssertEqual(parsed["signature"] as? String, "ab")
        }
        for bad in r["invalid"] as! [[String: Any]] {
            let order = ServerBackupFormat.RestoreOrder(
                serverDomain: bad["serverDomain"] as! String, archiveId: bad["archiveId"] as! String,
                bytes: (bad["bytes"] as! NSNumber).int64Value, sha256: bad["sha256"] as! String,
                issuedAt: (bad["issuedAt"] as! NSNumber).int64Value
            )
            XCTAssertThrowsError(try order.canonicalBytes())
        }
    }

    func testChecksTheDataFileBySizeAndHash() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let raw = Data(ServerBackupFormat.dataMagic.utf8) + Data(repeating: 3, count: 5000)
        let url = dir.appendingPathComponent("home.flagship-data")
        try raw.write(to: url)
        let info = ServerBackupFormat.DataInfo(fileName: "home.flagship-data", bytes: Int64(raw.count),
                                               sha256: HexUtil.encode(Data(SHA256.hash(data: raw))), frameBytes: 1 << 20)
        try await ServerBackupFormat.checkDataFile(url, against: info, sliceBytes: 1000)
        XCTAssertEqual(ServerBackupFormat.classify(head: raw.prefix(64), size: Int64(raw.count)), .data)
        XCTAssertEqual(ServerBackupFormat.classify(head: Data("{\"magic\"".utf8), size: 100), .backup)
        XCTAssertNil(ServerBackupFormat.classify(head: Data("hello".utf8), size: 5))
        do {
            try await ServerBackupFormat.checkDataFile(url, against: .init(fileName: info.fileName, bytes: info.bytes, sha256: String(repeating: "00", count: 32), frameBytes: 1 << 20))
            XCTFail("a changed file passed")
        } catch { XCTAssertEqual(error as? ServerBackupFormat.DataCheckError, .mismatch) }
        do {
            try await ServerBackupFormat.checkDataFile(url, against: .init(fileName: info.fileName, bytes: info.bytes + 1, sha256: info.sha256, frameBytes: 1 << 20))
            XCTFail("a wrong size passed")
        } catch { XCTAssertEqual(error as? ServerBackupFormat.DataCheckError, .wrongSize(expected: "home.flagship-data")) }
    }
}
