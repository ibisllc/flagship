import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipCore

/// Swift parity for the sealed directory/profile-key delivery. Loads the SAME
/// `test-vectors/directory-key-delivery.json` the TS and web tests load and
/// asserts the OPEN direction byte-for-byte: each fixed sealed grant verifies
/// under the pinned admin-root pub and unseals with the pinned recipient seed
/// to the pinned key. Plus a negative matrix — every case must fail closed.
final class AccountDirectoryKeyGrantTests: XCTestCase {

    private struct Vector {
        let name: String
        let grant: AccountDirectoryKeyGrant
        let signature: Data
        let expectedKeyHex: String
    }
    private struct Loaded {
        let recipientSeed: Data
        let adminRootPub: Data
        let vectors: [Vector]
    }

    private func locateFixture() -> URL? {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir
                .appendingPathComponent("test-vectors")
                .appendingPathComponent("directory-key-delivery.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    private func load() throws -> Loaded {
        guard let url = locateFixture() else {
            XCTFail("could not locate test-vectors/directory-key-delivery.json from \(#filePath)")
            throw NSError(domain: "fixture", code: 1)
        }
        let root = try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as! [String: Any]
        let vectors = (root["vectors"] as! [[String: Any]]).map { v -> Vector in
            let g = v["grant"] as! [String: Any]
            let grant = AccountDirectoryKeyGrant(
                accountId: g["accountId"] as! String,
                recipientDeviceId: g["recipientDeviceId"] as! String,
                keyKind: AccountDirectoryKeyGrant.KeyKind(rawValue: g["keyKind"] as! String)!,
                sealedKeyHex: g["sealedKeyHex"] as! String,
                issuedAt: (g["issuedAt"] as! NSNumber).int64Value,
                expiresAt: (g["expiresAt"] as! NSNumber).int64Value,
                signerPubHex: g["signerPubHex"] as! String
            )
            return Vector(
                name: v["name"] as! String,
                grant: grant,
                signature: HexUtil.decode(v["signatureHex"] as! String)!,
                expectedKeyHex: v["expectedKeyHex"] as! String
            )
        }
        return Loaded(
            recipientSeed: HexUtil.decode(root["recipientSeedHex"] as! String)!,
            adminRootPub: HexUtil.decode(root["adminRootPubHex"] as! String)!,
            vectors: vectors
        )
    }

    func testOpensSharedGoldenVectorsToTheExactKey() throws {
        let loaded = try load()
        XCTAssertGreaterThan(loaded.vectors.count, 0)
        for v in loaded.vectors {
            let key = AccountDirectoryKeyDelivery.open(
                grant: v.grant,
                signature: v.signature,
                adminRootPub: loaded.adminRootPub,
                expectedAccountId: v.grant.accountId,
                expectedRecipientDeviceId: v.grant.recipientDeviceId,
                recipientDeviceSeed: loaded.recipientSeed
            )
            XCTAssertNotNil(key, "vector \(v.name) must open")
            XCTAssertEqual(HexUtil.encode(key!), v.expectedKeyHex, "vector \(v.name) key mismatch")
        }
    }

    func testCanonicalBytesMatchTheWireLayout() throws {
        let v = try load().vectors[0]
        let bytes = try v.grant.canonicalBytes()
        let expected = [
            "flagship/account-directory-key-grant/v1",
            v.grant.accountId.lowercased(),
            v.grant.recipientDeviceId,
            v.grant.keyKind.rawValue,
            v.grant.sealedKeyHex,
            String(v.grant.issuedAt),
            String(v.grant.expiresAt),
            v.grant.signerPubHex,
        ].joined(separator: "|")
        XCTAssertEqual(String(data: bytes, encoding: .utf8), expected)
    }

    // MARK: negative matrix — each must return nil.

    private func openWith(
        _ loaded: Loaded,
        adminRootPub: Data? = nil,
        expectedAccountId: String? = nil,
        expectedRecipientDeviceId: String? = nil,
        recipientDeviceSeed: Data? = nil,
        grant: AccountDirectoryKeyGrant? = nil,
        now: Int64? = nil
    ) -> Data? {
        let v = loaded.vectors[0]
        return AccountDirectoryKeyDelivery.open(
            grant: grant ?? v.grant,
            signature: v.signature,
            adminRootPub: adminRootPub ?? loaded.adminRootPub,
            expectedAccountId: expectedAccountId ?? v.grant.accountId,
            expectedRecipientDeviceId: expectedRecipientDeviceId ?? v.grant.recipientDeviceId,
            recipientDeviceSeed: recipientDeviceSeed ?? loaded.recipientSeed,
            now: now
        )
    }

    func testRejectsWrongRecipientSeed() throws {
        let loaded = try load()
        XCTAssertNil(openWith(loaded, recipientDeviceSeed: Data(repeating: 0x0d, count: 32)))
    }

    func testRejectsMismatchedDeviceId() throws {
        let loaded = try load()
        XCTAssertNil(openWith(loaded, expectedRecipientDeviceId: "ffeeddccbbaa99887766554433221100"))
    }

    func testRejectsMismatchedAccount() throws {
        let loaded = try load()
        XCTAssertNil(openWith(loaded, expectedAccountId: "someone-else"))
    }

    func testRejectsForgedAdminRoot() throws {
        let loaded = try load()
        let impostor = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x99, count: 32))
        XCTAssertNil(openWith(loaded, adminRootPub: impostor.publicKey.rawRepresentation))
    }

    func testRejectsTamperedSealedKey() throws {
        let loaded = try load()
        let g = loaded.vectors[0].grant
        var chars = Array(g.sealedKeyHex)
        chars[chars.count - 1] = chars[chars.count - 1] == "0" ? "1" : "0"
        let tampered = AccountDirectoryKeyGrant(
            accountId: g.accountId, recipientDeviceId: g.recipientDeviceId, keyKind: g.keyKind,
            sealedKeyHex: String(chars), issuedAt: g.issuedAt, expiresAt: g.expiresAt, signerPubHex: g.signerPubHex
        )
        XCTAssertNil(openWith(loaded, grant: tampered))
    }

    func testRejectsExpiredGrant() throws {
        let loaded = try load()
        XCTAssertNil(openWith(loaded, now: loaded.vectors[0].grant.expiresAt + 1))
    }
}
