import XCTest
import CryptoKit
@testable import FlagshipCore

/// The Swift half of packages/protocol/test-vectors/arch-v2-switch/vectors.json.
final class StackSwitchVectorTests: XCTestCase {
    private func load() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/arch-v2-switch/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("arch-v2-switch vectors not found above \(#filePath)")
    }

    private func order(_ o: [String: Any]) -> StackSwitchOrder {
        StackSwitchOrder(serverDomain: o["serverDomain"] as! String, target: o["target"] as! String,
                         nonce: o["nonce"] as! String, issuedAt: (o["issuedAt"] as! NSNumber).int64Value)
    }

    func testEveryCase() throws {
        let v = try load()
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: HexUtil.decode(v["signerHex"] as! String)!)
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x22, count: 32))
        for c in v["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            let bytes = try order(c["order"] as! [String: Any]).canonicalBytes()
            if let canon = c["canonical"] as? String { XCTAssertEqual(String(decoding: bytes, as: UTF8.self), canon, name) }
            XCTAssertEqual(pub.isValidSignature(HexUtil.decode(c["signature"] as! String)!, for: bytes), c["expect"] as? Bool, name)
            if c["expect"] as? Bool == true { XCTAssertTrue(pub.isValidSignature(try admin.signature(for: bytes), for: bytes), name) }
        }
        for r in v["refused"] as! [[String: Any]] {
            XCTAssertThrowsError(try order(r["order"] as! [String: Any]).canonicalBytes(), r["name"] as! String)
        }
    }

    func testBodyAndNonce() throws {
        let n = StackSwitchOrder.newNonce()
        XCTAssertEqual(n.count, 32)
        let o = StackSwitchOrder(serverDomain: "home.alice.flagship.services", target: "arch-v2", nonce: n, issuedAt: 1)
        XCTAssertNoThrow(try o.canonicalBytes())
        let b = o.body(signatureHex: "aa", dryRun: true)
        XCTAssertEqual(b["dryRun"] as? Bool, true)
        XCTAssertNil(o.body(signatureHex: "aa", dryRun: false)["dryRun"])
    }
}
