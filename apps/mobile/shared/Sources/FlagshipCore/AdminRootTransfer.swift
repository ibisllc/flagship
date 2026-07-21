import Foundation
import CryptoKit

/// Slice D §9.8 — the transfer-a-box admin-root hand-off proof. Swift mirror of
/// the spine's `flagship/admin-root-transfer/v1` envelope; the canonical bytes
/// MUST match the TS engine byte-for-byte or the box-side verify against its
/// pinned `adminRootPub` fails.
///
/// On a transfer the box is re-homed to the ACQUIRER's account, so it must
/// re-pin the acquirer's admin master root — but the box must NOT take `.com`'s
/// word for a new authority anchor (same rule as rotation, §5). The GIVER's
/// admin master root (the box's currently-pinned anchor) signs this hand-off;
/// the box verifies the proof against its pin, then — and only then — re-pins
/// to `newAdminRootPubHex`. `.com` relays the proof but can never forge one.
///
/// `newAdminRootPubHex == ""` means UNPIN: the acquirer account has no admin
/// root (legacy), so the box re-homes with no authority anchor.
///
/// Canonical bytes (field-guarded, `|`-separated), matching TS `hex()`
/// (lowercase) exactly:
///   flagship/admin-root-transfer/v1 | serverDomain | giverUsername
///     | acquirerUsername | oldAdminRootPubHex | newAdminRootPubHex
///     | transferNonce | issuedAt
public struct AdminRootTransfer: Equatable, Sendable {
    /// `flagship/admin-root-transfer/v1`, the same tag the spine uses.
    public static let canonicalTag = "flagship/admin-root-transfer/v1"

    /// The box's OLD canonical (the transferred server's current domain).
    public let serverDomain: String
    public let giverUsername: String
    public let acquirerUsername: String
    /// The giver's admin root — must equal the box's pinned anchor, lowercase hex.
    public let oldAdminRootPubHex: String
    /// The acquirer's admin root the box re-pins to, lowercase hex; "" ⇒ unpin.
    public let newAdminRootPubHex: String
    public let transferNonce: String
    public let issuedAt: Int64

    public init(
        serverDomain: String,
        giverUsername: String,
        acquirerUsername: String,
        oldAdminRootPubHex: String,
        newAdminRootPubHex: String,
        transferNonce: String,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.giverUsername = giverUsername
        self.acquirerUsername = acquirerUsername
        self.oldAdminRootPubHex = oldAdminRootPubHex
        self.newAdminRootPubHex = newAdminRootPubHex
        self.transferNonce = transferNonce
        self.issuedAt = issuedAt
    }

    /// `flagship/admin-root-transfer/v1|<serverDomain>|<giverUsername>|<acquirerUsername>|<oldPubHex>|<newPubHex or "">|<transferNonce>|<issuedAt>`,
    /// every string field lowercased (usernames/domains/hex never carry `|`).
    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                serverDomain.lowercased(),
                giverUsername.lowercased(),
                acquirerUsername.lowercased(),
                oldAdminRootPubHex.lowercased(),
                newAdminRootPubHex.lowercased(),
                transferNonce.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign with the GIVER's admin master root (the anchor the box pins today).
    public func sign(withGiverAdminRoot key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// Verify the proof against the GIVER's admin root pubkey (the pinned
    /// anchor). Returns false (never throws) on a malformed key/signature,
    /// mirroring the TS verifier.
    public func verify(signature: Data, giverAdminRootPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: giverAdminRootPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}
