import XCTest
import CryptoKit
@testable import FlagshipCore

final class AiRepairConsentTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/ai-repair-consent/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    private func build(_ o: [String: Any]) throws -> Data {
        guard let op = AiRepairConsent.Operation(rawValue: o["operation"] as! String), let src = AiRepairConsent.Source(rawValue: o["source"] as! String) else {
            throw AiRepairConsent.Invalid(reason: "unknown word")
        }
        return try AiRepairConsent(
            serverDomain: o["serverDomain"] as! String, buildId: o["buildId"] as! String, operation: op,
            provider: o["provider"] as! String, source: src,
            highTokens: (o["highTokens"] as! NSNumber).int64Value, issuedAt: (o["issuedAt"] as! NSNumber).int64Value
        ).canonicalBytes()
    }

    func testCanonicalBytesAndSignaturesMatchTheSharedVector() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v["pubHex"] as! String))
        for entry in v["orders"] as! [[String: Any]] {
            let bytes = try build(entry["order"] as! [String: Any])
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), entry["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(entry["signatureHex"] as! String), for: bytes))
        }
    }

    func testMalformedOrdersAreRefused() throws {
        for entry in try (vectors()["refused"] as! [[String: Any]]) {
            XCTAssertThrowsError(try build(entry["order"] as! [String: Any]), entry["name"] as? String ?? "")
        }
    }
}
