import XCTest
@testable import FlagshipCore

final class RecoveryPasskeyTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/recovery-passkey/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    func testBuildsTheFieldsComChecks() throws {
        let v = try vectors()
        let challenge = v["challenge"] as! String
        XCTAssertEqual(RecoveryPasskey.base64url(try XCTUnwrap(RecoveryPasskey.challengeBytes(challenge))), challenge)
        for e in v["entries"] as! [[String: Any]] {
            let att = try XCTUnwrap(RecoveryPasskey.challengeBytes(e["attestationObject"] as! String))
            XCTAssertEqual(RecoveryPasskey.attestationField(att), e["attestationObject"] as? String)
            let a = e["assertion"] as! [String: String]
            let d = { (k: String) in RecoveryPasskey.challengeBytes(a[k]!)! }
            let field = RecoveryPasskey.fetchPasskeyField(challenge: challenge, credentialId: d("credentialId"), authenticatorData: d("authenticatorData"), clientDataJSON: d("clientDataJSON"), signature: d("signature"))
            XCTAssertEqual(field["challenge"] as? String, challenge)
            XCTAssertEqual(field["assertion"] as? [String: String], a)
        }
    }
}
