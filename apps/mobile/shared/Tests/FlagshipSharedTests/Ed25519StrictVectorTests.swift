import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// packages/protocol/test-vectors/ed25519-strict: the app-side verify (CryptoKit behind the key check) is strict
/// (cofactorless, canonical R and S): it refuses the mixed-order R that ZIP-215 accepts and verifies the honest one.
final class Ed25519StrictVectorTests: XCTestCase {
    private func vectors() throws -> [String: String] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/ed25519-strict/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String])
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

    func test_mixedOrderRIsRefusedAndTheHonestSignatureVerifies() throws {
        let v = try vectors()
        let pubHex = try XCTUnwrap(v["publicKeyHex"])
        let msg = unhex(try XCTUnwrap(v["messageHex"]))
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(pubHex))
        let mixed = try XCTUnwrap(v["mixedOrderRSignatureHex"])
        let honest = try XCTUnwrap(v["honestSignatureHex"])
        XCTAssertFalse(key.isValidCheckedSignature(unhex(mixed), for: msg))
        XCTAssertFalse(CanonicalJson.ed25519VerifyHex(mixed, Array(msg), pubHex))
        XCTAssertTrue(key.isValidCheckedSignature(unhex(honest), for: msg))
        XCTAssertTrue(CanonicalJson.ed25519VerifyHex(honest, Array(msg), pubHex))
    }
}
