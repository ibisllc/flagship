import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// packages/protocol/test-vectors/ed25519-low-order: every app-side Ed25519 verify refuses small-order and
/// non-canonical keys before the signature is checked (CryptoKit alone accepts most of them), while the
/// honest key still verifies.
final class Ed25519LowOrderVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/ed25519-low-order/vectors.json")
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

    func test_everyVectorKeyIsRefusedAndTheHonestOneAccepted() throws {
        let v = try vectors()
        for k in v["rejectPublicKeysHex"] as! [String] {
            XCTAssertFalse(Ed25519Keys.isAcceptable(unhex(k)), k)
            XCTAssertFalse(Ed25519Keys.isAcceptableHex(k), k)
        }
        let honest = v["honest"] as! [String: Any]
        XCTAssertTrue(Ed25519Keys.isAcceptableHex(honest["publicKeyHex"] as! String))
    }

    func test_theForgedSignatureVerifiesUnderNoVectorKey() throws {
        let v = try vectors()
        let forged = v["forgedSignatureHex"] as! String
        for k in v["rejectPublicKeysHex"] as! [String] {
            for m in v["messagesHex"] as! [String] {
                if let key = try? Curve25519.Signing.PublicKey(rawRepresentation: unhex(k)) {
                    XCTAssertFalse(key.isValidCheckedSignature(unhex(forged), for: unhex(m)), "\(k) \(m)")
                }
                XCTAssertFalse(CanonicalJson.ed25519VerifyHex(forged, Array(unhex(m)), k), "\(k) \(m)")
            }
        }
    }

    func test_theHonestKeyStillVerifies() throws {
        let v = try vectors()
        let honest = v["honest"] as! [String: Any]
        let pubHex = honest["publicKeyHex"] as! String
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(pubHex))
        for s in honest["signatures"] as! [[String: Any]] {
            let msg = unhex(s["messageHex"] as! String)
            let sigHex = s["signatureHex"] as! String
            XCTAssertTrue(key.isValidCheckedSignature(unhex(sigHex), for: msg))
            XCTAssertTrue(CanonicalJson.ed25519VerifyHex(sigHex, Array(msg), pubHex))
        }
    }
}
