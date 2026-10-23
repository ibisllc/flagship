import XCTest
import CryptoKit
@testable import FlagshipCore

final class ServerWildcardGrantTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-wildcard-grant/vectors.json")
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

    private func grant(_ g: [String: Any]) -> ServerWildcardGrant {
        ServerWildcardGrant(username: g["username"] as! String, serverDomain: g["serverDomain"] as! String,
                            stkPubHex: g["stkPubHex"] as! String, issuedAt: (g["issuedAt"] as! NSNumber).int64Value)
    }

    func testCanonicalBytesAndSignaturesMatchTheSharedVector() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v["pubHex"] as! String))
        let grants = v["grants"] as! [[String: Any]]
        for entry in grants {
            let bytes = try grant(entry["grant"] as! [String: Any]).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), entry["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(entry["signatureHex"] as! String), for: bytes))
        }
        let firstSig = unhex(grants[0]["signatureHex"] as! String)
        for entry in v["invalid"] as! [[String: Any]] {
            XCTAssertFalse(pub.isValidSignature(firstSig, for: try grant(entry["grant"] as! [String: Any]).canonicalBytes()), entry["name"] as? String ?? "")
        }
    }

    func testMalformedGrantsAreRefused() throws {
        for entry in try vectors()["refused"] as! [[String: Any]] {
            XCTAssertThrowsError(try grant(entry["grant"] as! [String: Any]).canonicalBytes(), entry["name"] as? String ?? "")
        }
    }
}
