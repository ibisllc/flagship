// Kotlin mirror of the UploadRecoveryRecord canonical in
// packages/protocol/src/auth.ts (canonicalUploadRecoveryRecord) +
// packages/control-plane/src/webauthnRecovery.ts handleUploadWebauthnRecovery.
//
// Cloud recovery upload is IRK-SIGNED. The wire body is
//   { request: { username, credentialId, wrappedUmk, issuedAt,
//                 wrappedAcmeAccountKey? }, signature }
// and the Worker base64-decodes `wrappedUmk` → bytes, computes
//   wrappedUmkHashHex = sha256hex(bytes)
// then verifies `signature` (hex, ed25519 by the account IRK) over the
// canonical bytes below. The signature commits to the HASH of the
// ciphertext (not the ciphertext itself) so the canonical stays small,
// while .com still re-derives the hash from the bytes on the wire and
// rejects any attacker-substituted ciphertext.
//
// The canonical `|`-joined field order MUST match the Worker byte-for-byte
// or server verification fails. `wrappedAcmeAccountKey` is ciphertext only
// and is NOT part of the canonical (tampering breaks account-key recovery
// but can never forge it).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import java.security.MessageDigest

object RecoveryUpload {
    const val CANONICAL_TAG = "flagship/upload-recovery-record/v1"

    /** Canonical bytes the account IRK signs over. Mirrors
     *  canonicalUploadRecoveryRecord in @flagship/protocol:
     *  `tag|username|credentialId|wrappedUmkHashHex|issuedAt`. */
    fun canonicalBytes(
        username: String,
        credentialId: String,
        wrappedUmkHashHex: String,
        issuedAt: Long,
    ): ByteArray = listOf(
        CANONICAL_TAG,
        username,
        credentialId,
        wrappedUmkHashHex,
        issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Sign with the account's CURRENT IRK — the only key whose pubkey the
     *  Worker looks up (from the usernames row) to verify the upload. */
    fun sign(
        irk: Ed25519Sign,
        username: String,
        credentialId: String,
        wrappedUmkHashHex: String,
        issuedAt: Long,
    ): ByteArray = irk.sign(
        canonicalBytes(username, credentialId, wrappedUmkHashHex, issuedAt),
    )

    /** Lowercase sha256-hex of the raw wrapped-UMK ciphertext bytes — the
     *  exact value the Worker recomputes from `wrappedUmk` (after base64
     *  decode) and checks the signature against. */
    fun wrappedUmkHashHex(wrappedUmkBytes: ByteArray): String =
        HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(wrappedUmkBytes))
}
