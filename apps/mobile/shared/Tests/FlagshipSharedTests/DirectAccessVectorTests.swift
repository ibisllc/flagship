import XCTest
import CryptoKit
@testable import FlagshipAPI

/// Pins `DirectAccess` to `packages/protocol/test-vectors/direct-access/vectors.json`.
final class DirectAccessVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/direct-access/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(LanHint.hexDecode(try XCTUnwrap(s as? String))) }
    private func int(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }
    private func str(_ d: Data) -> String { String(decoding: d, as: UTF8.self) }

    private func order(_ f: [String: Any]) -> DirectAccess.Order {
        DirectAccess.Order(
            serverDomain: f["serverDomain"] as! String, enabled: f["enabled"] as! Bool,
            addresses: f["addresses"] as! [String], prefixes: f["prefixes"] as! [String],
            port: Int(int(f["port"])), issuedAt: int(f["issuedAt"])
        )
    }

    private func endpoints(_ v: Any?) -> [LanHint.Endpoint] {
        (v as! [[String: Any]]).map { LanHint.Endpoint(address: $0["address"] as! String, port: Int(int($0["port"]))) }
    }

    private func hint(_ f: [String: Any]) -> DirectAccess.HintV2 {
        DirectAccess.HintV2(
            serverDomain: f["serverDomain"] as! String, certSha256: f["certSha256"] as! String,
            lan: endpoints(f["lan"]), direct: endpoints(f["direct"]), orderSha256: f["orderSha256"] as! String,
            issuedAt: int(f["issuedAt"]), expiresAt: int(f["expiresAt"])
        )
    }

    func test_addressesAndPrefixes() throws {
        let v = try vectors()
        let a = try XCTUnwrap(v["addresses"] as? [String: Any])
        for c in a["canonical"] as! [[String: Any]] {
            XCTAssertEqual(DirectAccess.canonicalIp(c["input"] as! String), c["canonical"] as? String, c["input"] as! String)
        }
        for p in a["public"] as! [String] { XCTAssertTrue(DirectAccess.isPublicAddress(p), p) }
        for p in a["notPublic"] as! [String] { XCTAssertFalse(DirectAccess.isPublicAddress(p), p) }
        let pr = try XCTUnwrap(v["prefixes"] as? [String: Any])
        for c in pr["valid"] as! [[String: Any]] {
            let p = try XCTUnwrap(DirectAccess.parsePrefix(c["input"] as! String))
            XCTAssertEqual(DirectAccess.formatPrefix(p), c["canonical"] as? String)
        }
        for s in pr["invalid"] as! [String] { XCTAssertNil(DirectAccess.parsePrefix(s), s) }
        for c in pr["contains"] as! [[String: Any]] {
            let p = try XCTUnwrap(DirectAccess.parsePrefix(c["prefix"] as! String))
            XCTAssertEqual(DirectAccess.prefixContains(p, c["address"] as! String), c["inside"] as? Bool)
        }
    }

    func test_orderBytesHashAndSignatures() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let adminPub = try hex(keys["adminRootPubHex"])
        let irkPub = try hex(keys["irkPubHex"])
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(keys["adminRootSeedHex"]))
        let ov = try XCTUnwrap(v["order"] as? [String: Any])
        let o = order(ov["fields"] as! [String: Any])
        XCTAssertEqual(str(DirectAccess.canonical(o)), ov["canonical"] as? String)
        XCTAssertEqual(DirectAccess.orderSha256(o), ov["sha256"] as? String)
        let pinned = ov["signatureHex"] as! String
        XCTAssertTrue(DirectAccess.verify(o, signatureHex: pinned, pub: adminPub))
        XCTAssertFalse(DirectAccess.verify(o, signatureHex: pinned, pub: irkPub))
        XCTAssertTrue(DirectAccess.verify(DirectAccess.SignedOrder(order: o, signatureHex: pinned), authorityPubs: [irkPub, adminPub]))
        XCTAssertTrue(DirectAccess.verify(o, signatureHex: try DirectAccess.sign(o, key: admin), pub: adminPub))
        let off = ov["off"] as! [String: Any]
        let offOrder = order(off["fields"] as! [String: Any])
        XCTAssertEqual(str(DirectAccess.canonical(offOrder)), off["canonical"] as? String)
        XCTAssertTrue(DirectAccess.verify(offOrder, signatureHex: off["signatureHex"] as! String, pub: adminPub))
        for r in ov["refused"] as! [[String: Any]] {
            let bad = order(r["fields"] as! [String: Any])
            XCTAssertEqual(DirectAccess.problem(bad), r["problem"] as? String, r["name"] as! String)
            XCTAssertThrowsError(try DirectAccess.sign(bad, key: admin))
            let forced = try admin.signature(for: DirectAccess.canonical(bad)).map { String(format: "%02x", $0) }.joined()
            XCTAssertFalse(DirectAccess.verify(bad, signatureHex: forced, pub: adminPub), r["name"] as! String)
        }
    }

    func test_addressUpdates() throws {
        let v = try vectors()
        let stkPub = try hex((v["keys"] as! [String: Any])["stkPubHex"])
        let main = order((v["order"] as! [String: Any])["fields"] as! [String: Any])
        let av = try XCTUnwrap(v["addressUpdate"] as? [String: Any])
        func update(_ f: [String: Any]) -> DirectAccess.AddressUpdate {
            DirectAccess.AddressUpdate(serverDomain: f["serverDomain"] as! String, orderSha256: f["orderSha256"] as! String,
                                       addresses: f["addresses"] as! [String], port: Int(int(f["port"])), issuedAt: int(f["issuedAt"]))
        }
        XCTAssertEqual(str(DirectAccess.canonical(update(av["fields"] as! [String: Any]))), av["canonical"] as? String)
        for c in av["cases"] as! [[String: Any]] {
            let ord = (c["order"] as? [String: Any]).map(order) ?? main
            let why = DirectAccess.reject(update(c["fields"] as! [String: Any]), signature: try hex(c["signatureHex"]), stkPub: stkPub,
                                          order: ord, serverDomain: main.serverDomain, nowMs: int(av["now"]))
            XCTAssertEqual(why, c["reason"] as? String, c["name"] as! String)
        }
    }

    func test_hintV2() throws {
        let v = try vectors()
        let stkPub = try hex((v["keys"] as! [String: Any])["stkPubHex"])
        let main = order((v["order"] as! [String: Any])["fields"] as! [String: Any])
        let hv = try XCTUnwrap(v["hintV2"] as? [String: Any])
        let base = hint(hv["fields"] as! [String: Any])
        XCTAssertEqual(str(DirectAccess.canonical(base)), hv["canonical"] as? String)
        for c in hv["cases"] as! [[String: Any]] {
            let withOrder = c["withOrder"] as! Bool
            let ord = withOrder ? ((c["order"] as? [String: Any]).map(order) ?? main) : nil
            let got = DirectAccess.check(hint(c["fields"] as! [String: Any]), signature: try hex(c["signatureHex"]), stkPub: stkPub,
                                         serverDomain: base.serverDomain, certSha256: base.certSha256, nowMs: int(hv["now"]), order: ord)
            if let reason = c["reason"] as? String {
                XCTAssertEqual(got, .refused(reason), c["name"] as! String)
            } else {
                XCTAssertEqual(got, .accepted(useDirect: c["useDirect"] as! Bool), c["name"] as! String)
            }
        }
    }
}
