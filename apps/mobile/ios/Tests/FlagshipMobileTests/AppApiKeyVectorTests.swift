import XCTest
import CryptoKit
@testable import FlagshipAPI
import FlagshipCore

/// The iOS API-key grant against THE reference,
/// `packages/protocol/test-vectors/app-api-key/vectors.json`, loaded from disk
/// (never transcribed) so a divergence surfaces here, not as a box refusing
/// what the phone signed.
final class AppApiKeyVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-api-key/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func test_canonicalBytesAndPinnedSignatures() throws {
        let v = try vectors()
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        let all = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let keyId = try XCTUnwrap(c["keyId"] as? String)
            XCTAssertTrue(AppApiKeyId.isValid(keyId))
            let grant = AppApiKeyGrant(
                serverDomain: c["serverDomain"] as! String, serviceId: c["serviceId"] as! String, keyId: keyId,
                scope: try XCTUnwrap(AppApiKeyScope(rawValue: c["scope"] as! String)),
                expiresAt: (c["expiresAt"] as! NSNumber).int64Value, issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
            XCTAssertEqual(String(data: grant.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: grant.canonicalBytes()))
            // CryptoKit's signatures are randomized: ours differs but verifies.
            let mine = try key.signature(for: grant.canonicalBytes())
            XCTAssertTrue(key.publicKey.isValidSignature(mine, for: grant.canonicalBytes()))
            // Every field is bound: change any one and the pinned signature fails.
            let tampered = [
                AppApiKeyGrant(serverDomain: "other.harry.flagship.services", serviceId: grant.serviceId, keyId: grant.keyId,
                               scope: grant.scope, expiresAt: grant.expiresAt, issuedAt: grant.issuedAt),
                AppApiKeyGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId + "x", keyId: grant.keyId,
                               scope: grant.scope, expiresAt: grant.expiresAt, issuedAt: grant.issuedAt),
                AppApiKeyGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId, keyId: "fedcba9876543210",
                               scope: grant.scope, expiresAt: grant.expiresAt, issuedAt: grant.issuedAt),
                AppApiKeyGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId, keyId: grant.keyId,
                               scope: grant.scope == .read ? .write : .read, expiresAt: grant.expiresAt, issuedAt: grant.issuedAt),
                AppApiKeyGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId, keyId: grant.keyId,
                               scope: grant.scope, expiresAt: grant.expiresAt + 1, issuedAt: grant.issuedAt),
                AppApiKeyGrant(serverDomain: grant.serverDomain, serviceId: grant.serviceId, keyId: grant.keyId,
                               scope: grant.scope, expiresAt: grant.expiresAt, issuedAt: grant.issuedAt + 1),
            ]
            for t in tampered {
                XCTAssertFalse(key.publicKey.isValidSignature(pinned, for: t.canonicalBytes()),
                               String(data: t.canonicalBytes(), encoding: .utf8) ?? "")
            }
        }
    }

    func test_keyIdIsSixteenLowercaseHex() {
        for _ in 0..<50 {
            let id = AppApiKeyId.random()
            XCTAssertTrue(AppApiKeyId.isValid(id), id)
        }
        XCTAssertNotEqual(AppApiKeyId.random(), AppApiKeyId.random())
        XCTAssertFalse(AppApiKeyId.isValid("0123456789ABCDEF"))
        XCTAssertFalse(AppApiKeyId.isValid("0123456789abcde"))
        XCTAssertFalse(AppApiKeyId.isValid("0123456789abcdefa"))
        XCTAssertFalse(AppApiKeyId.isValid("0123456789abcdeg"))
    }

    func test_scopeLabels() {
        XCTAssertEqual(AppApiKeyScope.read.label, "Read")
        XCTAssertEqual(AppApiKeyScope.write.label, "Read & write")
        let g = AppApiKeyGrant(serverDomain: "a", serviceId: "b", keyId: "0123456789abcdef", scope: .read, issuedAt: 5)
        XCTAssertEqual(g.expiresAt, 0)
    }

    func test_wireShapes() throws {
        let grant = AppApiKeyGrant(serverDomain: "home.harry.flagship.services", serviceId: "harry-weather",
                                   keyId: "0123456789abcdef", scope: .read, expiresAt: 0, issuedAt: 1_700_000_000_000)
        let body = AppApiKeyCreateRequest(grant: grant, signature: String(repeating: "ab", count: 64), label: "Sensor")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), ["grant", "signature", "label"])
        XCTAssertEqual(obj["label"] as? String, "Sensor")
        let g = try XCTUnwrap(obj["grant"] as? [String: Any])
        XCTAssertEqual(Set(g.keys), ["serverDomain", "serviceId", "keyId", "scope", "expiresAt", "issuedAt"])
        XCTAssertEqual(g["scope"] as? String, "read")
        XCTAssertEqual((g["expiresAt"] as? NSNumber)?.int64Value, 0)
        XCTAssertEqual((g["issuedAt"] as? NSNumber)?.int64Value, 1_700_000_000_000)

        let list = try JSONDecoder().decode(AppApiKeysResponse.self, from: Data(#"""
        {"keys":[
          {"keyId":"0123456789abcdef","label":"Sensor","scope":"write","createdAt":1700000000000,"lastUsedAt":null,"expiresAt":0},
          {"keyId":"fedcba9876543210","label":"Board","scope":"read","createdAt":1700000000000,"lastUsedAt":1700000500000,"expiresAt":1707776000000},
          {"keyId":"00000000000000aa","label":"Old","scope":"read","createdAt":1}
        ]}
        """#.utf8))
        XCTAssertEqual(list.keys.count, 3)
        XCTAssertNil(list.keys[0].lastUsedAt)
        XCTAssertNil(list.keys[0].expiresAt)
        XCTAssertEqual(list.keys[1].lastUsedAt, 1_700_000_500_000)
        XCTAssertEqual(list.keys[1].expiresAt, 1_707_776_000_000)
        XCTAssertTrue(list.keys[1].isExpired(now: Date(timeIntervalSince1970: 1_707_776_000)))
        XCTAssertFalse(list.keys[0].isExpired())
        XCTAssertNil(list.keys[2].expiresAt)
        let created = try JSONDecoder().decode(AppApiKeyCreateResponse.self, from: Data(
            #"{"ok":true,"key":"fsk_0123456789abcdef_s3cret"}"#.utf8))
        XCTAssertEqual(created.key, "fsk_0123456789abcdef_s3cret")
    }
}
