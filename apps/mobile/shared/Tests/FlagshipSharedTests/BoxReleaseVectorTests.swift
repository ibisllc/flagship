import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift "Release this box" order (ReleaseThisBox) to packages/protocol/test-vectors/box-release/.
final class BoxReleaseVectorTests: XCTestCase {
    private func load() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/box-release/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("box-release vectors not found above \(#filePath)")
    }

    private func order(_ v: Any?) -> ReleaseThisBox.Order {
        let o = v as! [String: Any]
        return ReleaseThisBox.Order(serverDomain: o["serverDomain"] as! String, stkPubHex: o["stkPubHex"] as! String,
                                issuedAt: (o["issuedAt"] as! NSNumber).int64Value, nonceHex: o["nonceHex"] as! String)
    }

    private func h(_ v: Any?) -> [UInt8] { PqBin.unhex((v as? String) ?? "") ?? [] }

    func testCanonicalBytesAndSignature() throws {
        let v = try load()
        let keys = v["keys"] as! [String: Any]
        let o = v["order"] as! [String: Any]
        let ord = order(o["fields"])
        XCTAssertEqual(String(decoding: try ReleaseThisBox.canonicalBytes(ord), as: UTF8.self), o["canonical"] as? String)
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(h(keys["adminRootSeedHex"])))
        XCTAssertEqual(PqBin.hex([UInt8](admin.publicKey.rawRepresentation)), keys["adminRootPubHex"] as? String)
        XCTAssertTrue(ReleaseThisBox.verify(ord, signatureHex: o["signatureHex"] as! String, adminRootPub: Data(h(keys["adminRootPubHex"]))))
        XCTAssertTrue(ReleaseThisBox.verify(ord, signatureHex: try ReleaseThisBox.sign(ord, adminRoot: admin), adminRootPub: admin.publicKey.rawRepresentation))
        for r in v["reject"] as! [[String: Any]] {
            XCTAssertFalse(ReleaseThisBox.verify(order(r["fields"]), signatureHex: r["signatureHex"] as! String, adminRootPub: Data(h(r["verifyUnder"]))), r["why"] as! String)
        }
    }

    func testHybridSignature() throws {
        let v = try load()
        let keys = v["keys"] as! [String: Any]
        let hy = v["hybrid"] as! [String: Any]
        let ord = order((v["order"] as! [String: Any])["fields"])
        let seed = h(keys["adminRootSeedHex"])
        let (pub, sk) = try PqHybrid.hybridSigKeygen(edSeed: seed, mldsaSeed: h(hy["adminRootMldsaSeedHex"]))
        XCTAssertEqual(PqBin.hex(pub), hy["adminRootHybridPubHex"] as? String)
        let wire = hy["pqSignature"] as! [String: Any]
        XCTAssertEqual(wire["suite"] as? String, ReleaseThisBox.hybridSuite)
        let mine = try PqHybrid.hybridSign(secretKey: sk, purpose: ReleaseThisBox.tag, payload: [UInt8](ReleaseThisBox.canonicalBytes(ord)), deterministic: true)
        // CryptoKit's Ed25519 signs hedged, so only the ML-DSA half is byte-identical; both verify.
        XCTAssertEqual(PqBin.hex(Array(mine[64...])), String((wire["signature"] as! String).dropFirst(128)))
        XCTAssertTrue(ReleaseThisBox.verifyHybrid(ord, signatureHex: PqBin.hex(mine), hybridPub: pub))
        XCTAssertTrue(ReleaseThisBox.verifyHybrid(ord, signatureHex: wire["signature"] as! String, hybridPub: pub))
        for r in hy["reject"] as! [[String: Any]] {
            XCTAssertFalse(ReleaseThisBox.verifyHybrid(ord, signatureHex: r["signatureHex"] as! String, hybridPub: h(r["verifyUnder"])), r["why"] as! String)
        }
    }

    func testRefusesBadShapes() throws {
        let v = try load()
        for r in v["refuse"] as! [[String: Any]] {
            let f = r["fields"] as! [String: Any]
            let t = (f["issuedAt"] as! NSNumber).doubleValue
            let o = ReleaseThisBox.Order(serverDomain: f["serverDomain"] as! String, stkPubHex: f["stkPubHex"] as! String,
                                         issuedAt: t == t.rounded() ? Int64(t) : 0, nonceHex: f["nonceHex"] as! String)
            XCTAssertNotNil(ReleaseThisBox.problem(o), r["why"] as! String)
        }
    }
}
