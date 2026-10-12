import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// The iOS access-list port against THE reference,
/// `packages/protocol/test-vectors/app-access/vectors.json`, loaded from disk
/// (never transcribed) so a divergence surfaces here, not as a box refusing
/// what the phone signed.
final class AppAccessVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-access/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func cases(_ key: String) throws -> [[String: Any]] {
        try XCTUnwrap(try vectors()[key] as? [[String: Any]], "missing \(key)")
    }

    func test_defaultList() throws {
        XCTAssertEqual(AppAccessList.defaultList, try vectors()["defaultList"] as? String)
        XCTAssertEqual(AppAccessList.parse(AppAccessList.defaultList).rules, [])
        XCTAssertTrue(AppAccessList.parse(AppAccessList.defaultList).isValid)
    }

    func test_normalize() throws {
        let all = try cases("normalize")
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let input = try XCTUnwrap(c["in"] as? String)
            XCTAssertEqual(AppAccessList.normalize(input), c["out"] as? String, "normalize \(input.debugDescription)")
            XCTAssertTrue(AppAccessList.isNormalized(AppAccessList.normalize(input)))
        }
    }

    func test_parse() throws {
        let all = try cases("parse")
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let list = try XCTUnwrap(c["list"] as? String)
            let got = AppAccessList.parse(list)
            let label = String(list.prefix(80)).debugDescription
            if let errors = c["errors"] as? [[String: Any]] {
                let want = errors.map { AppAccessLineError(line: $0["line"] as! Int, message: $0["message"] as! String) }
                XCTAssertEqual(got.errors, want, "errors for \(label)")
            } else {
                XCTAssertEqual(got.errors, [], "no errors for \(label)")
            }
            if let rules = c["rules"] as? [[String: Any]] {
                let want = rules.map {
                    AppAccessRule(line: $0["line"] as! Int,
                                  action: AppAccessAction(rawValue: $0["action"] as! String)!,
                                  target: $0["target"] as! String)
                }
                XCTAssertEqual(got.rules, want, "rules for \(label)")
            }
        }
    }

    func test_decide() throws {
        let all = try cases("decide")
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let list = try XCTUnwrap(c["list"] as? String)
            let host = try XCTUnwrap(c["host"] as? String)
            let got = AppAccessList.decide(list, host: host)
            XCTAssertEqual(got.result.rawValue, c["result"] as? String, "\(host) in \(list.debugDescription)")
            XCTAssertEqual(got.rule, c["rule"] as? Int, "rule for \(host) in \(list.debugDescription)")
        }
    }

    func test_withRule() throws {
        let all = try cases("withRule")
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let list = try XCTUnwrap(c["list"] as? String)
            let action = try XCTUnwrap(AppAccessAction(rawValue: c["action"] as! String))
            let host = try XCTUnwrap(c["host"] as? String)
            XCTAssertEqual(AppAccessList.withRule(list, action: action, host: host), c["out"] as? String,
                           "\(action) \(host) on \(list.debugDescription)")
        }
    }

    func test_sign_hashCanonicalAndPinnedSignatures() throws {
        let sign = try XCTUnwrap(try vectors()["sign"] as? [String: Any])
        let umk = try XCTUnwrap(HexUtil.decode(sign["umkSeedHex"] as! String))
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), sign["pub"] as? String)
        let all = try XCTUnwrap(sign["cases"] as? [[String: Any]])
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let list = try XCTUnwrap(c["list"] as? String)
            XCTAssertEqual(AppAccessList.sha256Hex(list), c["listSha256"] as? String)
            let grant = AppAccessGrant(serverDomain: c["serverDomain"] as! String, serviceId: c["serviceId"] as! String,
                                       list: list, issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
            XCTAssertEqual(grant.listSha256, c["listSha256"] as? String)
            XCTAssertEqual(String(data: grant.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: grant.canonicalBytes()))
            // CryptoKit's signatures are randomized: ours differs but verifies.
            let mine = try key.signature(for: grant.canonicalBytes())
            XCTAssertTrue(key.publicKey.isValidSignature(mine, for: grant.canonicalBytes()))
            let other = AppAccessGrant(serverDomain: "other.harry.flagship.services", serviceId: grant.serviceId,
                                       listSha256: grant.listSha256, issuedAt: grant.issuedAt)
            XCTAssertFalse(key.publicKey.isValidSignature(pinned, for: other.canonicalBytes()))
        }
    }

    func test_requestWireShape() throws {
        let grant = AppAccessGrant(serverDomain: "home.harry.flagship.services", serviceId: "harry-weather",
                                   list: "allow a.com\n", issuedAt: 1_700_000_000_000)
        let body = AppAccessSetRequest(list: "allow a.com\n", grant: grant, signature: String(repeating: "ab", count: 64))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(obj["list"] as? String, "allow a.com\n")
        let g = try XCTUnwrap(obj["grant"] as? [String: Any])
        XCTAssertEqual(Set(g.keys), ["serverDomain", "serviceId", "listSha256", "issuedAt"])
        XCTAssertEqual(g["listSha256"] as? String, AppAccessList.sha256Hex("allow a.com\n"))
        XCTAssertEqual((g["issuedAt"] as? NSNumber)?.int64Value, 1_700_000_000_000)
        XCTAssertEqual((obj["signature"] as? String)?.count, 128)
    }
}
