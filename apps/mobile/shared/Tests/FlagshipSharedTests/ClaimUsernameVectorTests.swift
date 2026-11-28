import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins `flagship/claim-username/v2` to `packages/protocol/test-vectors/claim-username/vectors.json`: the IRK signs the
/// AID and admin-root keys the claim carries. CryptoKit's Ed25519 signatures are randomized, so pinned signatures are
/// checked by verifying them.
final class ClaimUsernameVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/claim-username/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    private func bytes(_ c: [String: Any]) throws -> Data {
        let r = try XCTUnwrap(c["request"] as? [String: Any])
        return UsernameClaim.canonicalBytes(
            username: try XCTUnwrap(r["username"] as? String),
            irkPubHex: try XCTUnwrap(r["irkPub"] as? String),
            aidPubHex: c["aidPub"] as? String,
            adminRootPubHex: c["adminRootPub"] as? String,
            issuedAt: try XCTUnwrap(r["issuedAt"] as? NSNumber).int64Value
        )
    }

    private func verifies(_ c: [String: Any], _ msg: Data) throws -> Bool {
        let r = try XCTUnwrap(c["request"] as? [String: Any])
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(r["irkPub"]))
        return pub.isValidSignature(try hex(c["signatureHex"]), for: msg)
    }

    func testAcceptCases() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(keys["irkSeedHex"]))
        for c in try XCTUnwrap(v["accept"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? "?"
            let msg = try bytes(c)
            XCTAssertEqual(String(data: msg, encoding: .utf8), c["canonical"] as? String, name)
            XCTAssertTrue(try verifies(c, msg), name)
            XCTAssertTrue(irk.publicKey.isValidSignature(try irk.signature(for: msg), for: msg), name)
        }
    }

    func testRejectCases() throws {
        let v = try vectors()
        for c in try XCTUnwrap(v["reject"] as? [[String: Any]]) {
            let name = c["name"] as? String ?? "?"
            let msg = try bytes(c)
            XCTAssertEqual(String(data: msg, encoding: .utf8), c["canonical"] as? String, name)
            XCTAssertFalse(try verifies(c, msg), name)
        }
    }
}
