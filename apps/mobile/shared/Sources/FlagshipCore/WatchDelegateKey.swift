import Foundation
import CryptoKit

/// Swift mirror of the `WatchDelegateKey` / `RevokeWatchDelegate` envelopes
/// in packages/protocol/src/auth.ts.
///
/// The watch-delegate key is a SEPARATE Ed25519 signing key that lets the
/// owner approve a server BOOT from the Apple Watch without a fresh iPhone
/// biometric prompt, while the IRK stays fully biometric-gated for every
/// destructive operation. The IRK *attests* the delegate by signing this
/// envelope; the cloud (and the boot worker) accept a delegate signature for
/// the boot-approval kind ONLY, and reject it for anything else.
///
/// The canonical bytes + `|`-joined field order MUST match the Worker
/// byte-for-byte or `verifyWatchDelegateKey` on the server fails. Scopes are
/// sorted by their fixed index before joining — for v1 there is only
/// `boot-approval`, but the sort keeps us wire-compatible if the set grows.
public struct WatchDelegateKeyEnvelope: Equatable, Sendable {
    /// `flagship/watch-delegate-key/v1`, same tag the Worker uses.
    public static let canonicalTag = "flagship/watch-delegate-key/v1"

    /// The single v1 scope. The cloud rejects a mint with any other scope.
    public static let bootApprovalScope = "boot-approval"

    /// Fresh v4 UUID; the storage primary key + revocation handle.
    public let grantId: String
    public let username: String
    /// The delegate's Ed25519 pubkey, lowercased hex (32 bytes → 64 chars).
    public let delegatePubKeyHex: String
    /// Authorized scopes — MUST be `["boot-approval"]` for v1.
    public let scopes: [String]
    /// ms since epoch.
    public let issuedAt: Int64
    /// ms since epoch; by convention issuedAt + 7d.
    public let expiresAt: Int64

    public init(
        grantId: String,
        username: String,
        delegatePubKeyHex: String,
        scopes: [String],
        issuedAt: Int64,
        expiresAt: Int64
    ) {
        self.grantId = grantId
        self.username = username
        self.delegatePubKeyHex = delegatePubKeyHex
        self.scopes = scopes
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    /// `flagship/watch-delegate-key/v1|<grantId>|<username>|<delegatePubHex>|<sortedScopes>|<issuedAt>|<expiresAt>`.
    /// Scopes are joined with `,` after a stable sort, matching the Worker's
    /// `canonicalWatchDelegateKey`.
    public func canonicalBytes() -> Data {
        let sortedScopes = scopes.sorted().joined(separator: ",")
        return Data(
            [
                Self.canonicalTag,
                grantId,
                username,
                delegatePubKeyHex.lowercased(),
                sortedScopes,
                String(issuedAt),
                String(expiresAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign with the account's CURRENT IRK (the only key whose signature the
    /// cloud accepts as an attestation of this delegate).
    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// Verify a signature under the account's IRK public key. Returns false
    /// (never throws) on malformed input, mirroring `verifyWatchDelegateKey`.
    public func verify(signature: Data, irkPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}

/// Swift mirror of `RevokeWatchDelegate` — the IRK-signed "stop allowing the
/// Watch to approve" envelope. Dropping the delegate's authority does NOT
/// touch the IRK.
public struct RevokeWatchDelegateEnvelope: Equatable, Sendable {
    public static let canonicalTag = "flagship/revoke-watch-delegate/v1"

    public let grantId: String
    public let username: String
    public let issuedAt: Int64

    public init(grantId: String, username: String, issuedAt: Int64) {
        self.grantId = grantId
        self.username = username
        self.issuedAt = issuedAt
    }

    /// `flagship/revoke-watch-delegate/v1|<grantId>|<username>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, grantId, username, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    public func verify(signature: Data, irkPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}
