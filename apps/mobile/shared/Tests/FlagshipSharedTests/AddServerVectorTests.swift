import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins the admin approval of a new server (`flagship/auth-code-admin/v1`) and
/// the admin-signed restore order to
/// `packages/protocol/test-vectors/add-server/vectors.json`. Adding a server is
/// admin-only (owner rule 2026-10-16). CryptoKit's Ed25519 signatures are
/// randomized, so pinned signatures are checked by verifying them.
final class AddServerVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/add-server/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    private func pub(_ v: [String: Any], _ name: String) throws -> Curve25519.Signing.PublicKey {
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        return try Curve25519.Signing.PublicKey(rawRepresentation: try hex(keys[name]))
    }

    private func key(_ v: [String: Any], _ name: String) throws -> Curve25519.Signing.PrivateKey {
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        return try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(keys[name]))
    }

    private func code(_ f: [String: Any]) throws -> AuthCode {
        AuthCode(
            version: (f["version"] as! NSNumber).intValue,
            serial: f["serial"] as! String,
            username: f["username"] as! String,
            serverName: f["serverName"] as! String,
            serverDomain: f["serverDomain"] as! String,
            delegatedPubKey: try hex(f["delegatedPubKey"]),
            userPubKey: try hex(f["userPubKey"]),
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
            expiresAt: (f["expiresAt"] as! NSNumber).int64Value,
            adminRootPubKey: try (f["adminRootPubKey"] as? String).map { try hex($0) }
        )
    }

    func testReproducesBothCanonicalStringsAndVerifiesThePinnedSignatures() throws {
        let v = try vectors()
        let a = try XCTUnwrap(v["authCode"] as? [String: Any])
        let c = try code(try XCTUnwrap(a["fields"] as? [String: Any]))
        XCTAssertEqual(String(decoding: c.canonicalBytes(), as: UTF8.self), a["canonical"] as? String)
        XCTAssertEqual(String(decoding: try c.adminCanonicalBytes(), as: UTF8.self), a["adminCanonical"] as? String)
        XCTAssertTrue(try pub(v, "irkPubHex").isValidSignature(try hex(a["irkSignatureHex"]), for: c.canonicalBytes()))
        let admin = try pub(v, "adminRootPubHex")
        XCTAssertTrue(admin.isValidSignature(try hex(a["adminSignatureHex"]), for: try c.adminCanonicalBytes()))
        // Our own approval verifies too (the key derives the pinned public key).
        let ours = try key(v, "adminRootSeedHex")
        XCTAssertEqual(ours.publicKey.rawRepresentation, admin.rawRepresentation)
        XCTAssertTrue(admin.isValidSignature(try ours.signature(for: try c.adminCanonicalBytes()), for: try c.adminCanonicalBytes()))
    }

    func testRefusesEveryRejectAsTheAdminApproval() throws {
        let v = try vectors()
        let a = try XCTUnwrap(v["authCode"] as? [String: Any])
        let c = try code(try XCTUnwrap(a["fields"] as? [String: Any]))
        let admin = try pub(v, "adminRootPubHex")
        for r in try XCTUnwrap(v["reject"] as? [[String: Any]]) {
            XCTAssertFalse(admin.isValidSignature(try hex(r["signatureHex"]), for: try c.adminCanonicalBytes()), r["why"] as? String ?? "")
        }
    }

    func testACodePinningAnotherRootVerifiesOnlyUnderThatRoot() throws {
        let v = try vectors()
        let w = try XCTUnwrap(v["wrongRoot"] as? [String: Any])
        let c = try code(try XCTUnwrap(w["fields"] as? [String: Any]))
        XCTAssertEqual(String(decoding: try c.adminCanonicalBytes(), as: UTF8.self), w["adminCanonical"] as? String)
        let sig = try hex(w["adminSignatureHex"])
        XCTAssertTrue(try pub(v, "otherRootPubHex").isValidSignature(sig, for: try c.adminCanonicalBytes()))
        XCTAssertFalse(try pub(v, "adminRootPubHex").isValidSignature(sig, for: try c.adminCanonicalBytes()))
    }

    func testAnAuthCodeWithNoAdminRootHasNoAdminForm() throws {
        for r in try XCTUnwrap(try vectors()["refuse"] as? [[String: Any]]) {
            let c = try code(try XCTUnwrap(r["fields"] as? [String: Any]))
            XCTAssertThrowsError(try c.adminCanonicalBytes(), r["why"] as? String ?? "")
        }
    }

    func testTheRestoreOrderVerifiesOnlyUnderTheAdminRoot() throws {
        let v = try vectors()
        let r = try XCTUnwrap(v["restore"] as? [String: Any])
        let o = try XCTUnwrap(r["order"] as? [String: Any])
        let order = ServerBackupFormat.RestoreOrder(
            serverDomain: o["serverDomain"] as! String,
            archiveId: o["archiveId"] as! String,
            bytes: (o["bytes"] as! NSNumber).int64Value,
            sha256: o["sha256"] as! String,
            issuedAt: (o["issuedAt"] as! NSNumber).int64Value
        )
        let bytes = try order.canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), r["canonical"] as? String)
        let admin = try pub(v, "adminRootPubHex")
        XCTAssertTrue(admin.isValidSignature(try hex(r["adminSignatureHex"]), for: bytes))
        for x in try XCTUnwrap(r["reject"] as? [[String: Any]]) {
            XCTAssertFalse(admin.isValidSignature(try hex(x["signatureHex"]), for: bytes), x["why"] as? String ?? "")
        }
    }

    func testTheAdminOnlyRefusalMapsToTheAppsSentence() {
        let body = #"{"error":"Only an admin device of this account can add servers.","code":"add-server-admin-only"}"#
        XCTAssertEqual(ScreensClientError.http(status: 403, message: body).errorDescription, AddServerRefusal.message)
        XCTAssertEqual(AddServerRefusal.message, "Only an admin device of this account can add servers.")
        XCTAssertNotEqual(ScreensClientError.http(status: 403, message: "{}").errorDescription, AddServerRefusal.message)
    }
}
