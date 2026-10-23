import XCTest
import CryptoKit
@testable import FlagshipAPI

final class PublisherTrustTests: XCTestCase {
    private struct Vectors: Decodable {
        let ownerSeedHex: String
        let ownerPubHex: String
        let trust: PublisherTrust
        let canonical: String
        let signatureHex: String
    }

    private func vectors() throws -> Vectors {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/publisher-trust/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) { return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)) }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    func testCanonicalBytesAndSignatureMatchTheSharedVector() throws {
        let v = try vectors()
        XCTAssertEqual(String(decoding: try v.trust.canonicalBytes(), as: UTF8.self), v.canonical)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: RecoveryRecordV2.unhex(v.ownerSeedHex)!)
        XCTAssertEqual(key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined(), v.ownerPubHex)
        let canon = try v.trust.canonicalBytes()
        XCTAssertTrue(key.publicKey.isValidSignature(RecoveryRecordV2.unhex(v.signatureHex)!, for: canon))
        XCTAssertTrue(key.publicKey.isValidSignature(RecoveryRecordV2.unhex(try v.trust.sign(with: key))!, for: canon))
    }

    func testAFieldThatCouldSplitTheBytesIsRefused() throws {
        var t = try vectors().trust
        t.serviceId = "a|b"
        XCTAssertThrowsError(try t.canonicalBytes())
        t.serviceId = ""
        XCTAssertThrowsError(try t.canonicalBytes())
    }

    func testDeadlineWording() {
        XCTAssertEqual(SliverWords.remaining(nil), "")
        XCTAssertEqual(SliverWords.remaining(5 * 60_000), "5 minutes left")
        XCTAssertEqual(SliverWords.remaining(2 * 86_400_000 + 3 * 3_600_000), "2 days 3 hours left")
        XCTAssertEqual(SliverWords.remaining(-2 * 3_600_000), "overdue by 2 hours 0 minutes")
    }

    func testTheBoxsSliverJsonDecodes() throws {
        let json = #"{"lines":[{"eventId":"sv1","issueKey":"publisher-key:chess","kind":"publisher-key","severity":"high","target":"chess","state":"active","summary":"x","raisedAt":1,"updatedAt":2,"resolvedAt":null,"deadline":null,"action":"Review","acknowledgedAt":null,"escalatedFrom":null,"remainingMs":null}],"lostHistory":false}"#
        let r = try JSONDecoder().decode(SecuritySliverResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.lines.first?.target, "chess")
        XCTAssertTrue(r.lines[0].isActive)
    }
}
