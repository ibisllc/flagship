import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins `DebugAccess` to `packages/protocol/test-vectors/debug-access/vectors.json`.
/// CryptoKit's Ed25519 signatures are randomized, so the pinned signatures are
/// checked by verifying them, and our own by verifying them too.
final class DebugAccessVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/debug-access/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }
    private func int(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }

    private func grant(_ f: [String: Any]) -> DebugAccess.Grant {
        DebugAccess.Grant(
            serverDomain: f["serverDomain"] as! String,
            sshPublicKey: f["sshPublicKey"] as! String,
            issuedAt: int(f["issuedAt"]),
            expiresAt: int(f["expiresAt"])
        )
    }

    func test_normalizesAndFingerprintsKeys() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["sshKeys"] as? [String: Any])
        for k in try XCTUnwrap(keys["accept"] as? [[String: Any]]) {
            let input = k["input"] as! String
            XCTAssertEqual(DebugAccess.normalizeSshPublicKey(input), k["normalized"] as? String)
            XCTAssertEqual(DebugAccess.fingerprint(input), k["fingerprint"] as? String)
        }
        for r in try XCTUnwrap(keys["reject"] as? [String]) {
            XCTAssertNil(DebugAccess.normalizeSshPublicKey(r), r)
        }
    }

    func test_grantAndRevokeBytesAndSignatures() throws {
        let v = try vectors()
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(keys["adminRootSeedHex"]))
        let adminPub = try hex(keys["adminRootPubHex"])
        let irkPub = try hex(keys["irkPubHex"])
        XCTAssertEqual(admin.publicKey.rawRepresentation, adminPub)

        let gv = try XCTUnwrap(v["grant"] as? [String: Any])
        let g = grant(try XCTUnwrap(gv["fields"] as? [String: Any]))
        XCTAssertEqual(String(data: try DebugAccess.canonicalBytes(g), encoding: .utf8), gv["canonical"] as? String)
        let pinned = try XCTUnwrap(gv["signatureHex"] as? String)
        XCTAssertTrue(DebugAccess.verify(g, signatureHex: pinned, pub: adminPub))
        XCTAssertFalse(DebugAccess.verify(g, signatureHex: pinned, pub: irkPub))
        let reject = try XCTUnwrap((gv["reject"] as? [String: Any])?["signatureHex"] as? String)
        XCTAssertFalse(DebugAccess.verify(g, signatureHex: reject, pub: adminPub))
        XCTAssertTrue(DebugAccess.verify(g, signatureHex: try DebugAccess.sign(g, key: admin), pub: adminPub))

        let rv = try XCTUnwrap(v["revoke"] as? [String: Any])
        let rf = try XCTUnwrap(rv["fields"] as? [String: Any])
        let r = DebugAccess.Revoke(serverDomain: rf["serverDomain"] as! String, issuedAt: int(rf["issuedAt"]))
        XCTAssertEqual(String(data: try DebugAccess.canonicalBytes(r), encoding: .utf8), rv["canonical"] as? String)
        XCTAssertTrue(DebugAccess.verify(r, signatureHex: try XCTUnwrap(rv["signatureHex"] as? String), pub: adminPub))
        let rreject = try XCTUnwrap((rv["reject"] as? [String: Any])?["signatureHex"] as? String)
        XCTAssertFalse(DebugAccess.verify(r, signatureHex: rreject, pub: adminPub))
        XCTAssertTrue(DebugAccess.verify(r, signatureHex: try DebugAccess.sign(r, key: admin), pub: adminPub))
        // A grant signature is not a revoke signature.
        XCTAssertFalse(DebugAccess.verify(DebugAccess.Revoke(serverDomain: g.serverDomain, issuedAt: g.issuedAt), signatureHex: pinned, pub: adminPub))
    }

    func test_refusesEveryRefuseCaseBeforeSigning() throws {
        let v = try vectors()
        let admin = Curve25519.Signing.PrivateKey()
        for r in try XCTUnwrap(v["refuse"] as? [[String: Any]]) {
            let g = grant(try XCTUnwrap(r["fields"] as? [String: Any]))
            XCTAssertNotNil(DebugAccess.grantProblem(g), r["why"] as? String ?? "")
            XCTAssertThrowsError(try DebugAccess.sign(g, key: admin), r["why"] as? String ?? "")
        }
    }

    func test_limitsMatch() throws {
        let limits = try XCTUnwrap(try vectors()["limits"] as? [String: Any])
        XCTAssertEqual(int(limits["defaultMs"]), DebugAccess.defaultMs)
        XCTAssertEqual(int(limits["maxMs"]), DebugAccess.maxMs)
        XCTAssertEqual(DebugAccess.Duration.allCases.map(\.ms), [DebugAccess.hourMs, DebugAccess.defaultMs, DebugAccess.maxMs])
    }

    func test_makeGrantSaysWhy() {
        XCTAssertThrowsError(try DebugAccess.makeGrant(serverDomain: "a.b", rawKey: "  ", issuedAt: 1, duration: 1)) {
            XCTAssertEqual($0.localizedDescription, "Debug access needs an SSH public key.")
        }
        XCTAssertThrowsError(try DebugAccess.makeGrant(serverDomain: "a.b", rawKey: "hello", issuedAt: 1, duration: 1)) {
            XCTAssertEqual($0.localizedDescription, "That isn't an SSH public key this server can use.")
        }
    }
}
