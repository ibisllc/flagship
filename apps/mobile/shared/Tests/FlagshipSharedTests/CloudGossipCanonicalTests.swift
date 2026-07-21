import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift Phase-3 cloud-gossip / leadership primitives to the EXACT
/// cross-platform vectors. The TS half lives in
/// `packages/protocol/tests/cloudGossipVectors.test.ts`; the Kotlin half in
/// `CloudGossipVectorTest.kt`. Any drift in the CGK HKDF info, the canonical
/// tag/separator/field-order/lowercasing/number-stringification, the HMAC, or
/// the clout comparator breaks gossip authentication and leadership.
final class CloudGossipCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }
    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    // MARK: 1. CGK
    func testCGKPinnedVector() {
        let seed = Data(repeating: 0x07, count: 32)
        let cgk = CloudGossip.deriveCGK(umkSeed: seed)
        XCTAssertNotNil(cgk)
        XCTAssertEqual(
            hex(cgk!),
            "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd"
        )
    }

    func testCGKRejectsNon32() {
        XCTAssertNil(CloudGossip.deriveCGK(umkSeed: Data(repeating: 0x07, count: 31)))
    }

    // MARK: 2. set-leader
    private let voteCanonical =
        "flagship/set-leader/v1|alice|" + String(repeating: "aa", count: 32) + "|1700|deadbeef"

    private func vote() -> CloudGossip.SetLeaderVote {
        CloudGossip.SetLeaderVote(
            user: "alice",
            preferredStkPubHex: String(repeating: "aa", count: 32),
            issuedAt: 1700,
            nonce: "deadbeef"
        )
    }

    func testSetLeaderCanonicalBytes() {
        XCTAssertEqual(str(vote().canonicalBytes()), voteCanonical)
    }

    func testSetLeaderLowercases() {
        let v = CloudGossip.SetLeaderVote(
            user: "Alice",
            preferredStkPubHex: String(repeating: "AA", count: 32),
            issuedAt: 1700,
            nonce: "DEADBEEF"
        )
        XCTAssertEqual(str(v.canonicalBytes()), voteCanonical)
    }

    func testSetLeaderNoneClears() {
        let v = CloudGossip.SetLeaderVote(
            user: "alice", preferredStkPubHex: "none", issuedAt: 1700, nonce: "deadbeef"
        )
        XCTAssertEqual(str(v.canonicalBytes()), "flagship/set-leader/v1|alice|none|1700|deadbeef")
    }

    func testSetLeaderSignVerify() {
        // Ed25519 private = 32 bytes all 0x07 (matches the TS vector seed).
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        // The PUBLIC key is pinned (deterministic from the seed); the SIGNATURE
        // is NOT — CryptoKit randomizes Ed25519 signing (still RFC 8032-valid),
        // so a sign() round-trip can only be checked via isValidSignature, not
        // by pinning the raw signature hex (same convention as
        // ServerDecommissionCanonicalTests). The deterministic sig hex IS pinned
        // on the TS side (noble is deterministic) for `verifySetLeader`.
        XCTAssertEqual(
            hex(key.publicKey.rawRepresentation),
            "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
        )
        let v = vote()
        let sig = try! v.sign(with: key)
        // Verifies over the EXACT pinned canonical string.
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: Data(voteCanonical.utf8)))
        XCTAssertTrue(v.verify(sig, with: key.publicKey))
    }

    // MARK: 3. gossip
    private func cgk() -> Data { CloudGossip.deriveCGK(umkSeed: Data(repeating: 0x07, count: 32))! }

    private func announcement() -> CloudGossip.Announcement {
        CloudGossip.Announcement(
            user: "alice",
            name: String(repeating: "bb", count: 32),
            birthAuthHex: String(repeating: "cc", count: 32),
            birthDate: 1000,
            voteStkHex: "none",
            voteDate: 0,
            services: ["photos", "notes", "chat"], // unsorted on purpose
            liveness: "live",
            issuedAt: 1700
        )
    }

    private let gossipCanonical =
        "flagship/gossip/v1|alice|" + String(repeating: "bb", count: 32) + "|"
        + String(repeating: "cc", count: 32) + "|1000|none|0|chat,notes,photos|live|1700"

    func testGossipCanonicalSortsServices() {
        XCTAssertEqual(str(announcement().canonicalBytes()), gossipCanonical)
    }

    func testGossipHmacPinned() {
        XCTAssertEqual(
            CloudGossip.macGossip(announcement(), cgk: cgk()),
            "2454b8b48b4e560e4613e32cb46c0df1161dfb934dd0c3f550a7507ff4a1647e"
        )
    }

    func testGossipVerifyMac() {
        let a = announcement()
        XCTAssertTrue(CloudGossip.verifyGossipMac(a, mac: CloudGossip.macGossip(a, cgk: cgk()), cgk: cgk()))
        XCTAssertFalse(CloudGossip.verifyGossipMac(a, mac: String(repeating: "00", count: 32), cgk: cgk()))
        XCTAssertFalse(CloudGossip.verifyGossipMac(a, mac: "not-hex", cgk: cgk()))
        let wrong = CloudGossip.deriveCGK(umkSeed: Data(repeating: 0x09, count: 32))!
        XCTAssertFalse(CloudGossip.verifyGossipMac(a, mac: CloudGossip.macGossip(a, cgk: cgk()), cgk: wrong))
    }

    func testGossipSealOpenRoundTrip() {
        let pt = Data("hello-gossip".utf8)
        let blob = try! CloudGossip.sealGossip(pt, cgk: cgk())
        XCTAssertEqual(blob.count, 12 + pt.count + 16) // nonce + ct + GCM tag
        XCTAssertEqual(try! CloudGossip.openGossip(blob, cgk: cgk()), pt)
        let wrong = CloudGossip.deriveCGK(umkSeed: Data(repeating: 0x09, count: 32))!
        XCTAssertThrowsError(try CloudGossip.openGossip(blob, cgk: wrong))
    }

    // MARK: 4. clout
    private func mk(
        _ id: String, _ domain: String, _ birth: Int64, _ vote: Int64?,
        _ liveness: String, _ services: [String]
    ) -> CloudGossip.CloutMember {
        CloudGossip.CloutMember(
            id: id, domain: domain, birthDate: birth, voteIssuedAt: vote,
            liveness: liveness, services: services
        )
    }

    func testCloutScenarioAVoteWins() {
        let m = [
            mk("p1", "home.alice.flagship.services", 1000, nil, "live", ["photos"]),
            mk("p2", "work.alice.flagship.services", 2000, 5000, "live", ["photos"]),
        ]
        XCTAssertEqual(CloudGossip.electLeadForService(m, serviceSlug: "photos")?.id, "p2")
    }

    func testCloutScenarioBOldestBirthWins() {
        let m = [
            mk("p1", "home.alice.flagship.services", 2000, nil, "live", ["notes"]),
            mk("p2", "work.alice.flagship.services", 1000, nil, "live", ["notes"]),
        ]
        XCTAssertEqual(CloudGossip.electLeadForService(m, serviceSlug: "notes")?.id, "p2")
    }

    func testCloutScenarioCLowestDomainWins() {
        let m = [
            mk("pz", "zeta.alice.flagship.services", 1000, 3000, "live", ["chat"]),
            mk("pa", "alpha.alice.flagship.services", 1000, 3000, "live", ["chat"]),
        ]
        XCTAssertEqual(CloudGossip.electLeadForService(m, serviceSlug: "chat")?.id, "pa")
    }

    func testCloutOnlyLiveRunnersEligible() {
        let dead = [
            mk("p1", "home.alice.flagship.services", 1000, 9000, "unreachable", ["mail"]),
            mk("p2", "work.alice.flagship.services", 1000, nil, "never", ["mail"]),
        ]
        XCTAssertNil(CloudGossip.electLeadForService(dead, serviceSlug: "mail"))
        let mixed = [
            mk("p1", "home.alice.flagship.services", 1000, nil, "live", ["photos"]),
            mk("p2", "work.alice.flagship.services", 2000, nil, "live", ["notes"]),
        ]
        XCTAssertEqual(CloudGossip.electLeadForService(mixed, serviceSlug: "notes")?.id, "p2")
    }

    func testCloutLessIsTotalOrder() {
        let voted = mk("v", "z.a", 5000, 9000, "live", [])
        let old = mk("o", "a.a", 1000, nil, "live", [])
        XCTAssertTrue(CloudGossip.cloutLess(voted, old))
        XCTAssertFalse(CloudGossip.cloutLess(old, voted))
    }

    // MARK: 5. birth date
    func testBirthDateFromAuthCode() {
        XCTAssertEqual(CloudGossip.birthDateFromAuthCode(issuedAt: 1234567), 1234567)
    }
}
