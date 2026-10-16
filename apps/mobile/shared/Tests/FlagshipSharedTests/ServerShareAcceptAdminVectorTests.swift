import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins envelope #12 (`flagship/server-share-accept-admin/v1`, only an admin
/// device of the joining account accepts a share) to
/// `packages/protocol/test-vectors/server-share-accept-admin/vectors.json`.
/// CryptoKit's Ed25519 signatures are randomized, so a pinned signature is
/// checked by verifying it, and our own signature by verifying it too.
final class ServerShareAcceptAdminVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-share-accept-admin/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func keys() throws -> [String: String] {
        try XCTUnwrap(try vectors()["keys"] as? [String: String])
    }

    private func cases(_ key: String) throws -> [[String: Any]] {
        try XCTUnwrap(try vectors()[key] as? [[String: Any]], "missing \(key)")
    }

    private func hex(_ s: String) throws -> Data { try XCTUnwrap(HexUtil.decode(s)) }

    private func signer(_ name: String) throws -> Curve25519.Signing.PrivateKey {
        let k = try keys()
        let umk = try hex(k["memberUmkSeedHex"]!)
        switch name {
        case "adminRoot": return try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(k["adminRootSeedHex"]!))
        case "otherAdmin": return try Curve25519.Signing.PrivateKey(rawRepresentation: try hex(k["otherAdminSeedHex"]!))
        case "irk":
            return try Curve25519.Signing.PrivateKey(rawRepresentation: try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk)))
        case "member": return try ServerShare.deriveShareMemberKey(umkSeed: umk, shareId: k["shareId"]!)
        default: throw XCTSkip("unknown signer \(name)")
        }
    }

    private func admit(_ fields: Any) throws -> ServerShareAcceptAdmin {
        try JSONDecoder().decode(ServerShareAcceptAdmin.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    func testKeys() throws {
        let k = try keys()
        XCTAssertEqual(HexUtil.encode(try signer("adminRoot").publicKey.rawRepresentation), k["adminRootPubHex"])
        XCTAssertEqual(HexUtil.encode(try signer("irk").publicKey.rawRepresentation), k["irkPubHex"])
        XCTAssertEqual(HexUtil.encode(try signer("member").publicKey.rawRepresentation), k["memberPubHex"])
    }

    func testEnvelopes() throws {
        let all = try cases("envelopes")
        XCTAssertEqual(all.count, 2)
        for c in all {
            let a = try admit(try XCTUnwrap(c["fields"]))
            XCTAssertEqual(String(data: try a.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let key = try signer(try XCTUnwrap(c["signer"] as? String))
            let pub = key.publicKey.rawRepresentation
            XCTAssertTrue(a.verify(signature: try hex(try XCTUnwrap(c["signature"] as? String)), publicKey: pub))
            let mine = try a.sign(with: key)
            XCTAssertTrue(a.verify(signature: mine, publicKey: pub))
            XCTAssertFalse(a.verify(signature: mine, publicKey: try signer("member").publicKey.rawRepresentation))
            XCTAssertEqual(ServerShareAcceptAdmin.parse(jsonObject: try XCTUnwrap(c["fields"])), a)
        }
    }

    func testRefuse() throws {
        let all = try cases("refuse")
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let why = c["why"] as? String ?? ""
            let fields = try XCTUnwrap(c["fields"])
            if let a = try? admit(fields) {
                XCTAssertThrowsError(try a.canonicalBytes(), why)
            }
            XCTAssertNil(ServerShareAcceptAdmin.parse(jsonObject: fields), why)
        }
    }

    func testReject() throws {
        for c in try cases("reject") {
            let a = try admit(try XCTUnwrap(c["fields"]))
            let pub = try signer(try XCTUnwrap(c["pub"] as? String)).publicKey.rawRepresentation
            XCTAssertFalse(a.verify(signature: try hex(try XCTUnwrap(c["signature"] as? String)), publicKey: pub), c["why"] as? String ?? "")
        }
    }

    func testPayloadKeepsTheAdminProof() throws {
        let raw = try XCTUnwrap(try vectors()["payload"] as? [String: Any])
        let p = try XCTUnwrap(ShareAcceptancePayload(jsonObject: raw))
        let proof = try XCTUnwrap(p.admin)
        XCTAssertEqual(proof.admit.keyKind, .adminRoot)
        XCTAssertEqual(proof.admit.keyPubHex, try keys()["adminRootPubHex"])
        XCTAssertEqual(proof.attestation.keyPubHex, try keys()["adminRootPubHex"])
        // The sealed form round-trips with the proof unchanged.
        let again = try XCTUnwrap(ShareAcceptancePayload(jsonObject: try JSONSerialization.jsonObject(with: p.jsonData())))
        XCTAssertEqual(again, p)
        let attestation = try XCTUnwrap((try vectors()["attestation"] as? [String: Any])?["attestation"])
        XCTAssertEqual(AccountKeyAttestation(jsonObject: attestation), proof.attestation)
        // Without a proof it still parses (an older app); a broken proof doesn't.
        var bare = raw
        bare.removeValue(forKey: "admin")
        XCTAssertNil(try XCTUnwrap(ShareAcceptancePayload(jsonObject: bare)).admin)
        var broken = raw
        broken["admin"] = ["admit": (raw["admin"] as? [String: Any])?["admit"] as Any, "signature": "ab", "attestation": attestation]
        XCTAssertNil(ShareAcceptancePayload(jsonObject: broken))
    }
}
