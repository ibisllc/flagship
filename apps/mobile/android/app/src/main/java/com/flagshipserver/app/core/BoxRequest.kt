package com.flagshipserver.app.core

/** One typed thing a box is asking its owner to approve — the unified Box
 *  Request Inbox primitive (docs/box-request-inbox.md). Mirrors the backend's
 *  cheap, unauthenticated `/pods` `pendingRequests` digest entry and iOS
 *  `FlagshipCore.BoxRequest`. `type` is the secret-request `purpose`, so
 *  `unlock-key` and `entitlement` are two values of ONE inbox rather than two
 *  parallel sets. New request types later are one more `type`, no new plumbing. */
data class BoxRequest(
    /** requestNonceHex — the box's reply is keyed by (serverDomain, this). */
    val nonceHex: String,
    /** Which box (the pod fqdn / serverDomain). */
    val serverDomain: String,
    /** The secret-request purpose. Unknown/future purposes a not-yet-updated
     *  client can't satisfy are dropped at the channel boundary, so this is the
     *  strongly-typed known set. */
    val type: SecretPurpose,
    /** issuedAt from the signed SecretRequest (ms). */
    val issuedAt: Long,
    /** Row TTL (ms). */
    val expiresAt: Long,
) {
    /** Stable identity = (serverDomain, nonce) — the same key the response is
     *  addressed by, so a satisfied request de-dups cleanly. */
    val id: String get() = "${serverDomain.lowercase()}#$nonceHex"
}
