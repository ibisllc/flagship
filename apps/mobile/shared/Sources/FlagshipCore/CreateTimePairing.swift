import Foundation
import CryptoKit
import FlagshipAPI

/// Builds the CREATE-TIME pairing deposit — the phone's half of pairing the
/// creating device with a server BEFORE the box exists.
///
/// The box generates its own identity key only at first boot, so the phone
/// can't seal a pairing order to it at create time. Instead the phone mints a
/// fresh PAIRING keypair, seals an owner-IRK-signed `add-paired-session` order
/// to its public half, and:
///   - DEPOSITS the sealed blob to `.com` (`POST /api/server/:d/pairing-deposit`,
///     IRK mailbox-auth) so the link survives a phone refresh, and
///   - EMBEDS the pairing key's PRIVATE half in the recipe (`pairingKeyPrivHex`,
///     an unsigned sibling) so the booting box can open the deposit and add the
///     session — coming online ALREADY paired (no "Pair this server" tap).
///
/// `.com` only ever holds the OPAQUE sealed blob (I1). The same `token` the box
/// will accept is returned so the creating device persists it as its session
/// token. The IRK is reused from the single create-server biometric ceremony,
/// so no extra Face ID prompt fires. Mirrors the webapp's `createTimePairing`
/// and the daemon's `consumePendingPairing`.
public enum CreateTimePairing {
    public struct Built: Sendable {
        /// The POST body for `SecretMailboxClient.depositPairing`.
        public let body: PairingDepositBody
        /// The paired-session token the box will accept — persist it locally so
        /// the BFF authenticates the moment the box claims the deposit.
        public let token: String
        /// The pairing key's private seed (hex) to embed in the recipe as
        /// `pairingKeyPrivHex` (the box opens the deposit with it).
        public let pairingKeyPrivHex: String
    }

    /// Build the deposit + token + recipe pairing key. All randomness is
    /// injectable so tests are deterministic; production calls pass nothing.
    public static func build(
        username: String,
        serverDomain: String,
        label: String,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        token: String = AddPairedSessionOrder.freshToken(),
        pairingKey: Curve25519.Signing.PrivateKey = Curve25519.Signing.PrivateKey(),
        mailboxNonce: Data = SecretRequestCoordinator.randomNonce(),
        depositNonce: Data = SecretRequestCoordinator.randomNonce()
    ) throws -> Built {
        // The label is committed to the order's canonical bytes, which the
        // daemon re-derives under a fieldGuard that rejects '|' + control chars.
        // Strip them so any UIDevice name pairs cleanly; fall back to "iPhone".
        let cleaned = label
            .components(separatedBy: CharacterSet(charactersIn: "|").union(.controlCharacters))
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        let safeLabel = cleaned.isEmpty ? "iPhone" : cleaned

        // 1. owner-IRK-signed add-paired-session order.
        let order = AddPairedSessionOrder(serverId: serverDomain, token: token, label: safeLabel, issuedAt: now)
        let orderSig = try order.sign(with: irk)
        let envelope = order.envelope(signatureHex: HexUtil.encode(orderSig))
        // The daemon JSON-parses this and re-derives canonical bytes from the
        // fields, so key order is irrelevant — any valid JSON round-trips.
        let envelopeData = try JSONSerialization.data(withJSONObject: envelope)

        // 2. seal the {request, signature} envelope FOR the pairing key pub.
        let pairingPub = pairingKey.publicKey.rawRepresentation
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: envelopeData, recipientEd25519Pub: pairingPub)

        // 3. IRK mailbox-auth (same shape as every other phone-mailbox call).
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

        let body = PairingDepositBody(
            auth: auth,
            authSignature: HexUtil.encode(authSig),
            deposit: .init(
                serverDomain: serverDomain,
                requestNonceHex: HexUtil.encode(depositNonce),
                stkPub: HexUtil.encode(pairingPub),
                sealed: HexUtil.encode(sealed),
                issuedAt: now
            )
        )
        return Built(body: body, token: token, pairingKeyPrivHex: HexUtil.encode(pairingKey.rawRepresentation))
    }
}
