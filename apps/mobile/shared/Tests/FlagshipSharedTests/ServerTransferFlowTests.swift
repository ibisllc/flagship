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
        let body = try ServerTransferFlow.buildClaim(
            offer: qr, acquirerUsername: "Bob", acquirerIrk: acquirer, issuedAt: 1800
        )
        XCTAssertEqual(body.claim.acquirerUsername, "bob")
        XCTAssertEqual(body.claim.acquirerIrkPub, HexUtil.encode(acquirer.publicKey.rawRepresentation))
        let order = ServerTransferClaimOrder(
            serverDomain: host, transferNonce: qr.transferNonce,
            acquirerUsername: "bob", acquirerIrkPubHex: body.claim.acquirerIrkPub, issuedAt: 1800
        )
        let sig = HexUtil.decode(body.claimSignature)!
        XCTAssertTrue(acquirer.publicKey.isValidSignature(sig, for: order.canonicalBytes()))
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
