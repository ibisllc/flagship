// Slice D — admin master-root rotation proof (docs/device-admin-tier-spec.md §5).
//
// Kotlin mirror of packages/protocol/src/adminRootRotation.ts. When credential
// recovery (or an owner-initiated "Rotate admin key") mints a fresh admin master
// root, the OLD admin root signs an `AdminRootRotation{ old → new }`. The box
// verifies the proof against its PINNED `adminRootPub` (the old root), then — and
// only then — re-pins to the new root. `.com` relays the proof but can never
// forge one (it lacks the old master root), which is exactly what lets the box
// adopt a relayed new root without trusting `.com`'s word.
//
// Canonical bytes MUST stay byte-identical to the TS spine + the Swift twin
// (cross-engine golden vector `admin-root-rotation` in
// test-vectors/canonical-bytes.json, asserted by CanonicalBytesVectorsTest):
//
//   flagship/admin-root-rotation/v1 | username | hex(oldAdminRootPub)
//     | hex(newAdminRootPub) | issuedAt
//
// ROTATION EXCLUDES OTHER ADMIN DEVICES (the revoke semantic, §4.3): once a box
// re-pins to the new root, any OTHER admin device that only held the OLD bare
// root can no longer sign a sensitive order the box accepts — it is effectively
// revoked. Grant-based admins are dropped via the grant-revocation path instead.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable

/** Mirror of the TS `AdminRootRotation` interface. The pubkeys are lowercased
 *  hex (32 bytes each); `oldAdminRootPub` MUST equal the box's pinned anchor. */
@Serializable
data class AdminRootRotation(
    val username: String,
    val oldAdminRootPub: String,
    val newAdminRootPub: String,
    val issuedAt: Long,
)

object AdminRootRotationClaim {
    const val CANONICAL_TAG = "flagship/admin-root-rotation/v1"

    fun canonicalBytes(
        username: String,
        oldAdminRootPubHex: String,
        newAdminRootPubHex: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        oldAdminRootPubHex.lowercase(),
        newAdminRootPubHex.lowercase(),
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    fun canonicalBytes(r: AdminRootRotation): ByteArray =
        canonicalBytes(r.username, r.oldAdminRootPub, r.newAdminRootPub, r.issuedAt)

    /** Sign with the OLD admin master root (the anchor the box already pins).
     *  Returns the 64-byte Ed25519 signature. */
    fun sign(r: AdminRootRotation, oldAdminRoot: Ed25519Sign): ByteArray =
        oldAdminRoot.sign(canonicalBytes(r))

    /** Verify the proof against the OLD admin master root pubkey (32 bytes).
     *  Never throws — matches the TS try/catch verifier. */
    fun verify(r: AdminRootRotation, signature: ByteArray, oldAdminRootPub: ByteArray): Boolean =
        try {
            Ed25519Verify(oldAdminRootPub).verify(signature, canonicalBytes(r))
            true
        } catch (_: Throwable) {
            false
        }
}
