import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// Pins the create-time pairing contract: the deposit the phone builds must be
/// exactly what the daemon's `consumePendingPairing` opens + verifies — sealed
/// FOR the recipe pairing key, carrying an owner-IRK-signed `add-paired-session`
/// order. The seal round-trip + IRK verify here mirror the daemon byte-for-byte
/// (the daemon opens with `pairingKeyPrivHex`, JSON-parses `{request,signature}`,
/// and re-verifies the order under the owner IRK).
final class CreateTimePairingTests: XCTestCase {
    private let host = "home.alice.flagship.services"

    func testDepositRoundTripsToTheSignedOrder() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let pairingKey = Curve25519.Signing.PrivateKey()
        let token = "ab".repeated(32)   // 32-byte hex

        let built = try CreateTimePairing.build(
            username: "alice",
            serverDomain: host,
            label: "Alice's iPhone",
            irk: irk,
            now: 1_700_000_000_000,
            token: token,
            pairingKey: pairingKey
        )

        // The token + recipe key are surfaced for the caller to persist/embed.
        XCTAssertEqual(built.token, token)
        XCTAssertEqual(built.pairingKeyPrivHex, HexUtil.encode(pairingKey.rawRepresentation))

        // Deposit body shape: stkPub is the pairing key pub (the seal recipient).
        XCTAssertEqual(built.body.deposit.serverDomain, host)
        XCTAssertEqual(built.body.deposit.stkPub, HexUtil.encode(pairingKey.publicKey.rawRepresentation))
        XCTAssertEqual(built.body.auth.username, "alice")
        XCTAssertEqual(built.body.auth.phoneIrkPub, HexUtil.encode(irk.publicKey.rawRepresentation))

        // The daemon's exact move: open the sealed blob with the recipe pairing
        // key, parse `{request, signature}`, re-verify the order under the IRK.
        let sealed = try XCTUnwrap(HexUtil.decode(built.body.deposit.sealed))
        let plain = try SecretSeal.openWithEd25519Seed(
            blob: sealed,
            recipientEd25519Seed: pairingKey.rawRepresentation
        )
        let env = try XCTUnwrap(try JSONSerialization.jsonObject(with: plain) as? [String: Any])
        let request = try XCTUnwrap(env["request"] as? [String: Any])
        let signatureHex = try XCTUnwrap(env["signature"] as? String)

        XCTAssertEqual(request["type"] as? String, "add-paired-session")
        XCTAssertEqual(request["serverId"] as? String, host)
        XCTAssertEqual(request["token"] as? String, token)

        // Re-derive the order's canonical bytes from the parsed fields and verify
        // the owner-IRK signature — the daemon's `verifyPhoneOrder`.
        let order = AddPairedSessionOrder(
            serverId: try XCTUnwrap(request["serverId"] as? String),
            token: try XCTUnwrap(request["token"] as? String),
            label: try XCTUnwrap(request["label"] as? String),
            issuedAt: try XCTUnwrap((request["issuedAt"] as? NSNumber)?.int64Value)
        )
        let sig = try XCTUnwrap(HexUtil.decode(signatureHex))
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: order.canonicalBytes()))

        // The mailbox-auth signature verifies under the same IRK (the daemon's
        // `authPhoneMailbox` gate).
        let claim = DeviceEndpointClaim(
            username: built.body.auth.username,
            endpointLabel: built.body.auth.endpointLabel,
            phoneIrkPub: try XCTUnwrap(HexUtil.decode(built.body.auth.phoneIrkPub)),
            issuedAt: built.body.auth.issuedAt,
            expiresAt: built.body.auth.expiresAt,
            nonce: try XCTUnwrap(HexUtil.decode(built.body.auth.nonce))
        )
        let authSig = try XCTUnwrap(HexUtil.decode(built.body.authSignature))
        XCTAssertTrue(DeviceEndpointClaim.verify(claim, signature: authSig, irkPub: irk.publicKey))
    }

    /// A WRONG pairing key must NOT open the blob — proves the seal is the real
    /// binding (a relay/`.com` that swapped the recipe key gets inert ciphertext).
    func testWrongPairingKeyCannotOpen() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let pairingKey = Curve25519.Signing.PrivateKey()
        let built = try CreateTimePairing.build(
            username: "alice", serverDomain: host, label: "iPhone", irk: irk,
            now: 1_700_000_000_000, token: "cd".repeated(32), pairingKey: pairingKey
        )
        let sealed = try XCTUnwrap(HexUtil.decode(built.body.deposit.sealed))
        let stranger = Curve25519.Signing.PrivateKey()
        XCTAssertThrowsError(
            try SecretSeal.openWithEd25519Seed(blob: sealed, recipientEd25519Seed: stranger.rawRepresentation)
        )
    }
}

private extension String {
    func repeated(_ n: Int) -> String { String(repeating: self, count: n) }
}
