import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins the Swift port of the security notice (docs/security-notices.md) to
/// `packages/protocol/test-vectors/security-notice/vectors.json`: the same
/// canonical bytes, the same refusals, the same decisions and the same
/// anti-rollback as the TypeScript reference and the webapp.
final class SecurityNoticeVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/security-notice/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func list(_ v: [String: Any], _ key: String) throws -> [[String: Any]] {
        try XCTUnwrap(v[key] as? [[String: Any]], key)
    }

    private func authorityKey(_ v: [String: Any]) throws -> String {
        try XCTUnwrap((v["keys"] as? [String: Any])?["authorityPubHex"] as? String)
    }

    func testPositiveNoticesParseReproduceTheCanonicalStringAndVerify() throws {
        let v = try vectors()
        let authority = try authorityKey(v)
        let rows = try list(v, "positive")
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let n = try XCTUnwrap(SecurityNotice.parse(row["notice"]), name)
            let canonical = try SecurityNoticeRules.canonical(n.body, signedBy: n.signedBy)
            XCTAssertEqual(String(decoding: canonical, as: UTF8.self), row["canonical"] as? String, name)
            XCTAssertNil(SecurityNoticeVerifier.verify(n, authorityKeys: [authority]), name)
        }
    }

    func testRejectedNoticesAreRefusedForTheNamedReason() throws {
        let v = try vectors()
        let authority = try authorityKey(v)
        for row in try list(v, "reject") {
            let name = row["name"] as? String ?? "?"
            let expect = try XCTUnwrap(row["expect"] as? String, name)
            guard let n = SecurityNotice.parse(row["notice"]) else {
                XCTAssertEqual(expect, "malformed", name)
                continue
            }
            let refusal = SecurityNoticeVerifier.verify(n, authorityKeys: [authority])
            XCTAssertEqual(refusal?.rawValue, expect, name)
        }
    }

    func testUnsignableBodiesBreakTheFirstRuleTheSpecLists() throws {
        let v = try vectors()
        let signer = try authorityKey(v)
        let rows = try list(v, "unsignable")
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let body = try XCTUnwrap(SecurityNotice.body(fromJSON: try XCTUnwrap(row["body"] as? [String: Any])), name)
            XCTAssertThrowsError(try SecurityNoticeRules.canonical(body, signedBy: signer), name) { error in
                XCTAssertEqual((error as? SecurityNoticeError)?.code, row["code"] as? String, name)
            }
        }
    }

    func testOutcomesForAClientAtAClock() throws {
        let v = try vectors()
        let rows = try list(v, "outcomes")
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let n = try XCTUnwrap(SecurityNotice.parse(row["notice"]), name)
            let c = try XCTUnwrap(row["client"] as? [String: Any], name)
            let client = SecurityNoticeClient(
                platform: try XCTUnwrap(c["platform"] as? String),
                build: (c["build"] as! NSNumber).int64Value,
                protocolLevel: (c["protocol"] as! NSNumber).int64Value
            )
            let now = (row["now"] as! NSNumber).int64Value
            let got = SecurityNoticeVerifier.outcome(n, client: client, nowMs: now)
            let expect = try XCTUnwrap(row["expect"] as? [String: Any], name)
            switch got {
            case let .none(why):
                XCTAssertEqual(expect["action"] as? String, "none", name)
                XCTAssertEqual(expect["why"] as? String, why, name)
            case let .banner(style, notice):
                XCTAssertEqual(expect["action"] as? String, "banner", name)
                XCTAssertEqual(expect["style"] as? String, style.rawValue, name)
                XCTAssertEqual(notice, n, name)
            case let .lock(notice):
                XCTAssertEqual(expect["action"] as? String, "lock", name)
                XCTAssertEqual(notice, n, name)
            }
        }
    }

    func testAcceptKeepsAntiRollbackAndFailsOpen() throws {
        let v = try vectors()
        let rows = try list(v, "accept")
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let s = try XCTUnwrap(row["store"] as? [String: Any], name)
            let start = SecurityNoticeVerifier.Store(
                highestSeq: (s["highestSeq"] as! NSNumber).int64Value,
                notice: SecurityNotice.parse(s["notice"])
            )
            let keys = try XCTUnwrap(row["authorityKeys"] as? [String], name)
            let result = SecurityNoticeVerifier.accept(start, candidate: row["candidate"], authorityKeys: keys)
            let expect = try XCTUnwrap(row["expect"] as? [String: Any], name)
            XCTAssertEqual(result.store.highestSeq, (expect["highestSeq"] as! NSNumber).int64Value, name)
            XCTAssertEqual(result.refused?.rawValue, expect["refused"] as? String, name)
            if let seq = expect["seq"] as? NSNumber {
                XCTAssertEqual(result.store.notice?.seq, seq.int64Value, name)
            } else {
                XCTAssertNil(result.store.notice, name)
            }
        }
    }

    /// The webapp pins this to the TypeScript constant too: a build speaks one
    /// protocol level everywhere.
    func testProtocolLevelEqualsTheTypeScriptConstant() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/src/securityNotice.ts")
            if let src = try? String(contentsOf: url, encoding: .utf8) {
                let range = try XCTUnwrap(src.range(of: #"CLIENT_PROTOCOL_LEVEL = (\d+);"#, options: .regularExpression))
                let digits = src[range].filter(\.isNumber)
                XCTAssertEqual(Int64(digits), clientProtocolLevel)
                return
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("securityNotice.ts not found above \(#filePath)")
    }
}
