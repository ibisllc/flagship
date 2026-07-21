// Kotlin mirror of the WatchDelegateKey / RevokeWatchDelegate envelopes in
// packages/protocol/src/auth.ts (and FlagshipCore/WatchDelegateKey.swift).
//
// The watch-delegate key is a SEPARATE Ed25519 signing key that lets the owner
// approve a server BOOT from a watch without a fresh phone biometric prompt,
// while the IRK stays fully biometric-gated for every destructive operation.
// The IRK *attests* the delegate by signing this envelope; the cloud + boot
// worker accept a delegate signature for the boot-approval kind ONLY.
//
// The canonical bytes + `|`-joined field order MUST match the Worker
// byte-for-byte or server verification fails. Scopes are sorted by their
// FIXED INDEX (DELEGATE_SCOPES order, NOT alphabetical) before the comma-join
// — for v1 there is only "boot-approval", but the index sort keeps us
// wire-compatible if the set ever grows (an alphabetical sort would re-shuffle
// the order when a new scope name lands and invalidate prior audit vectors —
// see canonicalWatchDelegateKey in packages/protocol/src/auth.ts).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify

/** Canonical scope ordering shared by the capability/delegate envelopes.
 *
 *  Flagship canonical bytes sort scope lists by their FIXED INDEX in the
 *  authoritative scope list (NOT alphabetically) so a future scope name can
 *  never re-shuffle an alphabetical sort and invalidate prior audit vectors
 *  (mirrors DEVICE_SCOPE_INDEX / DELEGATE_SCOPE_INDEX in
 *  packages/protocol/src/auth.ts). An unknown scope (one absent from the list)
 *  sorts as index 0 — byte-identical to the Worker's `?? 0` fallback; in
 *  practice the envelope validators reject unknown scopes before this. */
object ScopeOrdering {
    fun sort(scopes: List<String>, order: List<String>): List<String> {
        val index = order.withIndex().associate { (i, s) -> s to i }
        // sortedBy is a STABLE sort, so equal/unknown (index 0) entries keep
        // their input order — matching JS Array.prototype.sort on equal keys.
        return scopes.sortedBy { index[it] ?: 0 }
    }
}

object WatchDelegateKey {
    const val CANONICAL_TAG = "flagship/watch-delegate-key/v1"

    /** The single v1 scope. The cloud rejects a mint with any other scope. */
    const val BOOT_APPROVAL_SCOPE = "boot-approval"

    /** Canonical scope ordering — mirrors DELEGATE_SCOPES in
     *  packages/protocol/src/auth.ts. APPEND new scopes; never reorder. */
    val DELEGATE_SCOPE_ORDER: List<String> = listOf("boot-approval")

    fun canonicalBytes(
        grantId: String,
        username: String,
        delegatePubKeyHex: String,
        scopes: List<String>,
        issuedAt: Long,
        expiresAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        grantId,
        username,
        delegatePubKeyHex.lowercase(),
        ScopeOrdering.sort(scopes, DELEGATE_SCOPE_ORDER).joinToString(","),
        issuedAt.toString(),
        expiresAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Sign with the account's CURRENT IRK (the only attesting key the cloud
     *  accepts). */
    fun sign(
        irk: Ed25519Sign,
        grantId: String,
        username: String,
        delegatePubKeyHex: String,
        scopes: List<String>,
        issuedAt: Long,
        expiresAt: Long,
    ): ByteArray = irk.sign(
        canonicalBytes(grantId, username, delegatePubKeyHex, scopes, issuedAt, expiresAt)
    )

    /** Verify a signature under the account IRK public key. Returns false
     *  (never throws) on malformed input, mirroring verifyWatchDelegateKey. */
    fun verify(
        signature: ByteArray,
        irkPub: ByteArray,
        grantId: String,
        username: String,
        delegatePubKeyHex: String,
        scopes: List<String>,
        issuedAt: Long,
        expiresAt: Long,
    ): Boolean = try {
        Ed25519Verify(irkPub).verify(
            signature,
            canonicalBytes(grantId, username, delegatePubKeyHex, scopes, issuedAt, expiresAt),
        )
        true
    } catch (_: Throwable) {
        false
    }
}

object RevokeWatchDelegate {
    const val CANONICAL_TAG = "flagship/revoke-watch-delegate/v1"

    fun canonicalBytes(grantId: String, username: String, issuedAt: Long): ByteArray =
        listOf(CANONICAL_TAG, grantId, username, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)

    fun sign(irk: Ed25519Sign, grantId: String, username: String, issuedAt: Long): ByteArray =
        irk.sign(canonicalBytes(grantId, username, issuedAt))

    fun verify(
        signature: ByteArray,
        irkPub: ByteArray,
        grantId: String,
        username: String,
        issuedAt: Long,
    ): Boolean = try {
        Ed25519Verify(irkPub).verify(signature, canonicalBytes(grantId, username, issuedAt))
        true
    } catch (_: Throwable) {
        false
    }
}

/** Kotlin mirror of `canonicalDeviceCapabilityGrant` in
 *  packages/protocol/src/auth.ts. The grant binds a per-device key to a user
 *  under an opaque account-scoped device ID with explicit capability scopes.
 *
 *  Grants are minted + signed by the Worker (admin path) today, so the mobile
 *  app only RECEIVES them as the read-only DeviceCapabilityBlock wire DTO.
 *  This canonical-bytes mirror exists so a device CAN locally recompute /
 *  verify a grant's bytes — and, critically, so the cross-platform parity
 *  vector pins the SAME byte layout the Worker signs. The scope list is sorted
 *  by FIXED INDEX (DEVICE_SCOPES order, NOT alphabetical); an alphabetical
 *  sort diverges for any set spanning add-device/admin/browse. */
object DeviceCapabilityGrant {
    const val CANONICAL_TAG = "flagship/device-capability-grant/v2"

    /** Canonical scope ordering — mirrors DEVICE_SCOPES in
     *  packages/protocol/src/auth.ts. APPEND new scopes; never reorder. The
     *  index in this list is the canonical-bytes sort key (NOT alphabetical). */
    val DEVICE_SCOPE_ORDER: List<String> = listOf(
        "browse",
        "install-service",
        "vibe-code",
        "add-device",
        "manage-services",
        "revoke-others",
        "demo-provision",
        "admin",
        "view-directory",
    )

    fun canonicalBytes(
        grantId: String,
        username: String,
        deviceId: String,
        devicePubKeyHex: String,
        scopes: List<String>,
        issuedAt: Long,
        expiresAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        grantId,
        username,
        deviceId,
        devicePubKeyHex.lowercase(),
        ScopeOrdering.sort(scopes, DEVICE_SCOPE_ORDER).joinToString(","),
        issuedAt.toString(),
        expiresAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Verify a signature under the account IRK public key. Returns false
     *  (never throws) on malformed input, mirroring verifyDeviceCapabilityGrant. */
    fun verify(
        signature: ByteArray,
        irkPub: ByteArray,
        grantId: String,
        username: String,
        deviceId: String,
        devicePubKeyHex: String,
        scopes: List<String>,
        issuedAt: Long,
        expiresAt: Long,
    ): Boolean = try {
        Ed25519Verify(irkPub).verify(
            signature,
            canonicalBytes(grantId, username, deviceId, devicePubKeyHex, scopes, issuedAt, expiresAt),
        )
        true
    } catch (_: Throwable) {
        false
    }
}
