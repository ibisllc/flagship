import XCTest
import CryptoKit
@testable import FlagshipAPI

final class RecoveryRecordV2Tests: XCTestCase {
    private func vectorData() throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/recovery-record/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) { return try Data(contentsOf: url) }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private struct Vectors: Decodable {
        let userSeedHex: String
        let userPubHex: String
        let record: RecoveryRecordV2
        let canonical: String
        let signatureHex: String
        let digestHex: String
        let mutationsThatBreakTheSignature: [Mutation]
        struct Mutation: Decodable { let field: String }
    }

    private func key(_ v: Vectors) throws -> Curve25519.Signing.PrivateKey {
        try Curve25519.Signing.PrivateKey(rawRepresentation: RecoveryRecordV2.unhex(v.userSeedHex)!)
    }

    func testCanonicalBytesDigestAndSignatureMatchTheSharedVector() throws {
        let v = try JSONDecoder().decode(Vectors.self, from: vectorData())
        XCTAssertEqual(String(decoding: try v.record.canonicalBytes(), as: UTF8.self), v.canonical)
        XCTAssertEqual(try v.record.digestHex(), v.digestHex)
        let pub = try key(v).publicKey
        XCTAssertEqual(pub.rawRepresentation.map { String(format: "%02x", $0) }.joined(), v.userPubHex)
        XCTAssertTrue(v.record.verify(signatureHex: v.signatureHex, publicKey: pub))
        // Ours verifies too (signatures are randomized in CryptoKit, so verify rather than compare).
        XCTAssertTrue(v.record.verify(signatureHex: try v.record.sign(with: key(v)), publicKey: pub))
    }

    func testEveryOneFieldChangeBreaksTheSignature() throws {
        let v = try JSONDecoder().decode(Vectors.self, from: vectorData())
        let pub = try key(v).publicKey
        var changed: [String: RecoveryRecordV2] = [:]
        var r = v.record
        r.op = "delete"; changed["op"] = r
        r = v.record; r.username = "bob"; changed["username"] = r
        r = v.record; r.credentialIdHex = "c0ffee00c0ffee01"; changed["credentialIdHex"] = r
        r = v.record; r.wrappedUmkDigestHex = String(repeating: "5", count: 64); changed["wrappedUmkDigestHex"] = r
        r = v.record; r.adminRoot = .replace(digestHex: String(repeating: "6", count: 64)); changed["adminRoot"] = r
        r = v.record; r.acmeKey = .replace(digestHex: String(repeating: "7", count: 64)); changed["acmeKey"] = r
        r = v.record; r.fetchTokenHashHex = String(repeating: "8", count: 64); changed["fetchTokenHashHex"] = r
        r = v.record; r.prfSaltHashHex = String(repeating: "9", count: 64); changed["prfSaltHashHex"] = r
        r = v.record; r.generation = 2; changed["generation"] = r
        r = v.record; r.nonceHex = String(repeating: "10", count: 16); changed["nonceHex"] = r
        r = v.record; r.priorDigestHex = "legacy"; changed["priorDigestHex"] = r
        r = v.record; r.issuedAt += 1; changed["issuedAt"] = r
        for m in v.mutationsThatBreakTheSignature where changed[m.field] != nil {
            XCTAssertFalse(changed[m.field]!.verify(signatureHex: v.signatureHex, publicKey: pub), m.field)
        }
        XCTAssertGreaterThanOrEqual(changed.count, 12)
    }

    func testUnknownVersionsAndMalformedFieldsCannotBeSigned() throws {
        let v = try JSONDecoder().decode(Vectors.self, from: vectorData())
        var bad: [RecoveryRecordV2] = []
        for mutate in [
            { (r: inout RecoveryRecordV2) in r.kdfVersion = 2 }, { $0.algVersion = 9 }, { $0.policy = "anything" },
            { $0.generation = 0 }, { $0.nonceHex = "00" }, { $0.priorDigestHex = "later" },
            { $0.generation = 2; $0.priorDigestHex = "genesis" }, { $0.username = "a|b" }, { $0.issuedAt = -1 },
            { $0.adminRoot = .keep(digestHex: "xyz") },
        ] as [(inout RecoveryRecordV2) -> Void] {
            var r = v.record; mutate(&r); bad.append(r)
        }
        for r in bad { XCTAssertThrowsError(try r.canonicalBytes()) }
    }

    func testChainBuilderSaysKeepReplaceOrNoneExplicitly() throws {
        let h64 = String(repeating: "e", count: 64)
        let umk = Data([1, 2, 3]).base64EncodedString()
        let first = try RecoveryRecordChain.next(
            username: "Alice", irkPubHex: h64, adminRootPubHex: nil, current: nil, credentialIdHex: "c0ffee00c0ffee00",
            wrappedUmk: umk, wrappedAdminRoot: nil, wrappedAcmeAccountKey: nil,
            fetchTokenHashHex: h64, prfSaltHashHex: h64, issuedAt: 1)
        XCTAssertEqual(first.generation, 1); XCTAssertEqual(first.priorDigestHex, "genesis")
        XCTAssertEqual(first.adminRoot, .none); XCTAssertEqual(first.acmeKey, .none)
        let state = RecoveryRecordState(credentialId: "c0ffee00c0ffee00", wrappedUmkHash: h64, legacy: false, generation: 1, digestHex: try first.digestHex(), adminRootDigestHex: h64)
        let second = try RecoveryRecordChain.next(
            username: "Alice", irkPubHex: h64, adminRootPubHex: nil, current: state, credentialIdHex: "c0ffee00c0ffee00",
            wrappedUmk: umk, wrappedAdminRoot: nil, wrappedAcmeAccountKey: nil,
            fetchTokenHashHex: h64, prfSaltHashHex: h64, issuedAt: 2)
        XCTAssertEqual(second.generation, 2); XCTAssertEqual(second.priorDigestHex, try first.digestHex())
        XCTAssertEqual(second.adminRoot, .keep(digestHex: h64))
        let legacy = RecoveryRecordState(credentialId: "c0ffee00c0ffee00", wrappedUmkHash: h64, legacy: true)
        let upgrade = try RecoveryRecordChain.next(
            username: "Alice", irkPubHex: h64, adminRootPubHex: nil, current: legacy, credentialIdHex: "c0ffee00c0ffee00",
            wrappedUmk: umk, wrappedAdminRoot: Data([9]).base64EncodedString(), wrappedAcmeAccountKey: nil,
            fetchTokenHashHex: h64, prfSaltHashHex: h64, issuedAt: 3)
        XCTAssertEqual(upgrade.generation, 1); XCTAssertEqual(upgrade.priorDigestHex, "legacy")
        if case .replace = upgrade.adminRoot {} else { XCTFail("expected replace") }
    }

    func testCiphertextMismatchIsFoundBeforeAnythingIsUnwrapped() throws {
        let h64 = String(repeating: "e", count: 64)
        let umk = Data([1, 2, 3]).base64EncodedString()
        let admin = Data([4, 5]).base64EncodedString()
        let claim = try RecoveryRecordChain.next(
            username: "a", irkPubHex: h64, adminRootPubHex: nil, current: nil, credentialIdHex: "c0ffee00c0ffee00",
            wrappedUmk: umk, wrappedAdminRoot: admin, wrappedAcmeAccountKey: nil,
            fetchTokenHashHex: h64, prfSaltHashHex: h64, issuedAt: 1)
        XCTAssertNil(claim.ciphertextMismatch(wrappedUmk: umk, wrappedAdminRoot: admin, wrappedAcmeAccountKey: nil))
        XCTAssertEqual(claim.ciphertextMismatch(wrappedUmk: Data([9]).base64EncodedString(), wrappedAdminRoot: admin, wrappedAcmeAccountKey: nil), "wrappedUmk")
        XCTAssertEqual(claim.ciphertextMismatch(wrappedUmk: umk, wrappedAdminRoot: Data([9]).base64EncodedString(), wrappedAcmeAccountKey: nil), "wrappedAdminRoot")
        XCTAssertEqual(claim.ciphertextMismatch(wrappedUmk: umk, wrappedAdminRoot: nil, wrappedAcmeAccountKey: nil), "wrappedAdminRoot")
        XCTAssertEqual(claim.ciphertextMismatch(wrappedUmk: umk, wrappedAdminRoot: admin, wrappedAcmeAccountKey: Data([7]).base64EncodedString()), "wrappedAcmeAccountKey")
    }
}
