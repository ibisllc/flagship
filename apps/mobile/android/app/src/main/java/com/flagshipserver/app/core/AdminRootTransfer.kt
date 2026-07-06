// Slice D — admin master-root TRANSFER hand-off proof (docs/device-admin-tier-spec.md
// §9.8). Kotlin mirror of packages/protocol/src/adminRootTransfer.ts.
//
// On transfer-a-box the acquirer's box re-homes to the acquirer's account, so it
// must re-pin the ACQUIRER's admin root — but the box only trusts its PINNED
// anchor (the giver's root), never `.com`'s word. So the GIVER's admin master
// root signs this hand-off (giver-root → acquirer-root, same old-signs-new shape
// as the AdminRootRotation §5 proof) and the box verifies it against its pinned
// anchor before re-pinning. An EMPTY newAdminRootPub means "unpin" — the
// acquirer account holds no admin root (legacy).
//
// Canonical bytes MUST stay byte-identical to the TS spine + the Swift twin:
//
//   flagship/admin-root-transfer/v1 | serverDomain | giverUsername
//     | acquirerUsername | oldAdminRootPubHex | newAdminRootPubHex
//     | transferNonce | issuedAt
//
// serverDomain is the box's OLD canonical (pre-re-home); all string fields but
// issuedAt are lowercased.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable

/** Mirror of the TS `AdminRootTransfer` interface. The pub hexes are lowercased
 *  (32 bytes each); `oldAdminRootPub` MUST equal the box's pinned anchor;
 *  `newAdminRootPub` may be "" (unpin). */
@Serializable
data class AdminRootTransfer(
    val serverDomain: String,
    val giverUsername: String,
    val acquirerUsername: String,
    val oldAdminRootPub: String,
    val newAdminRootPub: String,
    val transferNonce: String,
    val issuedAt: Long,
)

object AdminRootTransferClaim {
    const val CANONICAL_TAG = "flagship/admin-root-transfer/v1"

    fun canonicalBytes(
        serverDomain: String,
        giverUsername: String,
        acquirerUsername: String,
        oldAdminRootPubHex: String,
        newAdminRootPubHex: String,
        transferNonce: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        serverDomain.lowercase(),
        giverUsername.lowercase(),
        acquirerUsername.lowercase(),
        oldAdminRootPubHex.lowercase(),
        newAdminRootPubHex.lowercase(),
        transferNonce.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    fun canonicalBytes(t: AdminRootTransfer): ByteArray = canonicalBytes(
        t.serverDomain, t.giverUsername, t.acquirerUsername,
        t.oldAdminRootPub, t.newAdminRootPub, t.transferNonce, t.issuedAt,
    )

    /** Sign with the GIVER's admin master root (the anchor the box pins).
     *  Returns the 64-byte Ed25519 signature. */
    fun sign(t: AdminRootTransfer, giverAdminRoot: Ed25519Sign): ByteArray =
        giverAdminRoot.sign(canonicalBytes(t))

    /** Verify the proof against the GIVER's admin master root pubkey (32 bytes).
     *  Never throws — matches the TS try/catch verifier. */
    fun verify(t: AdminRootTransfer, signature: ByteArray, giverAdminRootPub: ByteArray): Boolean =
        try {
            Ed25519Verify(giverAdminRootPub).verify(signature, canonicalBytes(t))
            true
        } catch (_: Throwable) {
            false
        }
}
