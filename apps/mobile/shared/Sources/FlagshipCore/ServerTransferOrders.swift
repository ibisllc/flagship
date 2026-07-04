import Foundation
import CryptoKit

/// Transfer-a-box orders — the Swift mirror of the `server-transfer-offer` +
/// `server-transfer-claim` envelopes in `packages/protocol/src/legacyEnvelopes.ts`
/// (docs/account-deletion-and-name-reclaim.md §4).
///
/// Cross-account ownership handoff, two parties / two envelopes:
///  - `server-transfer-offer` is minted by the CURRENT owner's phone (giver IRK)
///    and encoded into the QR shown on the box's detail page. It does NOT name
///    the acquirer (unknown until they scan); it commits only to the box + a
///    one-time short-TTL nonce.
///  - `server-transfer-claim` is minted by the ACQUIRER's phone (acquirer IRK)
///    after scanning, binding the acquirer's identity (username + IRK pub) to
///    the offer's nonce so `.com` moves ownership to a SPECIFIC new account.
///
/// Canonical bytes (byte-identical to TS + the Kotlin mirror):
///
///   flagship/server-transfer-offer/v1|<serverDomain>|<transferNonce>|<issuedAt>|<expiresAt>
///   flagship/server-transfer-claim/v2|<serverDomain>|<transferNonce>|<acquirerUsername>|<acquirerIrkPubHex>|<acquirerAdminRootPubHex or "">|<issuedAt>
///
/// `serverDomain`, `transferNonce`, and `acquirerUsername` are lowercased into
/// the canonical bytes (matching the TS `.toLowerCase()`).
public struct ServerTransferOfferOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-transfer-offer/v1"

    public let serverDomain: String
    public let transferNonce: String
    public let issuedAt: Int64
    public let expiresAt: Int64

    public init(serverDomain: String, transferNonce: String, issuedAt: Int64, expiresAt: Int64) {
        self.serverDomain = serverDomain
        self.transferNonce = transferNonce
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverDomain.lowercased(),
                transferNonce.lowercased(),
                String(issuedAt),
                String(expiresAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }
}

public struct ServerTransferClaimOrder: Equatable, Sendable {
    /// v2 (spec §9.8): the claim canonical now COMMITS to the acquirer's admin
    /// master root pub, so `.com` can't substitute a different anchor for the
    /// box to re-pin — the acquirer's own signature covers it. Empty string ⇒
    /// the acquirer account has no admin root (legacy).
    public static let canonicalTag = "flagship/server-transfer-claim/v2"

    public let serverDomain: String
    public let transferNonce: String
    public let acquirerUsername: String
    /// The acquirer's owner IRK pubkey, hex — ownership re-binds to this.
    public let acquirerIrkPubHex: String
    /// The acquirer's admin master root pubkey, hex — the anchor the box
    /// re-pins on re-home. "" when the acquirer account has no admin root.
    public let acquirerAdminRootPubHex: String
    public let issuedAt: Int64

    public init(serverDomain: String, transferNonce: String, acquirerUsername: String, acquirerIrkPubHex: String, acquirerAdminRootPubHex: String = "", issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.transferNonce = transferNonce
        self.acquirerUsername = acquirerUsername
        self.acquirerIrkPubHex = acquirerIrkPubHex
        self.acquirerAdminRootPubHex = acquirerAdminRootPubHex
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverDomain.lowercased(),
                transferNonce.lowercased(),
                acquirerUsername.lowercased(),
                acquirerIrkPubHex.lowercased(),
                acquirerAdminRootPubHex.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }
}

/// v1-sec GAP 3 — the LEGACY (no-admin-root) re-home authorization. Swift mirror
/// of the spine's `flagship/server-rehome-auth/v1` envelope; the canonical bytes
/// MUST match the TS `signRehomeAuthorization` byte-for-byte or the box-side
/// verify against its pinned owner IRK fails.
///
/// A box with NO pinned admin master root re-homes ONLY on this proof, signed by
/// the GIVER's owner IRK (the box's config-pinned owner IRK until it re-homes),
/// naming the acquirer explicitly. The box verifies it against its pin before
/// writing the re-home marker; `.com` relays it but cannot forge it. The
/// admin-tier path keeps its stronger `AdminRootTransfer` proof instead.
///
/// Canonical bytes (`|`-separated), matching TS `hex()` (lowercase) exactly:
///   flagship/server-rehome-auth/v1 | oldServerDomain | newServerDomain
///     | acquirerIrkPubHex | issuedAt
public struct RehomeAuthorizationOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/server-rehome-auth/v1"

    /// The box's OLD canonical FQDN (`<server>.<giver>.<apex>`).
    public let oldServerDomain: String
    /// The NEW canonical FQDN to re-home to (`<server>.<acquirer>.<apex>`).
    public let newServerDomain: String
    /// The acquirer's owner-IRK pubkey, lowercase hex — ownership re-binds to this.
    public let acquirerIrkPubHex: String
    public let issuedAt: Int64

    public init(oldServerDomain: String, newServerDomain: String, acquirerIrkPubHex: String, issuedAt: Int64) {
        self.oldServerDomain = oldServerDomain
        self.newServerDomain = newServerDomain
        self.acquirerIrkPubHex = acquirerIrkPubHex
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                oldServerDomain.lowercased(),
                newServerDomain.lowercased(),
                acquirerIrkPubHex.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign with the GIVER's owner IRK (the anchor the box pins today).
    public func sign(withGiverIrk key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// Verify against the giver's owner-IRK pubkey (the box's pinned anchor).
    /// Returns false (never throws) on a malformed key/signature.
    public func verify(signature: Data, giverIrkPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: giverIrkPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}
