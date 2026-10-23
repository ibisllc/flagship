import XCTest
import CryptoKit
@testable import FlagshipCore

final class RePairVetoTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Req: Decodable { let username: String; let newIrkPub: String; let initiatedAt: Int64; let completesAt: Int64; let vetoerPub: String; let issuedAt: Int64 }
        struct Case: Decodable { let name: String; let request: Req; let canonical: String; let signatureHex: String; let valid: Bool }
        let adminSeedHex: String
        let adminPubHex: String
        let cases: [Case]
    }

    private func vectors() throws -> Vectors {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/re-pair-veto/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func data(hex: String) -> Data {
        var d = Data(); var i = hex.startIndex
        while i < hex.endIndex { let j = hex.index(i, offsetBy: 2); d.append(UInt8(hex[i..<j], radix: 16)!); i = j }
        return d
    }

    func testCanonicalBytesAndSignatureMatchTheSharedVectors() throws {
        let v = try vectors()
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: data(hex: v.adminSeedHex))
        XCTAssertEqual(key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined(), v.adminPubHex)
        for c in v.cases {
            let r = c.request
            let veto = RePairVeto(username: r.username, newIrkPubHex: r.newIrkPub, initiatedAt: r.initiatedAt, completesAt: r.completesAt, vetoerPubHex: r.vetoerPub, issuedAt: r.issuedAt)
            let bytes = try veto.canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c.canonical, c.name)
            let ok = key.publicKey.isValidSignature(data(hex: c.signatureHex), for: bytes)
            XCTAssertEqual(ok, c.valid, c.name)
        }
    }

    func testRefusesSeparatorsAndNegativeTimes() {
        XCTAssertThrowsError(try RePairVeto(username: "a|b", newIrkPubHex: "aa", initiatedAt: 1, completesAt: 2, vetoerPubHex: "bb", issuedAt: 3).canonicalBytes())
        XCTAssertThrowsError(try RePairVeto(username: "a", newIrkPubHex: "aa", initiatedAt: -1, completesAt: 2, vetoerPubHex: "bb", issuedAt: 3).canonicalBytes())
    }
}
