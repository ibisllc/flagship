import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift `SetLeaderDeposit` body build for the "Set as preferred server"
/// owner vote (per-service leadership Phase 6). Asserts the body shape the Worker
/// handler (`handlePostSetLeaderDeposit`) expects and that the vote signature
/// verifies under the owner IRK over the EXACT `set-leader` canonical bytes
/// (`flagship/set-leader/v1|user|preferredStkPubHex|issuedAt|nonce`).
final class SetLeaderDepositTests: XCTestCase {
    private func vectorIrk() -> Curve25519.Signing.PrivateKey {
        // deriveIRK(UMK 07×32) → the pinned cross-platform IRK.
        let umk = Data(repeating: 0x07, count: 32)
        let seed = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umk),
            salt: Data(), info: Data("flagship.irk.v1".utf8), outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
        return try! Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    private let user = "alice"
    private let serverDomain = "kitchen.alice.flagship.services"
    // A valid 32-byte STK hex (the box's identity pub).
    private let stkHex = "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618"
    private let issuedAt: Int64 = 1_750_000_000_000

    func testBuildsBodyAndVoteVerifiesUnderOwnerIrk() throws {
        let irk = vectorIrk()
        let body = try SetLeaderDeposit.buildDeposit(
            username: user,
            serverDomain: serverDomain,
            preferredStkPubHex: stkHex,
            irk: irk,
            now: issuedAt
        )

        // Body shape mirrors the Worker handler.
        XCTAssertEqual(body.deposit.serverDomain, serverDomain)
        XCTAssertEqual(body.deposit.requestNonceHex.count, 64)
        XCTAssertEqual(body.vote.user, user)
        XCTAssertEqual(body.vote.preferredStkPubHex, stkHex)   // already lowercase
        XCTAssertEqual(body.vote.issuedAt, issuedAt)
        XCTAssertEqual(body.signature.count, 128)
        XCTAssertEqual(body.auth.username, user)
        XCTAssertEqual(body.auth.phoneIrkPub, HexUtil.encode(irk.publicKey.rawRepresentation))

        // The vote signature verifies under the owner IRK over the canonical
        // bytes the box re-derives (byte-identical to the TS verifySetLeader).
        let vote = CloudGossip.SetLeaderVote(
            user: body.vote.user,
            preferredStkPubHex: body.vote.preferredStkPubHex,
            issuedAt: body.vote.issuedAt,
            nonce: body.vote.nonce
        )
        let sig = HexUtil.decode(body.signature)!
        XCTAssertTrue(vote.verify(sig, with: irk.publicKey))

        // A wrong IRK must NOT verify.
        let wrong = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x42, count: 32))
        XCTAssertFalse(vote.verify(sig, with: wrong.publicKey))
    }

    func testClearVoteWithNoneSentinel() throws {
        let irk = vectorIrk()
        let body = try SetLeaderDeposit.buildDeposit(
            username: user,
            serverDomain: serverDomain,
            preferredStkPubHex: CloudGossip.setLeaderNone,
            irk: irk,
            now: issuedAt
        )
        XCTAssertEqual(body.vote.preferredStkPubHex, "none")
        let vote = CloudGossip.SetLeaderVote(
            user: body.vote.user, preferredStkPubHex: body.vote.preferredStkPubHex,
            issuedAt: body.vote.issuedAt, nonce: body.vote.nonce
        )
        XCTAssertTrue(vote.verify(HexUtil.decode(body.signature)!, with: irk.publicKey))
    }

    func testRejectsMalformedPreferredStk() {
        let irk = vectorIrk()
        XCTAssertThrowsError(try SetLeaderDeposit.buildDeposit(
            username: user, serverDomain: serverDomain,
            preferredStkPubHex: "not-hex", irk: irk, now: issuedAt
        ))
        // A 31-byte hex (too short) is rejected too.
        XCTAssertThrowsError(try SetLeaderDeposit.buildDeposit(
            username: user, serverDomain: serverDomain,
            preferredStkPubHex: String(repeating: "ab", count: 31), irk: irk, now: issuedAt
        ))
    }
}
