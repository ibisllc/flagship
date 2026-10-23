import XCTest
import CryptoKit
@testable import FlagshipCore

final class OfflineSecretsTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/offline-secrets/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    func testCanonicalBytesCommitmentAndSignatureMatchTheSharedVectors() throws {
        let v = try vectors()
        let good = try XCTUnwrap((v["cases"] as? [[String: Any]])?.first)
        let sibling = try XCTUnwrap(good["sibling"] as? [String: Any])
        let swk = try XCTUnwrap(good["swkHex"] as? String)
        XCTAssertEqual(try OfflineSecretsCommitment.commitment(toSwkHex: swk), sibling["swkSha256Hex"] as? String)
        let canon = try OfflineSecretsCommitment.canonicalBytes(
            serverDomain: sibling["serverDomain"] as! String, serial: sibling["serial"] as! String,
            swkSha256Hex: sibling["swkSha256Hex"] as! String, issuedAt: (sibling["issuedAt"] as! NSNumber).int64Value)
        XCTAssertEqual(String(decoding: canon, as: UTF8.self), v["canonicalOfGood"] as? String)
        // CryptoKit's signatures are randomized, so check both directions by verification: the
        // vector's signature verifies, and ours verifies under the same key.
        let seedHex = try XCTUnwrap(v["userSeedHex"] as? String)
        let seed = Data(stride(from: 0, to: seedHex.count, by: 2).map { UInt8(seedHex[seedHex.index(seedHex.startIndex, offsetBy: $0)...][..<seedHex.index(seedHex.startIndex, offsetBy: $0 + 2)], radix: 16)! })
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        let signed = try OfflineSecretsCommitment.sign(
            serverDomain: sibling["serverDomain"] as! String, serial: sibling["serial"] as! String, swkHex: swk,
            issuedAt: (sibling["issuedAt"] as! NSNumber).int64Value, with: key)
        func unhex(_ h: String) -> Data { Data(stride(from: 0, to: h.count, by: 2).map { UInt8(h[h.index(h.startIndex, offsetBy: $0)...][..<h.index(h.startIndex, offsetBy: $0 + 2)], radix: 16)! }) }
        XCTAssertTrue(key.publicKey.isValidSignature(unhex(sibling["signatureHex"] as! String), for: canon))
        XCTAssertTrue(key.publicKey.isValidSignature(unhex(signed.signatureHex), for: canon))
    }

    func testRefusesSeparatorsAndMalformedValues() {
        XCTAssertThrowsError(try OfflineSecretsCommitment.canonicalBytes(serverDomain: "a|b", serial: "s", swkSha256Hex: String(repeating: "a", count: 64), issuedAt: 1))
        XCTAssertThrowsError(try OfflineSecretsCommitment.canonicalBytes(serverDomain: "a", serial: "s", swkSha256Hex: "xyz", issuedAt: 1))
        XCTAssertThrowsError(try OfflineSecretsCommitment.commitment(toSwkHex: "00"))
    }
}
