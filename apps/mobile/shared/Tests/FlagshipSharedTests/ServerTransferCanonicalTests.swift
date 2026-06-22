import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the Swift canonical bytes for the `server-transfer-offer` +
/// `server-transfer-claim` envelopes (transfer-a-box §4) to the EXACT
/// cross-platform vector. `.com` re-derives these to verify the giver/acquirer
/// IRK signatures, so any drift in the tag, `|` separator, field order, or the
/// lowercasing would break box transfer.
///
/// TS half: `packages/protocol/tests/accountDeletionVectors.test.ts`.
/// Kotlin half: `ServerTransferVectorTest.kt`.
final class ServerTransferCanonicalTests: XCTestCase {
    private func str(_ d: Data) -> String { String(data: d, encoding: .utf8)! }
    private let nonce = String(repeating: "ab", count: 32)

    func testOfferCanonicalBytes() {
        let o = ServerTransferOfferOrder(
            serverDomain: "home.alice.flagship.services", transferNonce: nonce,
            issuedAt: 1700, expiresAt: 2000
        )
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/server-transfer-offer/v1|home.alice.flagship.services|\(nonce)|1700|2000"
        )
    }

    func testOfferLowercasesDomainAndNonce() {
        let o = ServerTransferOfferOrder(
            serverDomain: "HOME.alice.flagship.services",
            transferNonce: String(repeating: "AB", count: 32),
            issuedAt: 1, expiresAt: 2
        )
        XCTAssertEqual(
            str(o.canonicalBytes()),
            "flagship/server-transfer-offer/v1|home.alice.flagship.services|\(nonce)|1|2"
        )
    }

    func testClaimCanonicalBytes() {
        let pubHex = String(repeating: "cd", count: 32)
        let c = ServerTransferClaimOrder(
            serverDomain: "home.alice.flagship.services", transferNonce: nonce,
            acquirerUsername: "Bob", acquirerIrkPubHex: pubHex, issuedAt: 1800
        )
        XCTAssertEqual(
            str(c.canonicalBytes()),
            "flagship/server-transfer-claim/v1|home.alice.flagship.services|\(nonce)|bob|\(pubHex)|1800"
        )
    }

    func testSignVerifyRoundTrip() {
        let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
        let offer = ServerTransferOfferOrder(
            serverDomain: "home.alice.flagship.services", transferNonce: nonce,
            issuedAt: 1, expiresAt: 2
        )
        let osig = try! offer.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(osig, for: offer.canonicalBytes()))

        let claim = ServerTransferClaimOrder(
            serverDomain: "home.alice.flagship.services", transferNonce: nonce,
            acquirerUsername: "bob", acquirerIrkPubHex: String(repeating: "cd", count: 32), issuedAt: 3
        )
        let csig = try! claim.sign(with: key)
        XCTAssertTrue(key.publicKey.isValidSignature(csig, for: claim.canonicalBytes()))

        // An offer sig must NOT verify as a claim.
        XCTAssertFalse(key.publicKey.isValidSignature(osig, for: claim.canonicalBytes()))
    }
}
