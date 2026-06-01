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
// byte-for-byte or server verification fails. Scopes are sorted before the
// comma-join — for v1 there is only "boot-approval", but the sort keeps us
// wire-compatible if the set ever grows.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify

object WatchDelegateKey {
    const val CANONICAL_TAG = "flagship/watch-delegate-key/v1"

    /** The single v1 scope. The cloud rejects a mint with any other scope. */
    const val BOOT_APPROVAL_SCOPE = "boot-approval"

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
        scopes.sorted().joinToString(","),
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
