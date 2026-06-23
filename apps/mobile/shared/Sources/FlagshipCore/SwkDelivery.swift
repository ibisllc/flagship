import Foundation
import CryptoKit
import FlagshipAPI

/// Swift mirror of `packages/protocol/src/swkDelivery.ts` — the sealed
/// SWK-delivery envelope for the secret-free recipe
/// (docs/recipe-delivery-and-remote-install.md).
///
/// The phone seals the 32-byte SWK to the box's Ed25519 identity pubkey (via the
/// standard ed→x25519 birational map, the same `SecretSeal.sealForEd25519Recipient`
/// the disk-key / pairing flows use) and IRK-signs the wrapper binding
/// `(serverDomain, sealed, issuedAt)`:
///
///   flagship/swk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
///
/// The carrier deposited on `.com` is hex-encoded UTF-8 JSON
/// `{serverDomain, sealed, issuedAt, signature}` — byte-identical to the TS
/// `swkDeliveryToCarrierHex`. `.com` holds only the opaque ciphertext (I1); the
/// box verifies the owner-IRK signature under its config-pinned owner IRK, then
/// unseals the SWK with its identity key. The pinned cross-platform vector in
/// `packages/protocol/tests/swkDelivery.test.ts` (UMK 07×32 → IRK 3e4a50e7…,
/// box seed 09×32 → pub fd172438…, signature 660cf5eb…a8867a0f) is reproduced
/// byte-for-byte by `SwkDeliveryTests`.
public enum SwkDelivery {
    static let tag = "flagship/swk-delivery/v1"

    public enum SwkDeliveryError: Error, Equatable {
        case badSwk
        case badBoxIdentityPub
        case fieldGuard(String)
    }

    /// The signed (but not yet hex-serialized) envelope.
    public struct Delivery: Equatable, Sendable {
        public let serverDomain: String
        /// The SWK SEALED for the box identity (`sealForEd25519Recipient` output).
        public let sealed: Data
        public let issuedAt: Int64
        public init(serverDomain: String, sealed: Data, issuedAt: Int64) {
            self.serverDomain = serverDomain
            self.sealed = sealed
            self.issuedAt = issuedAt
        }
    }

    /// Canonical bytes signed by the owner IRK. Field-guards `serverDomain`
    /// (rejects '|' + control chars) to match `legacyFieldGuard` in the TS.
    static func canonicalBytes(_ d: Delivery) throws -> Data {
        try PhoneEndpointFieldGuard.check("serverDomain", d.serverDomain)
        let s = [tag, d.serverDomain, HexUtil.encode(d.sealed), String(d.issuedAt)].joined(separator: "|")
        return Data(s.utf8)
    }

    /// Sign an already-sealed delivery with the owner IRK.
    public static func sign(_ d: Delivery, irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes(d))
    }

    /// PHONE side. Seal the 32-byte SWK to the box's Ed25519 identity pubkey and
    /// IRK-sign the wrapper. Returns the envelope + its signature; the caller
    /// hex-serializes them into the deposit carrier (`carrierHex`).
    public static func build(
        serverDomain: String,
        swk: Data,
        boxIdentityPub: Data,
        irk: Curve25519.Signing.PrivateKey,
        issuedAt: Int64
    ) throws -> (delivery: Delivery, signature: Data) {
        guard swk.count == 32 else { throw SwkDeliveryError.badSwk }
        guard boxIdentityPub.count == 32 else { throw SwkDeliveryError.badBoxIdentityPub }
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: swk, recipientEd25519Pub: boxIdentityPub)
        let delivery = Delivery(serverDomain: serverDomain, sealed: sealed, issuedAt: issuedAt)
        let signature = try sign(delivery, irk: irk)
        return (delivery, signature)
    }

    /// Phone side: turn a built delivery + signature into the hex carrier the
    /// deposit lane stores (the `sealed` field of the `purpose:"swk"` deposit row).
    /// Byte-identical to the TS `swkDeliveryToCarrierHex` so the box parses it.
    public static func carrierHex(delivery: Delivery, signature: Data) -> String {
        let obj: [String: Any] = [
            "serverDomain": delivery.serverDomain,
            "sealed": HexUtil.encode(delivery.sealed),
            "issuedAt": delivery.issuedAt,
            "signature": HexUtil.encode(signature),
        ]
        // The TS emits JSON.stringify key order = insertion order
        // (serverDomain, sealed, issuedAt, signature). The box re-parses the
        // JSON by field name and re-derives canonical bytes, so key ORDER is
        // irrelevant to verification — only the values matter.
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
        return HexUtil.encode(data)
    }

    /// Build the full deposit body for `SecretMailboxClient.depositSwk`. The box
    /// SWK is sealed to its REGISTERED identity pub (`stkPub` — what `.com`'s
    /// swk-deposit handler binds I2), the wrapper IRK-signed, and the carrier
    /// hex placed in `deposit.sealed`. The `auth`/`authSignature` are the SAME
    /// IRK mailbox-auth shape as every other phone-mailbox call.
    public static func buildDeposit(
        username: String,
        serverDomain: String,
        swk: Data,
        boxIdentityPub: Data,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        mailboxNonce: Data = SecretRequestCoordinator.randomNonce(),
        depositNonce: Data = SecretRequestCoordinator.randomNonce()
    ) throws -> PairingDepositBody {
        let built = try build(
            serverDomain: serverDomain,
            swk: swk,
            boxIdentityPub: boxIdentityPub,
            irk: irk,
            issuedAt: now
        )
        let carrier = carrierHex(delivery: built.delivery, signature: built.signature)

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
                sealed: carrier,
                issuedAt: now
            )
        )
    }
}
