import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins the Swift port of the serving authority (docs/architecture-v2/serving-wiring.md section 4) to
/// `packages/protocol/test-vectors/serving-authority/vectors.json`: the records an app signs (policy,
/// renewal-key delegation, lease) reproduce the canonical bytes and verify, and the P-256 lease
/// signature rules (compact, low-S) match the TypeScript reference.
final class ServingAuthorityVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/serving-authority/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ obj: Any?) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(obj)))
    }

    private func rows(_ kind: String) throws -> [[String: Any]] {
        let all = try XCTUnwrap(try vectors()["records"] as? [[String: Any]])
        return all.filter { $0["kind"] as? String == kind }
    }

    func testPoliciesReproduceCanonicalBytesAndVerify() throws {
        let rows = try rows("serving-policy")
        XCTAssertEqual(rows.count, 3)
        for row in rows {
            let p = try decode(ServingPolicy.self, row["record"])
            let canonical = try p.canonicalBytes()
            XCTAssertEqual(String(decoding: canonical, as: UTF8.self), row["canonical"] as? String)
            XCTAssertTrue(ServingAuthority.verifyEd25519(canonical, signatureHex: row["signature"] as! String, publicKeyHex: row["signerPub"] as! String))
            var tampered = p
            tampered.policyGen += 1
            XCTAssertFalse(ServingAuthority.verifyEd25519(try tampered.canonicalBytes(), signatureHex: row["signature"] as! String, publicKeyHex: row["signerPub"] as! String))
        }
    }

    func testDelegationReproducesCanonicalBytesAndVerifies() throws {
        let row = try XCTUnwrap(try rows("renewal-key-delegation").first)
        let d = try decode(RenewalKeyDelegation.self, row["record"])
        let canonical = try d.canonicalBytes()
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self), row["canonical"] as? String)
        XCTAssertTrue(ServingAuthority.verifyEd25519(canonical, signatureHex: row["signature"] as! String, publicKeyHex: row["signerPub"] as! String))
    }

    func testLeasesReproduceCanonicalBytesAndVerifyUnderTheirAlgorithm() throws {
        let rows = try rows("serving-lease")
        XCTAssertEqual(Set(rows.compactMap { $0["alg"] as? String }), ["p256", "ed25519"])
        for row in rows {
            let l = try decode(ServingLease.self, row["record"])
            let canonical = try l.canonicalBytes()
            XCTAssertEqual(String(decoding: canonical, as: UTF8.self), row["canonical"] as? String)
            let sig = row["signature"] as! String, pub = row["signerPub"] as! String
            if row["alg"] as? String == "p256" {
                XCTAssertTrue(ServingAuthority.verifyLeaseP256(l, signatureHex: sig, renewalPubHex: pub))
                // The same signature with S flipped to n − S is refused: only low-S counts.
                let raw = try XCTUnwrap(HexUtil.decode(sig))
                let high = Data(raw.prefix(32)) + Data(Self.sub(ServingAuthority.p256Order, [UInt8](raw.suffix(32))))
                XCTAssertFalse(ServingAuthority.isLowS(high))
                XCTAssertFalse(ServingAuthority.verifyLeaseP256(l, signatureHex: HexUtil.encode(high), renewalPubHex: pub))
                XCTAssertEqual(ServingAuthority.normalizeLowS(high), raw)
            } else {
                XCTAssertTrue(ServingAuthority.verifyEd25519(canonical, signatureHex: sig, publicKeyHex: pub))
            }
        }
    }

    func testLeaseForFollowsTheGrace() throws {
        let row = try XCTUnwrap(try rows("serving-policy").first)
        var p = try decode(ServingPolicy.self, row["record"])
        let id = String(repeating: "ab", count: 16)
        let lease = try XCTUnwrap(ServingAuthority.leaseFor(p, now: 1_800_000_000_000, leaseId: id))
        XCTAssertEqual(lease.notAfter, 1_800_000_000_000 + 7 * 86_400_000)
        XCTAssertEqual(lease.policyGen, p.policyGen)
        // The vectors' p256 lease is exactly leaseFor(policy 7d, issuedAt, abab…).
        let vectorLease = try decode(ServingLease.self, try XCTUnwrap(try rows("serving-lease").first { $0["alg"] as? String == "p256" })["record"])
        XCTAssertEqual(ServingAuthority.leaseFor(p, now: vectorLease.issuedAt, leaseId: vectorLease.leaseId), vectorLease)
        p.grace = ServingGrace.thirtyDays.rawValue
        XCTAssertEqual(ServingAuthority.leaseFor(p, now: 0, leaseId: id)?.notAfter, 30 * 86_400_000)
        p.grace = ServingGrace.indefinite.rawValue
        XCTAssertNil(ServingAuthority.leaseFor(p, now: 0, leaseId: id))
    }

    func testRecordsRefuseWhatTheReferenceRefuses() throws {
        let box = String(repeating: "6e", count: 32), scope = String(repeating: "1b", count: 32)
        XCTAssertThrowsError(try ServingPolicy(account: "alice", box: box, regGen: 1, policyGen: 1, grace: .indefinite, onLapse: .lockServer, scopeSha256: scope, issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try ServingPolicy(account: "Alice", box: box, regGen: 1, policyGen: 1, grace: .sevenDays, onLapse: .stopApps, scopeSha256: scope, issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try ServingPolicy(account: "alice", box: box, regGen: 0, policyGen: 1, grace: .sevenDays, onLapse: .stopApps, scopeSha256: scope, issuedAt: 1).canonicalBytes())
        XCTAssertThrowsError(try ServingLease(account: "alice", box: box, regGen: 1, policyGen: 1, leaseId: "ab", issuedAt: 5, notAfter: 6).canonicalBytes())
        XCTAssertThrowsError(try ServingLease(account: "alice", box: box, regGen: 1, policyGen: 1, leaseId: String(repeating: "ab", count: 16), issuedAt: 6, notAfter: 6).canonicalBytes())
        XCTAssertThrowsError(try RenewalKeyDelegation(account: "alice", renewalPub: "04" + String(repeating: "aa", count: 32), deviceId: box, issuedAt: 1).canonicalBytes())
    }

    /// A key CryptoKit makes signs a lease the reference rule accepts, whatever S CryptoKit chose.
    func testCryptoKitSignaturesNormaliseToLowSAndVerify() throws {
        let key = P256.Signing.PrivateKey()
        let lease = ServingLease(account: "alice", box: String(repeating: "6e", count: 32), regGen: 1, policyGen: 2,
                                 leaseId: ServingAuthority.randomLeaseId(), issuedAt: 1_000, notAfter: 2_000)
        for _ in 0..<32 {
            let sig = try ServingAuthority.signLeaseP256(lease) { try key.signature(for: $0).rawRepresentation }
            XCTAssertTrue(ServingAuthority.isLowS(HexUtil.decode(sig)!))
            XCTAssertTrue(ServingAuthority.verifyLeaseP256(lease, signatureHex: sig, renewalPubHex: ServingAuthority.compressedHex(key.publicKey)))
        }
    }

    func testDerToRawMatchesCryptoKit() throws {
        let key = P256.Signing.PrivateKey()
        for _ in 0..<32 {
            let sig = try key.signature(for: Data("x".utf8))
            XCTAssertEqual(ServingAuthority.derToRaw(sig.derRepresentation), sig.rawRepresentation)
        }
        // Short integers are left-padded; leading 0x00 sign bytes are dropped.
        let der = Data([0x30, 0x08, 0x02, 0x02, 0x00, 0x80, 0x02, 0x02, 0x01, 0x02])
        let raw = try XCTUnwrap(ServingAuthority.derToRaw(der))
        XCTAssertEqual(raw.count, 64)
        XCTAssertEqual(raw[31], 0x80)
        XCTAssertEqual(Array(raw.suffix(2)), [0x01, 0x02])
        XCTAssertNil(ServingAuthority.derToRaw(Data([0x30, 0x03, 0x02, 0x01])))
        XCTAssertNil(ServingAuthority.derToRaw(Data([0x31, 0x00])))
    }

    private static func sub(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 32), borrow = 0
        for i in stride(from: 31, through: 0, by: -1) {
            var d = Int(a[i]) - Int(b[i]) - borrow
            borrow = d < 0 ? 1 : 0
            if d < 0 { d += 256 }
            out[i] = UInt8(d)
        }
        return out
    }
}

final class ServingLineTests: XCTestCase {
    func testTheLineFollowsThePolicy() {
        XCTAssertEqual(ServingLine.kind(grace: .indefinite, onLapse: .stopApps, until: nil), .noLimit)
        XCTAssertEqual(ServingLine.kind(grace: .sevenDays, onLapse: .stopApps, until: 5), .staysOnline(until: 5))
        XCTAssertEqual(ServingLine.kind(grace: .thirtyDays, onLapse: .lockServer, until: 5), .locks(until: 5))
        XCTAssertEqual(ServingLine.kind(grace: .sevenDays, onLapse: .lockServer, until: nil), .noLease(locks: true))
    }

    func testTheStoreRemembersOnlyALockingFinitePolicy() {
        let d = UserDefaults(suiteName: "serving-store-test-\(UUID().uuidString)")!
        let s = ServingStateStore(defaults: d)
        s.record("Home.Alice.flagship.services", onLapse: .lockServer, grace: .sevenDays, until: 42)
        XCTAssertTrue(s.locks("home.alice.flagship.services"))
        XCTAssertEqual(s.until("home.alice.flagship.services"), 42)
        s.record("home.alice.flagship.services", onLapse: .stopApps, grace: .indefinite, until: nil)
        XCTAssertFalse(s.locks("home.alice.flagship.services"))
        XCTAssertNil(s.until("home.alice.flagship.services"))
    }
}
