import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins `ServerOrder` to `packages/protocol/test-vectors/server-order/vectors.json`.
/// CryptoKit's Ed25519 signatures are randomized, so the pinned signature is
/// checked by verifying it, and our own by verifying it too.
final class ServerOrderVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-order/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    private func order(_ f: [String: Any]) -> ServerOrder {
        ServerOrder(
            user: f["user"] as! String,
            stks: f["stks"] as! [String],
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
            nonce: f["nonce"] as! String
        )
    }

    private func irk(_ v: [String: Any]) throws -> Curve25519.Signing.PrivateKey {
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: try hex(keys["umkSeedHex"])))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), keys["irkPubHex"] as? String)
        return key
    }

    func testReproducesTheCanonicalStringAndVerifiesThePinnedSignature() throws {
        let v = try vectors()
        let key = try irk(v)
        let o = try XCTUnwrap(v["order"] as? [String: Any])
        let order = order(try XCTUnwrap(o["fields"] as? [String: Any]))
        XCTAssertEqual(String(decoding: try order.canonicalBytes(), as: UTF8.self), o["canonical"] as? String)
        XCTAssertTrue(order.verify(signatureHex: o["signatureHex"] as! String, publicKey: key.publicKey))
        let reject = try XCTUnwrap(o["reject"] as? [String: Any])
        XCTAssertFalse(order.verify(signatureHex: reject["signatureHex"] as! String, publicKey: key.publicKey))
        XCTAssertTrue(order.verify(signatureHex: try order.sign(with: key), publicKey: key.publicKey))
    }

    func testRefusesEveryRefuseCase() throws {
        for r in try XCTUnwrap(try vectors()["refuse"] as? [[String: Any]]) {
            XCTAssertThrowsError(try order(r["fields"] as! [String: Any]).canonicalBytes(), r["why"] as? String ?? "")
        }
    }

    func testDecodesTheWireForm() throws {
        let o = try XCTUnwrap(try vectors()["order"] as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(o["wire"]))
        let wire = try JSONDecoder().decode(SignedServerOrderWire.self, from: data)
        XCTAssertEqual(wire.order.stks, (o["fields"] as! [String: Any])["stks"] as? [String])
        XCTAssertEqual(wire.signature, o["signatureHex"] as? String)
    }

    func testMakeNormalizesAndDropsJunk() {
        let a = String(repeating: "ab", count: 32)
        let order = ServerOrder.make(user: "Plucky", stks: [a.uppercased(), a, "nope"], now: 5, nonce: Data(repeating: 1, count: 32))
        XCTAssertEqual(order.user, "plucky")
        XCTAssertEqual(order.stks, [a])
        XCTAssertNoThrow(try order.canonicalBytes())
    }
}
