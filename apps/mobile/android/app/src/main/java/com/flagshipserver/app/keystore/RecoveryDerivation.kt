// Passphrase → (fetchToken, prfSalt) derivation for WebAuthn-PRF cloud
// recovery. CANONICAL reference is the webapp sub-origin
// apps/web/public/recovery/recovery.js (derivePassphraseSecrets) — this
// MUST mirror it byte-for-byte so a passphrase enrolled on one surface
// recovers on any other.
//
//   salt       = utf8("flagship.recovery.argon2.v1|" + username.lowercase())
//   masterKey  = Argon2id(passphrase_utf8, salt, t=3, m=46*1024 KiB, p=1, dkLen=32)
//   fetchToken = HKDF-SHA256(ikm=masterKey, salt=<empty>,
//                            info=utf8("flagship.recovery.fetch.v1"), L=32)
//   prfSalt    = HKDF-SHA256(ikm=masterKey, salt=<empty>,
//                            info=utf8("flagship.recovery.salt.v1"), L=32)
//
// The two halves are domain-separated: fetchToken (its SHA-256) gates the
// .com ciphertext release; prfSalt feeds the WebAuthn `prf.eval.first`
// input and never leaves the device. Argon2id at 46 MiB takes ~1-2s — the
// flow is rare, so callers should run it off the main thread.
//
// Argon2id uses BouncyCastle's Argon2BytesGenerator (version 1.3 = the
// noble-hashes / RFC 9106 default), the SAME generator Keyfile.kt uses.

package com.flagshipserver.app.keystore

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

object RecoveryDerivation {
    /** Argon2id cost params — must equal recovery.js's ARGON2_* constants.
     *  m is in KiB (46 MiB), matching noble's `m` (it takes KiB too). */
    const val ARGON2_M_KB = 46 * 1024 // 46 MiB
    const val ARGON2_T = 3
    const val ARGON2_P = 1
    const val ARGON2_KEY_BYTES = 32

    /** Argon2 salt namespace — joined to the lowercased username with `|`,
     *  matching recovery.js's `${ARGON2_SALT_TAG}|${username.toLowerCase()}`. */
    const val ARGON2_SALT_TAG = "flagship.recovery.argon2.v1"

    private val FETCH_TOKEN_INFO = "flagship.recovery.fetch.v1".toByteArray(Charsets.UTF_8)
    private val PRF_SALT_INFO = "flagship.recovery.salt.v1".toByteArray(Charsets.UTF_8)

    /** The two passphrase-derived secrets. Both are 32-byte arrays. */
    data class PassphraseSecrets(val fetchToken: ByteArray, val prfSalt: ByteArray) {
        // value-semantics equals/hashCode so assertions on the data class
        // itself behave (arrays don't get structural equality for free).
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is PassphraseSecrets) return false
            return fetchToken.contentEquals(other.fetchToken) &&
                prfSalt.contentEquals(other.prfSalt)
        }

        override fun hashCode(): Int =
            31 * fetchToken.contentHashCode() + prfSalt.contentHashCode()
    }

    /**
     * Argon2id over [passphrase] (salt = the lowercased [username]) → a
     * 32-byte master key, HKDF-split into (fetchToken, prfSalt). Mirrors
     * recovery.js's derivePassphraseSecrets byte-for-byte.
     */
    fun derivePassphraseSecrets(passphrase: String, username: String): PassphraseSecrets {
        val salt = "$ARGON2_SALT_TAG|${username.lowercase()}".toByteArray(Charsets.UTF_8)
        val masterKey = argon2id(passphrase.toByteArray(Charsets.UTF_8), salt)
        try {
            val fetchToken = hkdfSha256(masterKey, FETCH_TOKEN_INFO, ARGON2_KEY_BYTES)
            val prfSalt = hkdfSha256(masterKey, PRF_SALT_INFO, ARGON2_KEY_BYTES)
            return PassphraseSecrets(fetchToken = fetchToken, prfSalt = prfSalt)
        } finally {
            // Best-effort wipe of the master key, mirroring recovery.js's
            // masterKey.fill(0).
            masterKey.fill(0)
        }
    }

    /** Lowercase SHA-256 hex of [data] — the form .com stores + compares
     *  for both fetchTokenHash and prfSaltHash. */
    fun sha256Hex(data: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(data)
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) sb.append(String.format("%02x", b.toInt() and 0xff))
        return sb.toString()
    }

    private fun argon2id(password: ByteArray, salt: ByteArray): ByteArray {
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withMemoryAsKB(ARGON2_M_KB)
            .withIterations(ARGON2_T)
            .withParallelism(ARGON2_P)
            .build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val out = ByteArray(ARGON2_KEY_BYTES)
        gen.generateBytes(password, out)
        return out
    }

    /** HKDF-SHA256 with a zero-length salt (RFC 5869 default), matching
     *  recovery.js's WebCrypto deriveBits. Kept local — identical
     *  construction to Recovery.hkdfSha256, but with the empty-salt path
     *  spelled out (HMAC over an unset salt keys off a 32-byte zero block,
     *  exactly like WebCrypto's `salt: new Uint8Array()`). */
    private fun hkdfSha256(ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // RFC 5869: an unset salt defaults to HashLen (32) zero bytes. A
        // zero-length SecretKeySpec is rejected by JCE, so use the explicit
        // 32-byte zero block — produces the identical PRK to WebCrypto.
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val n = minOf(t.size, length - written)
            System.arraycopy(t, 0, out, written, n)
            written += n
            counter++
        }
        return out
    }
}
