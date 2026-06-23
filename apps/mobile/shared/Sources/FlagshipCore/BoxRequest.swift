import Foundation

/// One typed thing a box is asking its owner to approve — the unified Box
/// Request Inbox primitive (docs/box-request-inbox.md). Mirrors the backend's
/// cheap, unauthenticated `/pods` `pendingRequests` digest entry. `type` is the
/// secret-request `purpose`, so `unlock-key` and `entitlement` are two values of
/// ONE inbox rather than two parallel sets. New request types later (transfer-
/// confirm, content-wipe ack, …) are one more `type` value, no new plumbing.
public struct BoxRequest: Equatable, Hashable, Sendable, Identifiable {
    /// requestNonceHex — the box's reply is keyed by (serverDomain, this).
    public let nonceHex: String
    /// Which box (the pod fqdn / serverDomain).
    public let serverDomain: String
    /// The secret-request purpose. Unknown/future purposes a not-yet-updated
    /// client can't satisfy are dropped at the channel boundary, so this is the
    /// strongly-typed known set.
    public let type: SecretPurpose
    /// issuedAt from the signed SecretRequest (ms).
    public let issuedAt: Int64
    /// Row TTL (ms).
    public let expiresAt: Int64

    public init(
        nonceHex: String,
        serverDomain: String,
        type: SecretPurpose,
        issuedAt: Int64,
        expiresAt: Int64
    ) {
        self.nonceHex = nonceHex
        self.serverDomain = serverDomain
        self.type = type
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    /// Stable identity = (serverDomain, nonce) — the same key the response is
    /// addressed by, so a satisfied request de-dups cleanly.
    public var id: String { "\(serverDomain.lowercased())#\(nonceHex)" }
}
