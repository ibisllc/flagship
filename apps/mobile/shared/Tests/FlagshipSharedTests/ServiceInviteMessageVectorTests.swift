import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the app invite messages to `packages/protocol/test-vectors/service-invite/vectors.json`:
/// the create / redeem / accept / revoke canonical strings, the TypeScript signer's signatures
/// over them, the secret hash and the refusals. CryptoKit's Ed25519 signs with fresh randomness,
/// so a signature is checked by verifying it, not by comparing bytes.
final class ServiceInviteMessageVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/service-invite/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }
    private func int64(_ v: Any?) throws -> Int64 { try XCTUnwrap((v as? NSNumber)?.int64Value) }
    private func cases(_ key: String) throws -> [[String: Any]] { try XCTUnwrap(try vectors()[key] as? [[String: Any]]) }
    private func pub(_ name: String) throws -> Data {
        let keys = try XCTUnwrap(try vectors()["keys"] as? [String: [String: Any]])
        return try hex(keys[name]?["pub"])
    }
    private func seedKey(_ name: String) throws -> Curve25519.Signing.PrivateKey {
        let keys = try XCTUnwrap(try vectors()["keys"] as? [String: [String: Any]])
        let byte = try XCTUnwrap((keys[name]?["seedByte"] as? NSNumber)?.uint8Value)
        return try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: byte, count: 32))
    }

    private func create(_ c: [String: Any]) throws -> Data {
        try ServiceInvite.canonicalCreate(
            inviteId: try XCTUnwrap(c["inviteId"] as? String), authorAID: try hex(c["authorAID"]),
            serviceRef: try XCTUnwrap(c["serviceRef"] as? String), secretHash: try XCTUnwrap(c["secretHash"] as? String),
            encryptedBundle: try XCTUnwrap(c["encryptedBundle"] as? String), issuedAt: try int64(c["issuedAt"]),
            maxRedemptions: (c["maxRedemptions"] as? NSNumber)?.intValue,
            expiresAt: (c["expiresAt"] as? NSNumber)?.int64Value)
    }

    func test_keys() throws {
        for name in ["irk", "friend", "contact"] {
            XCTAssertEqual(try seedKey(name).publicKey.rawRepresentation, try pub(name), name)
        }
    }

    func test_create() throws {
        let irk = try pub("irk"), friend = try pub("friend")
        for c in try cases("create") {
            let bytes = try create(c)
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c["canonical"] as? String, c["name"] as? String ?? "")
            XCTAssertTrue(ServiceInvite.verify(try hex(c["signature"]), bytes, pub: irk))
            XCTAssertFalse(ServiceInvite.verify(try hex(c["signature"]), bytes, pub: friend))
            let mine = try ServiceInvite.sign(bytes, with: try seedKey("irk"))
            XCTAssertTrue(ServiceInvite.verify(mine, bytes, pub: irk))
        }
    }

    func test_redeemAcceptRevoke() throws {
        for r in try cases("redeem") {
            let bytes = try ServiceInvite.canonicalRedeem(
                secretHash: try XCTUnwrap(r["secretHash"] as? String), visitorAID: try hex(r["visitorAID"]), redeemedAt: try int64(r["redeemedAt"]))
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), r["canonical"] as? String)
            XCTAssertTrue(ServiceInvite.verify(try hex(r["signature"]), bytes, pub: try pub("friend")))
        }
        for a in try cases("accept") {
            let bytes = try ServiceInvite.canonicalAccept(
                inviteId: try XCTUnwrap(a["inviteId"] as? String), serviceRef: try XCTUnwrap(a["serviceRef"] as? String),
                contactAID: try hex(a["contactAID"]), acceptedAt: try int64(a["acceptedAt"]))
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), a["canonical"] as? String)
            XCTAssertTrue(ServiceInvite.verify(try hex(a["signature"]), bytes, pub: try pub("contact")))
        }
        for r in try cases("revoke") {
            let bytes = try ServiceInvite.canonicalRevoke(inviteId: try XCTUnwrap(r["inviteId"] as? String), issuedAt: try int64(r["issuedAt"]))
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), r["canonical"] as? String)
            XCTAssertTrue(ServiceInvite.verify(try hex(r["signature"]), bytes, pub: try pub("irk")))
        }
    }

    func test_secretHash() throws {
        for s in try cases("secretHash") {
            XCTAssertEqual(ServiceInvite.secretHash(secret: try hex(s["secretHex"])), s["expect"] as? String)
        }
    }

    func test_invalid() throws {
        for c in try cases("invalid") {
            let name = c["name"] as? String ?? ""
            if c["op"] as? String == "create" {
                // A fractional expiry has no Int64 form: the API can't be handed one at all.
                if let e = c["expiresAt"] as? NSNumber, e.doubleValue != e.doubleValue.rounded() { continue }
                XCTAssertThrowsError(try create(c), name)
            } else {
                XCTAssertThrowsError(try ServiceInvite.canonicalRedeem(
                    secretHash: try XCTUnwrap(c["secretHash"] as? String), visitorAID: try hex(c["visitorAID"]),
                    redeemedAt: try int64(c["redeemedAt"])), name)
            }
        }
    }
}
