import Foundation
import CryptoKit
import FlagshipCore

/// #28 — Swift mirror of the `AcmeAccountKeyGrant` envelope in
/// `packages/protocol/src/auth.ts` (`canonicalAcmeAccountKeyGrant` /
/// `signAcmeAccountKeyGrant` / `verifyAcmeAccountKeyGrant`).
///
/// The ACME account key is the authority to mint a user's `[<user>, *.<user>]`
/// TLS cert. It is held ONLY by admin-scope devices (and, opt-in, an
/// autonomous box), sealed to each recipient with `SecretSeal` and NEVER
/// UMK-derived, NEVER handed to `.com` in the clear. This envelope is the
/// IRK-signed carrier: the account root attests "this (already-sealed)
/// account key is granted to recipient R until `expiresAt`". A consumer
/// (the mint-coordination path) SEPARATELY confirms R holds the `admin`
/// DeviceScope before honoring a mint.
///
/// The canonical bytes + `|`-joined field order MUST match the Worker
/// byte-for-byte or `verifyAcmeAccountKeyGrant` on the server rejects the
/// mint. The cross-platform lock is pinned in `AcmeAccountKeyGrantTests`.
public struct AcmeAccountKeyGrant: Equatable, Sendable {
    /// `flagship/acme-account-key-grant/v1`, same tag the Worker uses.
    public static let canonicalTag = "flagship/acme-account-key-grant/v1"

    /// Generous bound for a sealed keypair, mirroring `MAX_SEALED_ACCOUNT_KEY`
    /// in auth.ts. The Worker re-checks this in its canonical-bytes pass.
    public static let maxSealedAccountKey = 4096

    public enum GrantError: Error, Equatable {
        case emptyField(String)
        case separatorInField(String)
        case controlCharInField(String)
        case expiryNotAfterIssue
        case recipientPubKeyNot32
        case sealedAccountKeyOutOfBounds
    }

    /// Fresh v4 UUID; consumers reject duplicates within the active window.
    public let grantId: String
    public let username: String
    /// sha256-hex of the ACME account PUBLIC key — a public reference shared
    /// by every grant of the same key. Rotation changes it.
    public let accountKeyId: String
    /// The recipient device's (box STK) Ed25519 pubkey, 32 bytes — the seal
    /// target. `SecretSeal.sealForEd25519Recipient` maps it to X25519.
    public let recipientPubKey: Data
    /// The ACME account key sealed to `recipientPubKey` (opaque ciphertext).
    public let sealedAccountKey: Data
    /// ms since epoch.
    public let issuedAt: Int64
    /// ms since epoch; re-seal before expiry.
    public let expiresAt: Int64

    public init(
        grantId: String,
        username: String,
        accountKeyId: String,
        recipientPubKey: Data,
        sealedAccountKey: Data,
        issuedAt: Int64,
        expiresAt: Int64
    ) {
        self.grantId = grantId
        self.username = username
        self.accountKeyId = accountKeyId
        self.recipientPubKey = recipientPubKey
        self.sealedAccountKey = sealedAccountKey
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    /// Reject the same malformed envelopes the Worker's
    /// `validateAcmeAccountKeyGrantFields` throws on, so we fail loudly on the
    /// phone rather than minting a grant `.com` will silently 403.
    public func validate() throws {
        let stringFields: [(String, String)] = [
            ("grantId", grantId),
            ("username", username),
            ("accountKeyId", accountKeyId),
        ]
        for (name, value) in stringFields {
            if value.isEmpty { throw GrantError.emptyField(name) }
            for scalar in value.unicodeScalars {
                let c = scalar.value
                if c == 0x7c { throw GrantError.separatorInField(name) }
                if c <= 0x1f || c == 0x7f { throw GrantError.controlCharInField(name) }
            }
        }
        if expiresAt <= issuedAt { throw GrantError.expiryNotAfterIssue }
        if recipientPubKey.count != 32 { throw GrantError.recipientPubKeyNot32 }
        if sealedAccountKey.isEmpty || sealedAccountKey.count > Self.maxSealedAccountKey {
            throw GrantError.sealedAccountKeyOutOfBounds
        }
    }

    /// `flagship/acme-account-key-grant/v1|grantId|username|accountKeyId|hex(recipientPubKey)|hex(sealedAccountKey)|issuedAt|expiresAt`.
    /// Hex is lowercase; integers are base-10. Matches
    /// `canonicalAcmeAccountKeyGrant` byte-for-byte.
    public func canonicalBytes() throws -> Data {
        try validate()
        return Data(
            [
                Self.canonicalTag,
                grantId,
                username,
                accountKeyId,
                HexUtil.encode(recipientPubKey),
                HexUtil.encode(sealedAccountKey),
                String(issuedAt),
                String(expiresAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign with the account's CURRENT IRK (the only key whose signature the
    /// cloud accepts as an attestation of this grant).
    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// Verify a signature under the account's IRK public key. Returns false
    /// (never throws) on malformed input, mirroring `verifyAcmeAccountKeyGrant`.
    public func verify(signature: Data, irkPub: Data) -> Bool {
        guard
            let bytes = try? canonicalBytes(),
            let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub)
        else { return false }
        return pub.isValidSignature(signature, for: bytes)
    }
}

/// #28 — the SEAL-TO-BOX producer: turn the device's local ACME account-key
/// scalar into an IRK-signed, box-sealed `AcmeAccountKeyGrant` ready to POST
/// to `.com`.
///
/// Flow (mirrors the TS daemon/control-plane mint side):
///   1. Re-hydrate the P-256 account key from its raw 32-byte scalar and
///      serialize it as a PKCS#8 PEM — the on-the-wire form the box feeds to
///      its ACME client.
///   2. Seal that PEM to the box's STK Ed25519 pubkey with `SecretSeal`
///      (`crypto_box_seal`-equivalent — only the box's STK can open it).
///   3. Derive the public `accountKeyId` (sha256-hex of the SEC1 pubkey).
///   4. Build the grant envelope and IRK-sign it.
///
/// The sealed key rides the grant; the PEM never leaves the device in the
/// clear and is never a response field. The IRK signature is what `.com`
/// verifies before storing.
public enum AcmeAccountKeyGrantProducer {
    public static let defaultTtlMs: Int64 = 90 * 86_400_000  // 90 days

    public enum ProducerError: Error, Equatable {
        case badStkPubKey
        case scalarNotP256
    }

    /// A built grant plus its IRK signature, ready for the mint POST.
    public struct SignedGrant: Equatable, Sendable {
        public let grant: AcmeAccountKeyGrant
        public let signature: Data
        public init(grant: AcmeAccountKeyGrant, signature: Data) {
            self.grant = grant
            self.signature = signature
        }
    }

    /// Build + IRK-sign a grant sealing the given ACME account-key SCALAR to a
    /// box STK Ed25519 pubkey.
    ///
    /// - Parameters:
    ///   - accountKeyScalar: the raw 32-byte P-256 private scalar
    ///     (`Keystore.acmeAccountKeyScalar()`).
    ///   - boxStkEd25519Pub: the recipient box's STK Ed25519 pubkey (32 bytes).
    ///   - username: the account username (lowercased by `.com`; pass as-is).
    ///   - irk: the account's IRK signing key.
    ///   - grantId: a fresh v4 UUID (defaults to a new one).
    ///   - issuedAt / expiresAt: ms-epoch window (defaults: now / now + 90d).
    public static func makeGrant(
        accountKeyScalar: Data,
        boxStkEd25519Pub: Data,
        username: String,
        irk: Curve25519.Signing.PrivateKey,
        grantId: String = UUID().uuidString,
        issuedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        expiresAt: Int64? = nil
    ) throws -> SignedGrant {
        guard boxStkEd25519Pub.count == 32 else { throw ProducerError.badStkPubKey }

        // 1. Re-hydrate the P-256 key + serialize the PKCS#8 PEM the box runs.
        let privateKey: P256.Signing.PrivateKey
        do {
            privateKey = try P256.Signing.PrivateKey(rawRepresentation: accountKeyScalar)
        } catch {
            throw ProducerError.scalarNotP256
        }
        let pem = privateKey.pemRepresentation
        let pemData = Data(pem.utf8)

        // 2. Seal the PEM to the box STK (Ed25519→X25519 → crypto_box_seal).
        let sealed = try SecretSeal.sealForEd25519Recipient(
            plaintext: pemData,
            recipientEd25519Pub: boxStkEd25519Pub
        )

        // 3. Public reference shared by every grant of this key.
        let accountKeyId = AcmeAccountKey.accountKeyId(publicKey: privateKey.publicKey)

        // 4. Build + IRK-sign.
        let grant = AcmeAccountKeyGrant(
            grantId: grantId,
            username: username,
            accountKeyId: accountKeyId,
            recipientPubKey: boxStkEd25519Pub,
            sealedAccountKey: sealed,
            issuedAt: issuedAt,
            expiresAt: expiresAt ?? (issuedAt + defaultTtlMs)
        )
        let signature = try grant.sign(with: irk)
        return SignedGrant(grant: grant, signature: signature)
    }
}
