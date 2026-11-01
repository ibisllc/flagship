import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the phone's RootEntitlement (the boot-approval carrier it signs) to
/// `packages/protocol/test-vectors/entitlements/vectors.json`. Only the `root` cases reach a phone:
/// service entitlements, revocation lists, tunnel hellos and service grants are box and relay records.
final class EntitlementVectorTests: XCTestCase {
    private func rootCases() throws -> [[String: Any]] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/entitlements/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                let v = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
                let all = try XCTUnwrap(v["cases"] as? [[String: Any]])
                return all.filter { $0["kind"] as? String == "root" }
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    private func entitlement(_ c: [String: Any]) throws -> RootEntitlement {
        let i = try XCTUnwrap(c["input"] as? [String: Any])
        return RootEntitlement(
            username: try XCTUnwrap(i["username"] as? String), podPubKey: try hex(i["podPubKeyHex"]),
            podCanonical: try XCTUnwrap(i["podCanonical"] as? String),
            issuedAt: try XCTUnwrap((i["issuedAt"] as? NSNumber)?.int64Value))
    }

    func test_rootEntitlement() throws {
        let cases = try rootCases()
        XCTAssertGreaterThanOrEqual(cases.count, 5)
        let anyKey = Curve25519.Signing.PrivateKey()
        for c in cases {
            let name = c["name"] as? String ?? ""
            let e = try entitlement(c)
            guard let canonical = c["canonical"] as? String else {
                XCTAssertThrowsError(try e.sign(with: anyKey), name)
                continue
            }
            XCTAssertEqual(String(decoding: e.canonicalBytes(), as: UTF8.self), canonical, name)
            XCTAssertEqual(HexUtil.encode(Data(SHA256.hash(data: e.canonicalBytes()))), c["certId"] as? String, name)
            let signer = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(c["signerPubHex"]))
            let verifies = try XCTUnwrap(c["verifies"] as? Bool)
            XCTAssertEqual(RootEntitlement.verify(e, signature: try hex(c["signatureHex"]), irkPub: signer), verifies, name)
        }
    }
}
