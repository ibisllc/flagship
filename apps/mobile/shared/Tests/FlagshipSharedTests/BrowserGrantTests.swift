import XCTest
import CryptoKit
@testable import FlagshipCore

final class BrowserGrantTests: XCTestCase {
    private func vectors(_ name: String = "browser-grant") throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/\(name)/vectors.json")
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

    private func answer(_ a: [String: Any]) -> BrowserGrantAnswer {
        let lan: BrowserGrantAnswer.LocalNetwork
        if let l = a["localNetwork"] as? [String: Any] {
            lan = (l["kind"] as? String) == "whole-lan" ? .wholeLan : .exact(l["hosts"] as? [String] ?? [])
        } else { lan = .none }
        return BrowserGrantAnswer(serverDomain: a["serverDomain"] as! String, requestId: a["requestId"] as! String,
                                  serviceId: a["serviceId"] as! String, decision: a["decision"] as! String,
                                  duration: a["duration"] as! String, capabilities: a["capabilities"] as! [String],
                                  origins: a["origins"] as! [String], localNetwork: lan,
                                  issuedAt: (a["issuedAt"] as! NSNumber).int64Value)
    }

    func testCanonicalBytesAndSignaturesMatchTheSharedVector() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v["pubHex"] as! String))
        for e in v["answers"] as! [[String: Any]] {
            let bytes = try answer(e["answer"] as! [String: Any]).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), e["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(e["signatureHex"] as! String), for: bytes))
        }
        for e in v["refused"] as! [[String: Any]] {
            XCTAssertThrowsError(try answer(e["answer"] as! [String: Any]).canonicalBytes(), e["name"] as? String ?? "")
        }
    }

    private func lan(_ v: Any?) -> BrowserGrantAnswer.LocalNetwork {
        guard let l = v as? [String: Any] else { return .none }
        return (l["kind"] as? String) == "whole-lan" ? .wholeLan : .exact(l["hosts"] as? [String] ?? [])
    }

    private func scope(_ a: [String: Any]) -> BrowserGrantAnswer.Scope {
        BrowserGrantAnswer.Scope(duration: a["duration"] as! String, capabilities: a["capabilities"] as! [String],
                                 origins: a["origins"] as! [String], localNetwork: lan(a["localNetwork"]))
    }

    func testNarrowingAndChoicesMatchTheSharedVector() throws {
        let v = try vectors()
        let narrowing = v["narrowing"] as! [[String: Any]]
        XCTAssertFalse(narrowing.isEmpty)
        for n in narrowing {
            XCTAssertEqual(BrowserGrantAnswer.within(ask: scope(n["ask"] as! [String: Any]), answer: scope(n["answer"] as! [String: Any])),
                           n["within"] as? Bool, n["name"] as? String ?? "")
        }
        for c in v["choices"] as! [[String: Any]] {
            XCTAssertEqual(BrowserGrantAnswer.durationChoices(asked: c["asked"] as! String), c["choices"] as? [String])
        }
        XCTAssertEqual(BrowserGrantAnswer.durationChoices(asked: "forever"), [])
    }

    func testRevokeCanonicalBytesAndSignaturesMatchTheSharedVector() throws {
        // packages/protocol/test-vectors/browser-grant-revoke/vectors.json
        let v = try vectors("browser-grant-revoke")
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v["pubHex"] as! String))
        func revoke(_ r: [String: Any]) -> BrowserGrantRevoke {
            BrowserGrantRevoke(serverDomain: r["serverDomain"] as! String, serviceId: r["serviceId"] as! String,
                               grantId: r["grantId"] as! String, issuedAt: (r["issuedAt"] as! NSNumber).int64Value)
        }
        let revokes = v["revokes"] as! [[String: Any]]
        XCTAssertFalse(revokes.isEmpty)
        for e in revokes {
            let bytes = try revoke(e["revoke"] as! [String: Any]).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), e["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(e["signatureHex"] as! String), for: bytes))
        }
        for e in v["refused"] as! [[String: Any]] {
            XCTAssertThrowsError(try revoke(e["revoke"] as! [String: Any]).canonicalBytes(), e["name"] as? String ?? "")
        }
    }
}
