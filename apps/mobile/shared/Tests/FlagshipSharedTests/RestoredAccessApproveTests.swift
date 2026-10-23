import XCTest
import CryptoKit
@testable import FlagshipAPI

final class RestoredAccessApproveTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Order: Decodable { let serviceRef: String; let draftSha256: String; let issuedAt: Int64 }
        struct Invalid: Decodable { let name: String; let order: Order; let canonical: String }
        let adminSeedHex: String
        let adminPubHex: String
        let order: Order
        let canonical: String
        let signatureHex: String
        let invalid: [Invalid]
    }

    private func vectors() throws -> Vectors {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/restored-access-approve/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) { return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)) }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    private func order(_ o: Vectors.Order) -> RestoredAccessApproveOrder {
        RestoredAccessApproveOrder(serviceRef: o.serviceRef, draftSha256: o.draftSha256, issuedAt: o.issuedAt)
    }

    func testCanonicalBytesAndSignatureMatchTheSharedVector() throws {
        let v = try vectors()
        let bytes = try order(v.order).canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), v.canonical)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v.adminPubHex))
        XCTAssertTrue(pub.isValidSignature(unhex(v.signatureHex), for: bytes))
    }

    func testEveryOtherAppOrDraftFailsTheSameSignature() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v.adminPubHex))
        for bad in v.invalid {
            let bytes = try order(bad.order).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), bad.canonical, bad.name)
            XCTAssertFalse(pub.isValidSignature(unhex(v.signatureHex), for: bytes), bad.name)
        }
    }

    func testMalformedFieldsAreRefused() {
        XCTAssertThrowsError(try RestoredAccessApproveOrder(serviceRef: "a|b", draftSha256: String(repeating: "a", count: 64), issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try RestoredAccessApproveOrder(serviceRef: "alice--chess", draftSha256: "xyz", issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try RestoredAccessApproveOrder(serviceRef: "alice--chess", draftSha256: String(repeating: "a", count: 64), issuedAt: -1).canonicalBytes())
    }
}
