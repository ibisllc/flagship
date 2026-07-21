import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipAPI

/// Exercises the pure transfer-a-box flow builders (Layer C). The giver builds +
/// signs the offer + QR; the acquirer parses the QR + signs the claim; the giver
/// re-seals the disk key to the acquirer IRK + the acquirer opens it. All the
/// crypto/canonical-bytes the broker verifies, with no UIKit/VM layer.
final class ServerTransferFlowTests: XCTestCase {
    private let giver = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 11, count: 32))
    private let acquirer = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 22, count: 32))
    private let host = "home.alice.flagship.services"

    func testBuildOfferSignsUnderGiverIrkAndEncodesQR() throws {
        let nonce = Data(repeating: 0xab, count: 32)
        let (body, qr) = try ServerTransferFlow.buildOffer(
            serverDomain: host, username: "alice", irk: giver,
            issuedAt: 1700, ttlMs: 900_000, nonce: nonce, authNonce: Data(repeating: 0x01, count: 32)
        )
        // The offer signature verifies under the giver IRK over the canonical bytes.
        let order = ServerTransferOfferOrder(
            serverDomain: host, transferNonce: HexUtil.encode(nonce), issuedAt: 1700, expiresAt: 1700 + 900_000
        )
        let sig = HexUtil.decode(body.offerSignature)!
        XCTAssertTrue(giver.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
        // The mailbox-auth pins the account IRK.
        XCTAssertEqual(body.auth.phoneIrkPub, HexUtil.encode(giver.publicKey.rawRepresentation))
        // The QR carries everything the acquirer/broker need.
        XCTAssertEqual(qr.kind, "flagship-transfer-offer")
        XCTAssertEqual(qr.serverDomain, host)
        XCTAssertEqual(qr.giverIrkPub, HexUtil.encode(giver.publicKey.rawRepresentation))
        let text = try ServerTransferFlow.encodeQR(qr)
        let reparsed = try ServerTransferFlow.parseQR(text)
        XCTAssertEqual(reparsed, qr)
    }

    func testParseQRRejectsNonTransferPayloads() {
        XCTAssertThrowsError(try ServerTransferFlow.parseQR("{}"))
        XCTAssertThrowsError(try ServerTransferFlow.parseQR("garbage"))
    }

    func testBuildClaimSignsUnderAcquirerIrk() throws {
        let qr = ServerTransferFlow.OfferQR(
            serverDomain: host, transferNonce: String(repeating: "cd", count: 32),
            giverIrkPub: HexUtil.encode(giver.publicKey.rawRepresentation),
            issuedAt: 1, expiresAt: 9_999_999_999_999, offerSignature: String(repeating: "00", count: 64)
        )
        let adminHex = String(repeating: "ef", count: 32)
        let body = try ServerTransferFlow.buildClaim(
            offer: qr, acquirerUsername: "Bob", acquirerIrk: acquirer,
            acquirerAdminRootPubHex: adminHex, issuedAt: 1800
        )
        XCTAssertEqual(body.claim.acquirerUsername, "bob")
        XCTAssertEqual(body.claim.acquirerIrkPub, HexUtil.encode(acquirer.publicKey.rawRepresentation))
        XCTAssertEqual(body.claim.acquirerAdminRootPub, adminHex)
        let order = ServerTransferClaimOrder(
            serverDomain: host, transferNonce: qr.transferNonce,
            acquirerUsername: "bob", acquirerIrkPubHex: body.claim.acquirerIrkPub,
            acquirerAdminRootPubHex: adminHex, issuedAt: 1800
        )
        let sig = HexUtil.decode(body.claimSignature)!
        XCTAssertTrue(acquirer.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
    }

    /// §9.8 — the giver's admin root signs the hand-off; the wire body carries
    /// the exact canonical fields and the signature verifies under the giver
    /// root (the box's pinned anchor).
    func testBuildAdminHandoffSignsUnderGiverAdminRoot() throws {
        let giverRoot = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 33, count: 32))
        let acquirerRootHex = String(repeating: "ef", count: 32)
        let nonce = String(repeating: "cd", count: 32)
        let body = try ServerTransferFlow.buildAdminHandoff(
            serverDomain: host, giverUsername: "alice", acquirerUsername: "bob",
            acquirerAdminRootPubHex: acquirerRootHex, giverAdminRoot: giverRoot,
            transferNonce: nonce, issuedAt: 1900
        )
        XCTAssertEqual(body.handoff.serverDomain, host)
        XCTAssertEqual(body.handoff.giverUsername, "alice")
        XCTAssertEqual(body.handoff.acquirerUsername, "bob")
        XCTAssertEqual(body.handoff.oldAdminRootPub, HexUtil.encode(giverRoot.publicKey.rawRepresentation))
        XCTAssertEqual(body.handoff.newAdminRootPub, acquirerRootHex)
        XCTAssertEqual(body.handoff.transferNonce, nonce)
        let h = AdminRootTransfer(
            serverDomain: host, giverUsername: "alice", acquirerUsername: "bob",
            oldAdminRootPubHex: body.handoff.oldAdminRootPub,
            newAdminRootPubHex: acquirerRootHex, transferNonce: nonce, issuedAt: 1900
        )
        let sig = HexUtil.decode(body.signatureHex)!
        XCTAssertTrue(h.verify(signature: sig, giverAdminRootPub: giverRoot.publicKey.rawRepresentation))
    }

    func testBuildRehomeAuthProducesBoxVerifiableSignature() throws {
        // The LEGACY (no-admin-root) giver produces the re-home authorization the
        // box checks against its PINNED owner IRK (v1-sec GAP 3). The box builds
        // the SAME canonical from the fields it already holds and re-verifies.
        let giverIrk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 21, count: 32))
        let acquirerIrkHex = String(repeating: "cd", count: 32)
        let newDomain = "home.bob.flagship.services"
        let body = try ServerTransferFlow.buildRehomeAuth(
            oldServerDomain: host, newServerDomain: newDomain,
            acquirerIrkPubHex: acquirerIrkHex, giverIrk: giverIrk, issuedAt: 1900
        )
        XCTAssertEqual(body.issuedAt, 1900)
        // The box's independent re-verify against its pinned owner IRK.
        let order = RehomeAuthorizationOrder(
            oldServerDomain: host, newServerDomain: newDomain,
            acquirerIrkPubHex: acquirerIrkHex, issuedAt: 1900
        )
        let sig = HexUtil.decode(body.signatureHex)!
        XCTAssertTrue(order.verify(signature: sig, giverIrkPub: giverIrk.publicKey.rawRepresentation))
        // A box that pins the wrong owner IRK must NOT accept it.
        let wrong = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 22, count: 32))
        XCTAssertFalse(order.verify(signature: sig, giverIrkPub: wrong.publicKey.rawRepresentation))
    }

    func testBuildClaimRejectsExpiredOffer() {
        let qr = ServerTransferFlow.OfferQR(
            serverDomain: host, transferNonce: String(repeating: "cd", count: 32),
            giverIrkPub: "00", issuedAt: 1, expiresAt: 5, offerSignature: "00"
        )
        XCTAssertThrowsError(try ServerTransferFlow.buildClaim(offer: qr, acquirerUsername: "bob", acquirerIrk: acquirer, issuedAt: 1000)) { e in
            XCTAssertEqual(e as? ServerTransferFlow.TransferError, .expired)
        }
    }

    func testDiskKeyReSealRoundTripsToAcquirer() throws {
        let diskKey = Data(repeating: 0x42, count: 32)
        let deposit = try ServerTransferFlow.buildDiskKeyDeposit(
            serverDomain: host, username: "alice", irk: giver, diskKey: diskKey,
            acquirerIrkPubHex: HexUtil.encode(acquirer.publicKey.rawRepresentation),
            issuedAt: 1000, authNonce: Data(repeating: 0x02, count: 32)
        )
        // The acquirer opens it with their IRK seed.
        let opened = try ServerTransferFlow.openDiskKey(sealedHex: deposit.sealedDiskKey, acquirerIrk: acquirer)
        XCTAssertEqual(opened, diskKey)
        // The giver's mailbox-auth identifies the giver account.
        XCTAssertEqual(deposit.auth.username, "alice")
    }
}
