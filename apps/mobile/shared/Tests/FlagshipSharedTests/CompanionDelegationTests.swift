import XCTest
import CryptoKit
@testable import FlagshipAPI

final class CompanionDelegationTests: XCTestCase {
    private struct Vectors: Decodable {
        struct D: Decodable { let sessionId: String; let serviceRef: String; let ops: [String]; let issuedAt: Int64; let expiresAt: Int64 }
        struct Invalid: Decodable { let name: String; let delegation: D; let canonical: String }
        let adminPubHex: String
        let delegation: D
        let canonical: String
        let signatureHex: String
        let invalid: [Invalid]
    }

    private func vectors() throws -> Vectors {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/companion-delegation/vectors.json")
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

    private func order(_ d: Vectors.D) -> CompanionDelegationOrder {
        CompanionDelegationOrder(sessionId: d.sessionId, serviceRef: d.serviceRef, ops: d.ops, issuedAt: d.issuedAt, expiresAt: d.expiresAt)
    }

    func testCanonicalBytesSortTheOperationsAndMatchTheSignature() throws {
        let v = try vectors()
        let bytes = try order(v.delegation).canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), v.canonical)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v.adminPubHex))
        XCTAssertTrue(pub.isValidSignature(unhex(v.signatureHex), for: bytes))
    }

    func testEveryOtherSessionAppOperationsOrWindowFailsTheSameSignature() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v.adminPubHex))
        for bad in v.invalid {
            let bytes = try order(bad.delegation).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), bad.canonical, bad.name)
            XCTAssertFalse(pub.isValidSignature(unhex(v.signatureHex), for: bytes), bad.name)
        }
    }

    func testMalformedDelegationsAreRefused() throws {
        let d = try vectors().delegation
        func make(_ f: (inout [String: Any]) -> Void = { _ in }) -> CompanionDelegationOrder { order(d) }
        XCTAssertThrowsError(try CompanionDelegationOrder(sessionId: d.sessionId, serviceRef: d.serviceRef, ops: [], issuedAt: d.issuedAt, expiresAt: d.expiresAt).canonicalBytes())
        XCTAssertThrowsError(try CompanionDelegationOrder(sessionId: d.sessionId, serviceRef: d.serviceRef, ops: ["root"], issuedAt: d.issuedAt, expiresAt: d.expiresAt).canonicalBytes())
        XCTAssertThrowsError(try CompanionDelegationOrder(sessionId: "short", serviceRef: d.serviceRef, ops: ["build"], issuedAt: d.issuedAt, expiresAt: d.expiresAt).canonicalBytes())
        XCTAssertThrowsError(try CompanionDelegationOrder(sessionId: d.sessionId, serviceRef: "a|b", ops: ["build"], issuedAt: d.issuedAt, expiresAt: d.expiresAt).canonicalBytes())
        XCTAssertThrowsError(try CompanionDelegationOrder(sessionId: d.sessionId, serviceRef: d.serviceRef, ops: ["build"], issuedAt: d.issuedAt, expiresAt: d.issuedAt).canonicalBytes())
        _ = make
    }
}
