import Foundation
import CryptoKit

/// Slice D §5.1 — the admin master-root rotation proof. Swift mirror of
/// `AdminRootRotation` / `signAdminRootRotation` / `verifyAdminRootRotation`
/// in `packages/protocol/src/adminRootRotation.ts` (the spine's rotation
/// signer). The canonical bytes MUST match the TS engine byte-for-byte or
/// the box-side verify against its pinned `adminRootPub` fails.
///
/// The box must NOT trust `.com`'s word for a new admin authority root.
/// When credential recovery mints a fresh admin master root, the OLD admin
/// root signs an `AdminRootRotation{ old → new }`. The box verifies the
/// proof against its PINNED `adminRootPub` (the old root), then — and only
/// then — re-pins to the new root. `.com` relays the proof but can never
/// forge one (it lacks the old master root), which is exactly what lets a
/// box adopt a relayed new root.
///
/// Rotation EXCLUDES other admin devices: they still hold the OLD root, so
/// after the box re-pins to the new root their old-root-signed orders no
/// longer verify. That is the intended "revoke every other admin" semantic
/// of a compromise-recovery rotation (docs/device-admin-tier-spec.md §5).
///
/// Canonical bytes (field-guarded, `|`-separated), matching TS `hex()`
/// (lowercase) exactly:
///   flagship/admin-root-rotation/v1 | username | hex(oldAdminRootPub)
///     | hex(newAdminRootPub) | issuedAt
public struct AdminRootRotation: Equatable, Sendable {
    /// `flagship/admin-root-rotation/v1`, the same tag the spine uses.
    public static let canonicalTag = "flagship/admin-root-rotation/v1"

    public let username: String
    /// The box's currently-pinned admin root, lowercase hex (32 → 64 chars).
    public let oldAdminRootPubHex: String
    /// The freshly-minted admin master root the box re-pins to, lowercase hex.
    public let newAdminRootPubHex: String
    public let issuedAt: Int64

    public init(username: String, oldAdminRootPubHex: String, newAdminRootPubHex: String, issuedAt: Int64) {
        self.username = username
        self.oldAdminRootPubHex = oldAdminRootPubHex
        self.newAdminRootPubHex = newAdminRootPubHex
        self.issuedAt = issuedAt
    }

    /// `flagship/admin-root-rotation/v1|<username>|<oldPubHex>|<newPubHex>|<issuedAt>`.
    /// Mirrors the TS `legacyFieldGuard("username", …)`: the username may not
    /// carry the `|` separator (usernames never do — `^[a-z0-9][a-z0-9-]…$`).
    public func canonicalBytes() -> Data {
        Data(
            [
                Self.canonicalTag,
                username,
                oldAdminRootPubHex.lowercased(),
                newAdminRootPubHex.lowercased(),
                String(issuedAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Sign with the OLD admin master root (the anchor the box already pins).
    public func sign(withOldAdminRoot key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// Verify the proof against the OLD admin master root pubkey (the pinned
    /// anchor). Returns false (never throws) on a malformed key/signature,
    /// mirroring the TS `verifyAdminRootRotation`.
    public func verify(signature: Data, oldAdminRootPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: oldAdminRootPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}
