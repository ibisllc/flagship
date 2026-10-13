import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// The free-AI request (`flagship/llm-promo-issue/v1`) against THE reference,
/// `packages/protocol/test-vectors/llm-promo-issue/vectors.json`, loaded from
/// disk so a divergence surfaces here, not as `.com` refusing the signature.
final class FreeAiVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/llm-promo-issue/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func test_canonicalBytesAndPinnedSignatures() throws {
        let v = try vectors()
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        let all = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let req = FreeAiIssueRequest(
                username: c["username"] as! String,
                serverFqdn: c["serverFqdn"] as! String,
                issuedAt: (c["issuedAt"] as! NSNumber).int64Value,
                provider: c["provider"] as! String,
                desiredDailyInputTokenCap: (c["desiredDailyInputTokenCap"] as! NSNumber).int64Value,
                desiredDailyOutputTokenCap: (c["desiredDailyOutputTokenCap"] as! NSNumber).int64Value)
            XCTAssertEqual(req.provider, FreeAiIssueRequest.provider)
            XCTAssertEqual(String(data: req.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: req.canonicalBytes()))
            let mine = try key.signature(for: req.canonicalBytes())
            XCTAssertTrue(key.publicKey.isValidSignature(mine, for: req.canonicalBytes()))
            let tampered = [
                FreeAiIssueRequest(username: req.username + "x", serverFqdn: req.serverFqdn, issuedAt: req.issuedAt),
                FreeAiIssueRequest(username: req.username, serverFqdn: req.serverFqdn + "x", issuedAt: req.issuedAt),
                FreeAiIssueRequest(username: req.username, serverFqdn: req.serverFqdn, issuedAt: req.issuedAt + 1),
                FreeAiIssueRequest(username: req.username, serverFqdn: req.serverFqdn, issuedAt: req.issuedAt,
                                   provider: "openai"),
                FreeAiIssueRequest(username: req.username, serverFqdn: req.serverFqdn, issuedAt: req.issuedAt,
                                   desiredDailyInputTokenCap: 1),
            ]
            for t in tampered {
                XCTAssertFalse(key.publicKey.isValidSignature(pinned, for: t.canonicalBytes()))
            }
        }
    }

    func test_wireShapeMatchesTheWorker() throws {
        let body = FreeAiSignedRequest(
            request: FreeAiIssueRequest(username: "harry", serverFqdn: "home.harry.flagship.services", issuedAt: 1),
            signature: "ab")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        let req = try XCTUnwrap(obj["request"] as? [String: Any])
        XCTAssertEqual(Set(req.keys), ["username", "serverFqdn", "provider", "desiredDailyInputTokenCap",
                                       "desiredDailyOutputTokenCap", "issuedAt"])
        XCTAssertEqual(req["provider"] as? String, "flagship")
        XCTAssertEqual(obj["signature"] as? String, "ab")
    }
}
