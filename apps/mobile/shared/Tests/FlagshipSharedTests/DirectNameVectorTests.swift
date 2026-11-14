import XCTest
import CryptoKit
@testable import FlagshipAPI

/// Pins `DirectName` to `packages/protocol/test-vectors/direct-name/vectors.json`.
final class DirectNameVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/direct-name/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(LanHint.hexDecode(try XCTUnwrap(s as? String))) }

    private func order(_ f: [String: Any]) -> DirectName.Order? {
        guard let caa = DirectName.Caa(rawValue: f["caa"] as! String) else { return nil }
        return DirectName.Order(
            name: f["name"] as! String, serverDomain: f["serverDomain"] as! String, enabled: f["enabled"] as! Bool,
            addresses: f["addresses"] as! [String], caa: caa, issuedAt: (f["issuedAt"] as! NSNumber).int64Value
        )
    }

    func test_ordersVerifyUnderTheAdminRootOnly() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let adminPub = try hex(keys["adminRootPubHex"])
        let irkPub = try hex(keys["irkPubHex"])
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(keys["adminRootSeedHex"]))
        for name in ["follow", "owned", "off"] {
            let c = try XCTUnwrap(v[name] as? [String: Any])
            let o = try XCTUnwrap(order(c["fields"] as! [String: Any]))
            XCTAssertEqual(String(decoding: DirectName.canonical(o), as: UTF8.self), c["canonical"] as? String, name)
            let pinned = c["signatureHex"] as! String
            XCTAssertTrue(DirectName.verify(o, signatureHex: pinned, pub: adminPub), name)
            XCTAssertFalse(DirectName.verify(o, signatureHex: pinned, pub: irkPub), name)
            XCTAssertTrue(DirectName.verify(o, signatureHex: try DirectName.sign(o, key: admin), pub: adminPub), name)
        }
    }

    func test_refusedOrders() throws {
        let v = try vectors()
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex((v["keys"] as! [String: Any])["adminRootSeedHex"]))
        let adminPub = admin.publicKey.rawRepresentation
        for r in v["refused"] as! [[String: Any]] {
            let label = r["name"] as! String
            let problem = r["problem"] as! String
            guard let bad = order(r["fields"] as! [String: Any]) else {
                XCTAssertEqual(problem, "bad-caa", label)
                continue
            }
            XCTAssertEqual(DirectName.problem(bad), problem, label)
            XCTAssertThrowsError(try DirectName.sign(bad, key: admin), label)
            let forced = try admin.signature(for: DirectName.canonical(bad)).map { String(format: "%02x", $0) }.joined()
            XCTAssertFalse(DirectName.verify(bad, signatureHex: forced, pub: adminPub), label)
        }
    }

    func test_labelKinds() throws {
        let v = try vectors()
        for k in v["kinds"] as! [[String: Any]] {
            let label = k["label"] as! String
            let got: String?
            switch DirectName.kind(label) {
            case .derived: got = "derived"
            case .vanity: got = "vanity"
            case nil: got = nil
            }
            XCTAssertEqual(got, k["kind"] as? String, label)
        }
        XCTAssertEqual(DirectName.derivedName(slug: "game", creator: "plucky-avocet"), "game--plucky-avocet.fshp.app")
        XCTAssertNil(DirectName.derivedName(slug: "game", creator: "x"))
    }
}
