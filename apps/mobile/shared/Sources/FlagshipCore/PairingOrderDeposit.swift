import Foundation
import CryptoKit
import FlagshipAPI

/// DEFAULT (online) pairing deposit builder — the secret-free twin of
/// `SwkDelivery.buildDeposit`, for the paired-session order.
///
/// Once the box has registered (carrying its Ed25519 IDENTITY pub in `/pods`),
/// the phone seals the create-time plaintext `pairingOrder` JSON DIRECTLY to that
/// identity (`SecretSeal.sealForEd25519Recipient`) and deposits it on `.com`'s
/// blind pairing-deposit lane. Unlike the SWK lane (which wraps the seal in a
/// carrier JSON), the pairing-deposit consumer unseals `deposit.sealed` and
/// decodes the bytes as the `{request, signature}` JSON verbatim — so the sealed
/// blob IS the seal output, no carrier wrapper.
///
/// `.com` holds only the opaque ciphertext (I1); the box unseals with its
/// identity key, verifies the owner-IRK order under its config-pinned owner IRK,
/// and adds the session. Sealing is a public-key op — NO second biometric.
public enum PairingOrderDeposit {
    /// Build the full deposit body for `SecretMailboxClient.depositPairing`. The
    /// order JSON is sealed to the box's REGISTERED identity pub (`stkPub` — what
    /// `.com`'s pairing-deposit handler binds I2); the `auth`/`authSignature` are
    /// the SAME IRK mailbox-auth shape as every other phone-mailbox call.
    public static func buildDeposit(
        username: String,
        serverDomain: String,
        pairingOrderJson: String,
        boxIdentityPub: Data,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        mailboxNonce: Data = SecretRequestCoordinator.randomNonce(),
        depositNonce: Data = SecretRequestCoordinator.randomNonce()
    ) throws -> PairingDepositBody {
        let sealed = try SecretSeal.sealForEd25519Recipient(
            plaintext: Data(pairingOrderJson.utf8),
            recipientEd25519Pub: boxIdentityPub
        )

        let claim = DeviceEndpointClaim(
            username: username,
            endpointLabel: "device",
            phoneIrkPub: irk.publicKey.rawRepresentation,
            issuedAt: now,
            expiresAt: now + 120_000,
            nonce: mailboxNonce
        )
        let authSig = try claim.sign(with: irk)
        let auth = MailboxAuthEnvelope.Auth(
            username: username,
            endpointLabel: "device",
            phoneIrkPub: HexUtil.encode(claim.phoneIrkPub),
            issuedAt: claim.issuedAt,
            expiresAt: claim.expiresAt,
            nonce: HexUtil.encode(claim.nonce)
        )
        return PairingDepositBody(
            auth: auth,
            authSignature: HexUtil.encode(authSig),
            deposit: .init(
                serverDomain: serverDomain,
                requestNonceHex: HexUtil.encode(depositNonce),
                // I2: the deposit binds the box's REGISTERED STK = its identity pub.
                stkPub: HexUtil.encode(boxIdentityPub),
                sealed: HexUtil.encode(sealed),
                issuedAt: now
            )
        )
    }
}
