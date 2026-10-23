import XCTest
import CryptoKit
@testable import FlagshipCore

final class BrowserGrantTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/browser-grant/vectors.json")
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
}
