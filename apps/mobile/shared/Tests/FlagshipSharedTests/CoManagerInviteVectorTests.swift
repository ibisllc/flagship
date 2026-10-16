import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins co-manager invites to `packages/protocol/test-vectors/co-manager-invite/vectors.json`:
/// the member and bundle keys, the sealed names, the create / revoke canonical
/// strings and signatures under the member key, and the reject cases.
final class CoManagerInviteVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/co-manager-invite/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func keys() throws -> [String: String] { try XCTUnwrap(try vectors()["keys"] as? [String: String]) }
    private func hex(_ s: String?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s))) }

    private func request(_ f: [String: Any]) throws -> ShareInviteCreateRequest {
        ShareInviteCreateRequest(
            inviteId: try XCTUnwrap(f["inviteId"] as? String), authorAID: try XCTUnwrap(f["authorAID"] as? String),
            serviceRef: try XCTUnwrap(f["serviceRef"] as? String), secretHash: try XCTUnwrap(f["secretHash"] as? String),
            encryptedBundle: try XCTUnwrap(f["encryptedBundle"] as? String),
            issuedAt: try XCTUnwrap((f["issuedAt"] as? NSNumber)?.int64Value),
            maxRedemptions: (f["maxRedemptions"] as? NSNumber)?.intValue,
            expiresAt: (f["expiresAt"] as? NSNumber)?.int64Value)
    }

    func test_keys() throws {
        let k = try keys()
        let umk = try hex(k["memberUmkSeedHex"])
        let member = try ServerShare.deriveShareMemberKey(umkSeed: umk, shareId: k["shareId"]!)
        XCTAssertEqual(HexUtil.encode(member.publicKey.rawRepresentation), k["memberPubHex"])
        let other = try ServerShare.deriveShareMemberKey(umkSeed: umk, shareId: k["otherShareId"]!)
        XCTAssertEqual(HexUtil.encode(other.publicKey.rawRepresentation), k["otherMemberPubHex"])
        let bundle = try ServerShare.deriveShareInviteBundleKey(umkSeed: umk, shareId: k["shareId"]!)
        XCTAssertEqual(HexUtil.encode(bundle), k["bundleKeyHex"])
        XCTAssertEqual(k["bundleKeyInfo"], "\(ServerShare.infoInviteBundle)|\(k["shareId"]!)")
    }

    func test_bundles_sealAndOpen() throws {
        let key = try hex(try keys()["bundleKeyHex"])
        let bundles = try XCTUnwrap(try vectors()["bundles"] as? [[String: Any]])
        XCTAssertEqual(bundles.count, 2)
        for b in bundles {
            let inviteId = try XCTUnwrap(b["inviteId"] as? String)
            let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(b["plaintext"] as? String).utf8)) as? [String: String])
            let sealed = try ServiceInvite.sealBundle(.init(name: try XCTUnwrap(plain["name"])), householdKey: key,
                                                      inviteId: inviteId, nonce: try hex(b["nonceHex"] as? String))
            XCTAssertEqual(sealed, b["sealedHex"] as? String)
            let opened = try ServiceInvite.openBundle(sealed, householdKey: key, inviteId: inviteId)
            XCTAssertEqual(opened.name, plain["name"])
            XCTAssertThrowsError(try ServiceInvite.openBundle(sealed, householdKey: key, inviteId: String(repeating: "0", count: 64)))
        }
    }

    func test_creates_canonicalAndSignature() throws {
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(try keys()["memberPubHex"]))
        let creates = try XCTUnwrap(try vectors()["creates"] as? [[String: Any]])
        XCTAssertEqual(creates.count, 2)
        for c in creates {
            let req = try request(try XCTUnwrap(c["fields"] as? [String: Any]))
            let bytes = try req.canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(try hex(c["signatureHex"] as? String), for: bytes))
        }
    }

    func test_revoke_canonicalAndSignature() throws {
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(try keys()["memberPubHex"]))
        let r = try XCTUnwrap(try vectors()["revoke"] as? [String: Any])
        let f = try XCTUnwrap(r["fields"] as? [String: Any])
        let revoke = ShareInviteRevoke(inviteId: try XCTUnwrap(f["inviteId"] as? String),
                                       issuedAt: try XCTUnwrap((f["issuedAt"] as? NSNumber)?.int64Value))
        let bytes = try revoke.canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), r["canonical"] as? String)
        XCTAssertTrue(pub.isValidSignature(try hex(r["signatureHex"] as? String), for: bytes))
    }

    func test_ourSignatureVerifiesUnderTheMemberKey() throws {
        let k = try keys()
        let member = try ServerShare.deriveShareMemberKey(umkSeed: try hex(k["memberUmkSeedHex"]), shareId: k["shareId"]!)
        let c = try XCTUnwrap((try vectors()["creates"] as? [[String: Any]])?.first)
        let bytes = try request(try XCTUnwrap(c["fields"] as? [String: Any])).canonicalBytes()
        let sig = try member.signature(for: bytes)
        XCTAssertTrue(member.publicKey.isValidSignature(sig, for: bytes))
    }

    func test_rejects_fail() throws {
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(try keys()["memberPubHex"]))
        let rejects = try XCTUnwrap(try vectors()["reject"] as? [[String: Any]])
        let creates = rejects.filter { $0["envelope"] as? String == "create" }
        XCTAssertEqual(creates.count, 2)
        for r in creates {
            let bytes = try request(try XCTUnwrap(r["fields"] as? [String: Any])).canonicalBytes()
            XCTAssertFalse(pub.isValidSignature(try hex(r["signatureHex"] as? String), for: bytes), "\(r["why"] ?? "")")
        }
    }

    func test_relay_canonicalUnderTheStk() throws {
        let k = try keys()
        let stk = try Curve25519.Signing.PublicKey(rawRepresentation: try hex(k["stkPubHex"]))
        let r = try XCTUnwrap(try vectors()["relay"] as? [String: Any])
        let f = try XCTUnwrap(r["fields"] as? [String: Any])
        let parts = ["username", "serverDomain", "inviteId", "serviceRef", "creatorPubHex", "createSigHex"].map { f[$0] as? String ?? "" }
        let canonical = (["flagship/service-invite-co-manager/v1"] + parts + [String((f["issuedAt"] as? NSNumber)?.int64Value ?? 0)])
            .joined(separator: "|")
        XCTAssertEqual(canonical, r["canonical"] as? String)
        XCTAssertTrue(stk.isValidSignature(try hex(r["signatureHex"] as? String), for: Data(canonical.utf8)))
        let bad = try XCTUnwrap((try vectors()["reject"] as? [[String: Any]])?.first { $0["envelope"] as? String == "relay" })
        XCTAssertFalse(stk.isValidSignature(try hex(bad["signatureHex"] as? String), for: Data(canonical.utf8)))
    }
}
