import XCTest
import CryptoKit
@testable import FlagshipCore

final class ChatApprovalTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/chat-approval/vectors.json")
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

    private func order(_ o: [String: Any]) -> ChatApproval {
        ChatApproval(
            serverDomain: o["serverDomain"] as! String, requestId: o["requestId"] as! String,
            kind: ChatApproval.Kind(rawValue: o["kind"] as! String) ?? .incoming,
            decision: ChatApproval.Decision(rawValue: o["decision"] as! String) ?? .allow,
            issuedAt: (o["issuedAt"] as! NSNumber).int64Value)
    }

    func testCanonicalBytesAndSignaturesMatchTheSharedVector() throws {
        let v = try vectors()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v["pubHex"] as! String))
        for entry in v["orders"] as! [[String: Any]] {
            let bytes = try order(entry["order"] as! [String: Any]).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), entry["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(entry["signatureHex"] as! String), for: bytes))
        }
    }

    func testMalformedOrdersAreRefused() throws {
        let v = try vectors()
        for entry in v["refused"] as! [[String: Any]] {
            let o = entry["order"] as! [String: Any]
            let kind = ChatApproval.Kind(rawValue: o["kind"] as! String)
            let decision = ChatApproval.Decision(rawValue: o["decision"] as! String)
            if kind == nil || decision == nil { continue } // an unknown word cannot be built at all
            XCTAssertThrowsError(try order(o).canonicalBytes(), entry["name"] as? String ?? "")
        }
    }
}
