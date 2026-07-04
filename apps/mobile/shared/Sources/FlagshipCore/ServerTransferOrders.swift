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
