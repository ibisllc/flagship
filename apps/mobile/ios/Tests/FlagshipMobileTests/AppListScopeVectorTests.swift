import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// `flagship/app-list-scope/v1` (a separate access list on each server, Pro)
/// against THE reference, packages/protocol/test-vectors/app-list-scope/
/// vectors.json (loaded from disk, never transcribed).
final class AppListScopeVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-list-scope/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func order(_ c: [String: Any]) -> AppListScopeOrder {
        AppListScopeOrder(serviceRef: c["serviceRef"] as! String, scope: c["scope"] as! String,
                          issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
    }

    func test_casesMatchCanonicalBytesAndSignature() throws {
        let v = try vectors()
        let seed = try XCTUnwrap(HexUtil.decode(v["signerSeedHex"] as! String))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["signerPub"] as? String)
        let cases = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let bytes = try order(c).canonicalBytes()
            XCTAssertEqual(String(data: bytes, encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: bytes), c["canonical"] as? String ?? "")
            XCTAssertTrue(key.publicKey.isValidSignature(try key.signature(for: bytes), for: bytes))
        }
    }

    func test_rejectsAreRefused() throws {
        let v = try vectors()
        let rejects = try XCTUnwrap(v["rejects"] as? [[String: Any]])
        XCTAssertFalse(rejects.isEmpty)
        for c in rejects {
            XCTAssertThrowsError(try order(c).canonicalBytes(), c["why"] as? String ?? "")
        }
    }

    func test_requestEncodesTheOrderTheBoxParses() throws {
        let o = AppListScopeOrder(serviceRef: "harry--chess-club", separate: true, issuedAt: 1_760_000_000_000)
        let data = try JSONEncoder().encode(AppListScopeRequest(order: o, signature: String(repeating: "ab", count: 64)))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let wire = try XCTUnwrap(obj["order"] as? [String: Any])
        XCTAssertEqual(wire["serviceRef"] as? String, "harry--chess-club")
        XCTAssertEqual(wire["scope"] as? String, "server")
        XCTAssertEqual((wire["issuedAt"] as? NSNumber)?.int64Value, 1_760_000_000_000)
        XCTAssertNil(wire["serverId"], "the order names the app, never a server")
        XCTAssertEqual((obj["signature"] as? String)?.count, 128)
    }

    func test_stateAndSummaryDecodeTheBoxWire() throws {
        let json = #"""
        {"ok":true,"serviceRef":"harry--chess-club","scope":"server","pending":false,"plan":"pro",
         "self":"Home.Harry.Flagship.Services","leader":"home.harry.flagship.services",
         "servers":["home.harry.flagship.services","office.harry.flagship.services","HOME.harry.flagship.services"]}
        """#
        let s = try JSONDecoder().decode(AppListScopeState.self, from: Data(json.utf8))
        XCTAssertTrue(s.isSeparate)
        XCTAssertTrue(s.isPro)
        XCTAssertEqual(s.selfFqdn, "home.harry.flagship.services")
        XCTAssertEqual(s.servers, ["home.harry.flagship.services", "office.harry.flagship.services"])
        let odd = try JSONDecoder().decode(AppListScopeState.self, from: Data(#"{"scope":"weird","plan":"gold"}"#.utf8))
        XCTAssertEqual(odd.scope, "account")
        XCTAssertEqual(odd.plan, "unknown")
        XCTAssertFalse(odd.pending)

        let sum = try JSONDecoder().decode(
            AccessListsSummary.self,
            from: Data(#"{"plan":"pro","separateApps":2,"leaders":["Home.h.flagship.services","home.h.flagship.services"]}"#.utf8))
        XCTAssertEqual(sum.separateApps, 2)
        XCTAssertEqual(sum.leaders, ["home.h.flagship.services"])
    }
}
