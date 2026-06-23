import Foundation
import CryptoKit
import FlagshipAPI

/// Swift mirror of `packages/protocol/src/cgkDelivery.ts` — the sealed
/// CGK-delivery envelope, the EXACT twin of `SwkDelivery` (only the payload +
/// tag differ). It is the post-boot hand-off of the Cloud Gossip Key per the
/// per-service-leadership Phase 6 (docs/multi-pod-liveness-session-leadership.md).
///
/// The secret-free recipe carries NO CGK; a box runs gossip only once it has a
/// CGK (else gossip stays dark — no brick). This module is the cryptographic
/// envelope for delivering it: the phone seals the 32-byte CGK to the box's
/// Ed25519 identity pubkey (`SecretSeal.sealForEd25519Recipient`, the same seal
/// the SWK/disk-key flows use) and IRK-signs the wrapper binding
/// `(serverDomain, sealed, issuedAt)`:
///
///   flagship/cgk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
///
/// The CGK is a SECRET (it authenticates + transports gossip frames between
/// siblings), so it is SEALED for the box identity exactly like the SWK — unlike
/// the set-leader vote (a PUBLIC carrier). The deposited carrier is hex-encoded
/// UTF-8 JSON `{serverDomain, sealed, issuedAt, signature}` — byte-identical to
/// the TS `cgkDeliveryToCarrierHex`. `.com` holds only the opaque ciphertext
/// (I1/I3); the box verifies the owner-IRK signature under its config-pinned
/// owner IRK, then unseals the CGK with its identity key. The pinned
/// cross-platform vector in `packages/protocol/tests/cgkDelivery.test.ts`
/// (UMK 07×32 → IRK 3e4a50e7…, box seed 09×32 → pub fd172438…, deriveCGK → CGK
/// 1d8e3bc3…, signature 147205c6…) is reproduced by `CgkDeliveryVectorTests`.
///
/// CGK is PER CLOUD, not per server — there is NO serverId in its derivation
/// (`CloudGossip.deriveCGK(umkSeed:)`).
public enum CgkDelivery {
    static let tag = "flagship/cgk-delivery/v1"

    public enum CgkDeliveryError: Error, Equatable {
        case badCgk
        case badBoxIdentityPub
        case fieldGuard(String)
    }

    /// The signed (but not yet hex-serialized) envelope.
    public struct Delivery: Equatable, Sendable {
        public let serverDomain: String
        /// The CGK SEALED for the box identity (`sealForEd25519Recipient` output).
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

    /// PHONE side. Seal the 32-byte CGK to the box's Ed25519 identity pubkey and
    /// IRK-sign the wrapper. Returns the envelope + its signature; the caller
    /// hex-serializes them into the deposit carrier (`carrierHex`).
    public static func build(
        serverDomain: String,
        cgk: Data,
        boxIdentityPub: Data,
        irk: Curve25519.Signing.PrivateKey,
        issuedAt: Int64
    ) throws -> (delivery: Delivery, signature: Data) {
        guard cgk.count == 32 else { throw CgkDeliveryError.badCgk }
        guard boxIdentityPub.count == 32 else { throw CgkDeliveryError.badBoxIdentityPub }
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: cgk, recipientEd25519Pub: boxIdentityPub)
        let delivery = Delivery(serverDomain: serverDomain, sealed: sealed, issuedAt: issuedAt)
        let signature = try sign(delivery, irk: irk)
        return (delivery, signature)
    }

    /// Phone side: turn a built delivery + signature into the hex carrier the
    /// deposit lane stores (the `sealed` field of the `purpose:"cgk"` deposit
    /// row). Byte-identical to the TS `cgkDeliveryToCarrierHex` so the box parses
    /// it.
    public static func carrierHex(delivery: Delivery, signature: Data) -> String {
        let obj: [String: Any] = [
            "serverDomain": delivery.serverDomain,
            "sealed": HexUtil.encode(delivery.sealed),
            "issuedAt": delivery.issuedAt,
            "signature": HexUtil.encode(signature),
        ]
        // The TS emits JSON.stringify key order = insertion order; the box
        // re-parses by field name and re-derives the canonical bytes, so key
        // ORDER is irrelevant to verification — only the values matter.
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
        return HexUtil.encode(data)
    }

    /// Build the full deposit body for `SecretMailboxClient.depositCgk`. The CGK
    /// is sealed to the box's REGISTERED identity pub (`stkPub` — its registered
    /// STK), the wrapper IRK-signed, and the carrier hex placed in
    /// `deposit.sealed`. The `auth`/`authSignature` are the SAME IRK
    /// mailbox-auth shape as every other phone-mailbox call. Reuses
    /// `PairingDepositBody` (the swk/cgk/pairing deposits share its shape).
    public static func buildDeposit(
        username: String,
        serverDomain: String,
        cgk: Data,
        boxIdentityPub: Data,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        mailboxNonce: Data = SecretRequestCoordinator.randomNonce(),
        depositNonce: Data = SecretRequestCoordinator.randomNonce()
    ) throws -> PairingDepositBody {
        let built = try build(
            serverDomain: serverDomain,
            cgk: cgk,
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
                // The deposit binds the box's REGISTERED STK = its identity pub.
                stkPub: HexUtil.encode(boxIdentityPub),
                sealed: carrier,
                issuedAt: now
            )
        )
    }
}
