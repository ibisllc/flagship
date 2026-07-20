import Foundation
import CryptoKit

/// Canonical scope ordering shared by the capability/delegate envelopes.
///
/// Flagship canonical bytes sort scope lists by their FIXED INDEX in the
/// authoritative scope list (NOT alphabetically) so a future scope name can
/// never re-shuffle an alphabetical sort and invalidate prior audit vectors
/// (mirrors `DEVICE_SCOPE_INDEX` / `DELEGATE_SCOPE_INDEX` in
/// packages/protocol/src/auth.ts). An unknown scope (one absent from the
/// list) sorts as index 0 — byte-identical to the Worker's `?? 0` fallback;
/// in practice the envelope validators reject unknown scopes before this.
public enum ScopeOrdering {
    public static func sort(_ scopes: [String], by order: [String]) -> [String] {
        var index: [String: Int] = [:]
        for (i, s) in order.enumerated() { index[s] = i }
        // A stable sort keyed only on the index keeps equal/unknown (index 0)
        // entries in input order, matching JS Array.prototype.sort on equal keys.
        return scopes.enumerated()
            .sorted { lhs, rhs in
                let li = index[lhs.element] ?? 0
                let ri = index[rhs.element] ?? 0
                if li != ri { return li < ri }
                return lhs.offset < rhs.offset
            }
            .map { $0.element }
    }
}

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
/// sorted by their FIXED INDEX (`DELEGATE_SCOPES` order, NOT alphabetical)
/// before joining — for v1 there is only `boot-approval`, but the index sort
/// keeps us wire-compatible if the set grows (an alphabetical sort would
/// re-shuffle the order when a new scope name lands and invalidate prior
/// audit vectors — see canonicalWatchDelegateKey in packages/protocol).
public struct WatchDelegateKeyEnvelope: Equatable, Sendable {
    /// `flagship/watch-delegate-key/v1`, same tag the Worker uses.
    public static let canonicalTag = "flagship/watch-delegate-key/v1"

    /// The single v1 scope. The cloud rejects a mint with any other scope.
    public static let bootApprovalScope = "boot-approval"

    /// Canonical scope ordering — mirrors `DELEGATE_SCOPES` in
    /// packages/protocol/src/auth.ts. APPEND new scopes; never reorder. The
    /// index in this list is the canonical-bytes sort key (NOT alphabetical).
    public static let delegateScopeOrder: [String] = ["boot-approval"]

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
    /// Scopes are joined with `,` after a FIXED-INDEX sort (NOT alphabetical),
    /// matching the Worker's `canonicalWatchDelegateKey`.
    public func canonicalBytes() -> Data {
        let sortedScopes = ScopeOrdering
            .sort(scopes, by: Self.delegateScopeOrder)
            .joined(separator: ",")
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

/// Swift mirror of `canonicalDeviceCapabilityGrant` in
/// packages/protocol/src/auth.ts. The grant binds a per-device key to a user
/// under an opaque account-scoped device ID with explicit capability scopes.
///
/// Grants are minted + signed by the Worker (admin path) today, so the mobile
/// app only RECEIVES them as the read-only `DeviceCapabilityBlock` wire DTO.
/// This canonical-bytes mirror exists so a device CAN locally recompute /
/// verify a grant's bytes — and, critically, so the cross-platform parity
/// vector pins the SAME byte layout the Worker signs. The scope list is sorted
/// by FIXED INDEX (`DEVICE_SCOPES` order, NOT alphabetical); an alphabetical
/// sort diverges for any set spanning `add-device`/`admin`/`browse`.
public struct DeviceCapabilityGrantEnvelope: Equatable, Sendable {
    public static let canonicalTag = "flagship/device-capability-grant/v2"

    /// Canonical scope ordering — mirrors `DEVICE_SCOPES` in
    /// packages/protocol/src/auth.ts. APPEND new scopes; never reorder. The
    /// index in this list is the canonical-bytes sort key (NOT alphabetical).
    public static let deviceScopeOrder: [String] = [
        "browse",
        "install-service",
        "vibe-code",
        "add-device",
        "manage-services",
        "revoke-others",
        "demo-provision",
        "admin",
        "view-directory",
    ]

    public let grantId: String
    public let username: String
    public let deviceId: String
    /// The device's Ed25519 pubkey, lowercased hex (32 bytes → 64 chars).
    public let devicePubKeyHex: String
    public let scopes: [String]
    public let issuedAt: Int64
    public let expiresAt: Int64

    public init(
        grantId: String,
        username: String,
        deviceId: String,
        devicePubKeyHex: String,
        scopes: [String],
        issuedAt: Int64,
        expiresAt: Int64
    ) {
        self.grantId = grantId
        self.username = username
        self.deviceId = deviceId
        self.devicePubKeyHex = devicePubKeyHex
        self.scopes = scopes
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    /// `flagship/device-capability-grant/v2|<grantId>|<username>|<deviceId>|<devicePubHex>|<sortedScopes>|<issuedAt>|<expiresAt>`.
    public func canonicalBytes() -> Data {
        let sortedScopes = ScopeOrdering
            .sort(scopes, by: Self.deviceScopeOrder)
            .joined(separator: ",")
        return Data(
            [
                Self.canonicalTag,
                grantId,
                username,
                deviceId,
                devicePubKeyHex.lowercased(),
                sortedScopes,
                String(issuedAt),
                String(expiresAt),
            ].joined(separator: "|").utf8
        )
    }

    /// Verify a signature under the account IRK public key. Returns false
    /// (never throws) on malformed input, mirroring `verifyDeviceCapabilityGrant`.
    public func verify(signature: Data, irkPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}
