import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins `ServerShare` to `packages/protocol/test-vectors/server-share/vectors.json`.
/// CryptoKit's Ed25519 signatures are randomized, so a pinned signature is checked
/// by verifying it, and our own signature by verifying it too.
final class ServerShareVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/server-share/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func cases(_ key: String) throws -> [[String: Any]] {
        try XCTUnwrap(try vectors()[key] as? [[String: Any]], "missing \(key)")
    }

    private func keys() throws -> [String: String] {
        try XCTUnwrap(try vectors()["keys"] as? [String: String])
    }

    private func hex(_ s: String) throws -> Data { try XCTUnwrap(HexUtil.decode(s)) }

    private func ownerKey() throws -> Curve25519.Signing.PrivateKey {
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: try hex(try keys()["ownerUmkSeedHex"]!)))
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    private func memberKey() throws -> Curve25519.Signing.PrivateKey {
        let k = try keys()
        return try ServerShare.deriveShareMemberKey(umkSeed: try hex(k["memberUmkSeedHex"]!), shareId: k["shareId"]!)
    }

    private func inboxKey() throws -> Curve25519.Signing.PrivateKey {
        try ServerShare.deriveShareInboxKey(umkSeed: try hex(try keys()["memberUmkSeedHex"]!))
    }

    private func signer(_ name: String) throws -> Curve25519.Signing.PrivateKey {
        switch name {
        case "owner": return try ownerKey()
        case "member": return try memberKey()
        case "inbox": return try inboxKey()
        default: throw XCTSkip("unknown signer \(name)")
        }
    }

    /// Decode `fields` as the envelope `kind`; a decode failure is a refusal too.
    private func envelope(_ kind: String, _ fields: Any) throws -> any ServerShareEnvelope {
        let data = try JSONSerialization.data(withJSONObject: fields)
        let d = JSONDecoder()
        switch kind {
        case "grant": return try d.decode(ServerShareGrant.self, from: data)
        case "revoke": return try d.decode(ServerShareRevoke.self, from: data)
        case "accept": return try d.decode(ServerShareAccept.self, from: data)
        case "leave": return try d.decode(ServerShareLeave.self, from: data)
        case "session": return try d.decode(ServerShareSession.self, from: data)
        case "offer": return try d.decode(ServerShareOffer.self, from: data)
        case "list": return try d.decode(ServerShareList.self, from: data)
        case "unlock": return try d.decode(ServerShareUnlock.self, from: data)
        case "inbox": return try d.decode(ShareInboxRequest.self, from: data)
        default: throw ServerShareError.invalid("unknown kind \(kind)")
        }
    }

    private func parses(_ kind: String, _ fields: Any) -> Bool {
        switch kind {
        case "grant": return ServerShareGrant.parse(jsonObject: fields) != nil
        case "revoke": return ServerShareRevoke.parse(jsonObject: fields) != nil
        case "accept": return ServerShareAccept.parse(jsonObject: fields) != nil
        case "leave": return ServerShareLeave.parse(jsonObject: fields) != nil
        case "session": return ServerShareSession.parse(jsonObject: fields) != nil
        case "offer": return ServerShareOffer.parse(jsonObject: fields) != nil
        case "list": return ServerShareList.parse(jsonObject: fields) != nil
        case "unlock": return ServerShareUnlock.parse(jsonObject: fields) != nil
        case "inbox": return ShareInboxRequest.parse(jsonObject: fields) != nil
        default: return false
        }
    }

    func test_keys() throws {
        let k = try keys()
        let ownerSeed = try hex(k["ownerUmkSeedHex"]!)
        let memberSeed = try hex(k["memberUmkSeedHex"]!)
        let secret = try hex(k["secretHex"]!)

        XCTAssertEqual(HexUtil.encode(try ownerKey().publicKey.rawRepresentation), k["ownerSignerPub"])
        XCTAssertEqual(HexUtil.encode(try memberKey().publicKey.rawRepresentation), k["memberPubHex"])
        XCTAssertEqual(HexUtil.encode(try inboxKey().publicKey.rawRepresentation), k["inboxPubHex"])
        XCTAssertEqual(HexUtil.encode(try ServerShare.deriveShareInboxSealKey(umkSeed: memberSeed)), k["inboxSealKeyHex"])
        XCTAssertEqual(try ServerShare.shareTokenFromSecret(secret), k["token"])
        XCTAssertEqual(try ServerShare.shareTokenHash(k["token"]!), k["tokenHash"])
        XCTAssertEqual(HexUtil.encode(try ServerShare.shareLinkKey(secret)), k["linkKeyHex"])
        XCTAssertEqual(HexUtil.encode(try XCTUnwrap(ServiceInvite.deriveHouseholdKey(umkSeed: ownerSeed))), k["householdKeyHex"])
        let sas = try ServerShare.shareSas(shareId: k["shareId"]!, memberPubHex: k["memberPubHex"]!, secret: secret)
        XCTAssertEqual(sas, k["sas"])
        XCTAssertEqual(ServerShare.formatShareSas(sas), k["sasFormatted"])

        XCTAssertThrowsError(try ServerShare.shareTokenHash(k["token"]!.uppercased()))
        XCTAssertThrowsError(try ServerShare.shareLinkKey(secret.prefix(31)))
        XCTAssertThrowsError(try ServerShare.deriveShareMemberKey(umkSeed: memberSeed, shareId: k["shareId"]!.uppercased()))
    }

    func test_memberKeyDiffersPerShare() throws {
        let seed = try hex(try keys()["memberUmkSeedHex"]!)
        let a = try ServerShare.deriveShareMemberKey(umkSeed: seed, shareId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0")
        let b = try ServerShare.deriveShareMemberKey(umkSeed: seed, shareId: "0f1e2d3c4b5a69788796a5b4c3d2e1f1")
        XCTAssertNotEqual(a.publicKey.rawRepresentation, b.publicKey.rawRepresentation)
        XCTAssertNotEqual(a.publicKey.rawRepresentation, try ServerShare.deriveShareInboxKey(umkSeed: seed).publicKey.rawRepresentation)
    }

    func test_envelopes() throws {
        let all = try cases("envelopes")
        XCTAssertEqual(all.count, 13)
        for c in all {
            let kind = try XCTUnwrap(c["kind"] as? String)
            let fields = try XCTUnwrap(c["fields"])
            let env = try envelope(kind, fields)
            XCTAssertEqual(String(data: try env.canonicalBytes(), encoding: .utf8), c["canonical"] as? String, kind)
            XCTAssertTrue(parses(kind, fields), "parse \(kind)")

            let key = try signer(try XCTUnwrap(c["signer"] as? String))
            let pub = key.publicKey.rawRepresentation
            let pinned = try hex(try XCTUnwrap(c["signature"] as? String))
            XCTAssertTrue(env.verify(signature: pinned, publicKey: pub), "pinned \(kind)")
            XCTAssertTrue(env.verify(signature: try env.sign(with: key), publicKey: pub), "own \(kind)")
            XCTAssertTrue(env.verify(signature: try env.sign(using: { try key.signature(for: $0) }), publicKey: pub))
            let other = try hex(try keys()["otherSignerPub"]!)
            XCTAssertFalse(env.verify(signature: pinned, publicKey: other), "other \(kind)")
        }
    }

    func test_refuse() throws {
        let all = try cases("refuse")
        XCTAssertEqual(all.count, 18)
        for c in all {
            let kind = try XCTUnwrap(c["kind"] as? String)
            let fields = try XCTUnwrap(c["fields"])
            let why = c["why"] as? String ?? ""
            XCTAssertThrowsError(try envelope(kind, fields).canonicalBytes(), why)
            XCTAssertFalse(parses(kind, fields), why)
        }
    }

    func test_reject() throws {
        let all = try cases("reject")
        XCTAssertEqual(all.count, 7)
        for c in all {
            let kind = try XCTUnwrap(c["kind"] as? String)
            let env = try envelope(kind, try XCTUnwrap(c["fields"]))
            let pub = try signer(try XCTUnwrap(c["pub"] as? String)).publicKey.rawRepresentation
            let sig = try hex(try XCTUnwrap(c["signature"] as? String))
            XCTAssertNoThrow(try env.canonicalBytes())
            XCTAssertFalse(env.verify(signature: sig, publicKey: pub), c["why"] as? String ?? "")
        }
    }

    func test_sealed() throws {
        let all = try cases("sealed")
        XCTAssertEqual(all.count, 4)
        for c in all {
            let name = try XCTUnwrap(c["name"] as? String)
            let key = try hex(try XCTUnwrap(c["keyHex"] as? String))
            let aad = Data(try XCTUnwrap(c["aad"] as? String).utf8)
            let plaintext = Data(try XCTUnwrap(c["plaintext"] as? String).utf8)
            let nonce = try hex(try XCTUnwrap(c["nonceHex"] as? String))
            let sealed = try XCTUnwrap(c["sealed"] as? String)

            XCTAssertEqual(try ServerShare.seal(key: key, aad: aad, plaintext: plaintext, nonce: nonce), sealed, name)
            XCTAssertEqual(try ServerShare.open(key: key, aad: aad, sealedHex: sealed), plaintext, name)
            XCTAssertThrowsError(try ServerShare.open(key: key, aad: Data((c["aad"] as! String + "x").utf8), sealedHex: sealed))
            var flipped = Array(sealed)
            flipped[flipped.count - 1] = flipped.last == "0" ? "1" : "0"
            XCTAssertThrowsError(try ServerShare.open(key: key, aad: aad, sealedHex: String(flipped)))
            XCTAssertThrowsError(try ServerShare.open(key: key, aad: aad, sealedHex: sealed.uppercased()))

            let json = try ServerShare.openJSON(key: key, aad: aad, sealedHex: sealed)
            let id = String(try XCTUnwrap(c["aad"] as? String).split(separator: "|").last!)
            switch name {
            case "offer":
                XCTAssertEqual(try ServerShare.shareAad(ServerShare.aadOffer, id), aad)
                let p = try XCTUnwrap(ShareOfferPayload(jsonObject: json))
                XCTAssertEqual(p.jsonData(), plaintext)
            case "acceptance":
                XCTAssertEqual(try ServerShare.shareAad(ServerShare.aadAcceptance, id), aad)
                let p = try XCTUnwrap(ShareAcceptancePayload(jsonObject: json))
                XCTAssertEqual(p.jsonData(), plaintext)
                XCTAssertTrue(p.accept.verify(signature: try hex(p.signature), publicKey: try memberKey().publicKey.rawRepresentation))
            case "owner":
                XCTAssertEqual(try ServerShare.shareAad(ServerShare.aadOwner, id), aad)
                let p = try XCTUnwrap(ShareOwnerRecord(jsonObject: json))
                XCTAssertEqual(p.jsonData(), plaintext)
            case "inbox":
                XCTAssertEqual(try ServerShare.shareAad(ServerShare.aadInboxEntry, id), aad)
                let p = try XCTUnwrap(ShareInboxEntry(jsonObject: json))
                XCTAssertEqual(p.jsonData(), plaintext)
            default:
                XCTFail("unknown sealed case \(name)")
            }
        }
        XCTAssertThrowsError(try ServerShare.shareAad(ServerShare.aadOffer, "a|b"))
    }

    func test_payloadParsersRefuseBadShapes() throws {
        XCTAssertNil(ShareOfferPayload(jsonObject: ["v": true, "serverDomain": "d", "serverName": "n",
                                                    "stkPubHex": String(repeating: "cd", count: 32), "level": "view",
                                                    "unlockAtBoot": false, "seeAppData": false, "expiresAt": 1]))
        XCTAssertNil(ShareOwnerRecord(jsonObject: ["v": 1, "secretHex": String(repeating: "ab", count: 32), "label": "a|b",
                                                   "level": "view", "unlockAtBoot": 1, "seeAppData": false]))
        XCTAssertNil(ShareInboxEntry(jsonObject: ["v": 1, "shareId": "x", "secretHex": String(repeating: "ab", count: 32),
                                                  "serverDomain": "d", "serverName": "n", "acceptedAt": -1]))
    }

    func test_links() throws {
        let links = try XCTUnwrap(try vectors()["links"] as? [String: Any])
        let build = try XCTUnwrap(links["build"] as? [String: String])
        let secret = try hex(build["secretHex"]!)
        XCTAssertEqual(try ServerShare.buildShareLink(apexOrigin: build["apex"]!, shareId: build["shareId"]!, secret: secret), build["link"])
        XCTAssertEqual(try ServerShare.buildShareLink(apexOrigin: build["apex"]! + "//", shareId: build["shareId"]!, secret: secret), build["link"])

        let parse = try XCTUnwrap(links["parse"] as? [[String: Any]])
        XCTAssertEqual(parse.count, 9)
        for c in parse {
            let input = try XCTUnwrap(c["in"] as? String)
            let got = ServerShare.parseShareLink(input)
            if let out = c["out"] as? [String: String] {
                XCTAssertEqual(got, ServerShare.LinkParts(shareId: out["shareId"]!, secretHex: out["secretHex"]!), input)
            } else {
                XCTAssertNil(got, input)
            }
        }
    }

    func test_randomShareId() {
        let a = ServerShare.randomShareId()
        XCTAssertTrue(ServerShare.isLowerHex(a, 32))
        XCTAssertNotEqual(a, ServerShare.randomShareId())
    }
}
