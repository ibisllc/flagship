import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins `AutoUnlockLeaseV2` to `packages/protocol/test-vectors/auto-unlock-lease/vectors.json`:
/// the lease is signed by the owner IRK, which is the key the boot worker
/// verifies it against; a lease signed by the admin root does not verify under
/// the IRK. CryptoKit's Ed25519 signatures are randomized, so the pinned
/// signatures are checked by verifying them.
final class AutoUnlockLeaseVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/auto-unlock-lease/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    private func lease(_ v: [String: Any]) throws -> AutoUnlockLeaseV2 {
        let l = try XCTUnwrap(v["lease"] as? [String: Any])
        return AutoUnlockLeaseV2(
            serverDomain: l["serverDomain"] as! String,
            stkPub: try hex(l["stkPubHex"]),
            leaseId: l["leaseId"] as! String,
            sealedKey: try hex(l["sealedKeyHex"]),
            issuedAt: (l["issuedAt"] as! NSNumber).int64Value,
            expiresAt: (l["expiresAt"] as! NSNumber).int64Value
        )
    }

    func testTheIrkSignatureVerifiesAndTheAdminRootsDoesNot() throws {
        let v = try vectors()
        let lease = try lease(v)
        let canonical = try lease.canonicalBytes()
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self), v["canonical"] as? String)
        let irk = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(v["irkSeedHex"]))
        XCTAssertEqual(HexUtil.encode(irk.publicKey.rawRepresentation), v["irkPubHex"] as? String)
        XCTAssertTrue(irk.publicKey.isValidSignature(try hex(v["irkSignatureHex"]), for: canonical))
        XCTAssertFalse(irk.publicKey.isValidSignature(try hex(v["adminSignatureHex"]), for: canonical))
        // Our own signature (the IRK's, as SecretRequestCoordinator signs it) verifies under the IRK.
        XCTAssertTrue(irk.publicKey.isValidSignature(try lease.sign(with: irk), for: canonical))
    }
}
