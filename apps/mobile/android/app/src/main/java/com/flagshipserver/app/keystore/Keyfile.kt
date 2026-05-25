// `.flagshipkey` — a passphrase-wrapped, portable backup of the User
// Master Key. Byte-compatible with packages/protocol/src/keyfile.ts,
// the iOS Keyfile.swift, and the webapp keyfile.js.
//
// The UMK seed (32 bytes) is the ENTIRE account: IRK/BAK/SWK/STK all
// HKDF-derive from it, so this file is the keys to the kingdom — anyone
// with the file AND the passphrase can fully control the account and
// every server. It is the cloud-independent recovery + cross-device
// backup path. Surfaces MUST wrap export in heavy warnings and never
// auto-sync this file anywhere.
//
// Format: JSON, binary fields hex. A self-describing header is bound
// into the AES-256-GCM AAD, so tampering any header field (username,
// version, kdf params) fails decryption. The argon2id-derived key
// (params recorded in-file so they can be raised later without breaking
// old files) wraps the 32-byte seed.
//
// Crypto:
//   - KDF: argon2id (BouncyCastle Argon2BytesGenerator, version 1.3).
//     input = UTF8(passphrase); salt + m/t/p come from the file; 32B out.
//   - AEAD: AES-256-GCM (javax.crypto, 128-bit tag, AAD bound). The
//     file's ciphertextHex is plaintext || 16B GCM tag — exactly what
//     javax GCM produces/consumes.

package com.flagshipserver.app.keystore

import com.flagshipserver.app.core.HexUtil
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONObject
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Keyfile {

    const val MAGIC = "flagship-key"
    const val VERSION = 1

    /** memory in KiB (m), iterations (t), parallelism (p). */
    data class ArgonParams(val m: Int, val t: Int, val p: Int)

    /** Strong interactive default. Recorded in the file so a future
     *  version can raise it and old files still unwrap with their own
     *  recorded params. Matches KEYFILE_ARGON_PARAMS on the TS side. */
    val ARGON_PARAMS = ArgonParams(m = 65536, t = 3, p = 4)

    /** Floor only — surfaces enforce real passphrase strength in the UI. */
    const val MIN_PASSPHRASE = 8

    data class Meta(
        val username: String,
        val accountId: String?,
        /** ISO-8601 */ val createdAt: String,
    )

    /** Thrown on any export/import failure. [code] mirrors the TS
     *  KeyfileError codes so callers map to the approved copy. */
    class KeyfileException(message: String, val code: Code) : Exception(message) {
        enum class Code { MALFORMED, BAD_PASSPHRASE, VERSION }
    }

    private val rng = SecureRandom()

    /** Canonical AAD binding the human-meaningful header to the
     *  ciphertext. MUST match aadBytes() in keyfile.ts byte-for-byte. */
    private fun aadBytes(
        version: Int,
        username: String,
        accountId: String?,
        createdAt: String,
        params: ArgonParams,
    ): ByteArray {
        val s = listOf(
            "flagship/keyfile/v1",
            version.toString(),
            username,
            accountId ?: "",
            createdAt,
            "argon2id|m=${params.m}|t=${params.t}|p=${params.p}",
            "aes-256-gcm",
        ).joinToString("|")
        return s.toByteArray(Charsets.UTF_8)
    }

    /** argon2id KDF. input = UTF8(passphrase); dkLen = 32. Pinned to
     *  argon2id + version 1.3, matching @noble/hashes + Argon2Kit. */
    private fun deriveKey(passphrase: String, salt: ByteArray, params: ArgonParams): ByteArray {
        val builder = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withMemoryAsKB(params.m)
            .withIterations(params.t)
            .withParallelism(params.p)
        val gen = Argon2BytesGenerator()
        gen.init(builder.build())
        val out = ByteArray(32)
        gen.generateBytes(passphrase.toByteArray(Charsets.UTF_8), out)
        return out
    }

    // ── Wrap (export) ──────────────────────────────────────────────

    /** Wrap a 32-byte UMK seed into `.flagshipkey` text. [params] is
     *  injectable for tests; production callers should omit it. */
    fun wrap(
        umkSeed: ByteArray,
        passphrase: String,
        meta: Meta,
        params: ArgonParams = ARGON_PARAMS,
    ): String {
        if (umkSeed.size != 32) {
            throw KeyfileException("UMK seed must be 32 bytes", KeyfileException.Code.MALFORMED)
        }
        if (passphrase.length < MIN_PASSPHRASE) {
            throw KeyfileException(
                "passphrase too short (min $MIN_PASSPHRASE)",
                KeyfileException.Code.MALFORMED,
            )
        }
        val salt = ByteArray(16).also(rng::nextBytes)
        val nonce = ByteArray(12).also(rng::nextBytes)
        val key = deriveKey(passphrase, salt, params)
        val aad = aadBytes(VERSION, meta.username, meta.accountId, meta.createdAt, params)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, nonce),
        )
        cipher.updateAAD(aad)
        // javax GCM returns ciphertext || 16B tag — exactly the TS shape.
        val ctAndTag = cipher.doFinal(umkSeed)

        return envelopeJson(
            meta = meta,
            params = params,
            saltHex = HexUtil.encode(salt),
            nonceHex = HexUtil.encode(nonce),
            ciphertextHex = HexUtil.encode(ctAndTag),
        )
    }

    // ── Unwrap (import) ────────────────────────────────────────────

    /** Parse + decrypt a `.flagshipkey` file. Throws KeyfileException on
     *  any failure (malformed / bad-passphrase / version). */
    fun unwrap(fileText: String, passphrase: String): Pair<ByteArray, Meta> {
        val obj = try {
            JSONObject(fileText)
        } catch (_: Throwable) {
            throw KeyfileException("not valid JSON", KeyfileException.Code.MALFORMED)
        }
        if (obj.optString("magic") != MAGIC) {
            throw KeyfileException("not a flagship key file", KeyfileException.Code.MALFORMED)
        }
        if (!obj.has("version")) {
            throw KeyfileException("missing version", KeyfileException.Code.MALFORMED)
        }
        val ver = obj.optInt("version", -1)
        if (ver != VERSION) {
            throw KeyfileException("unsupported version $ver", KeyfileException.Code.VERSION)
        }
        val kdf = obj.optJSONObject("kdf")
        if (kdf == null ||
            kdf.optString("algo") != "argon2id" ||
            obj.optString("aead") != "aes-256-gcm"
        ) {
            throw KeyfileException("unsupported kdf/aead", KeyfileException.Code.MALFORMED)
        }

        val m = kdf.optInt("m", -1)
        val t = kdf.optInt("t", -1)
        val p = kdf.optInt("p", -1)
        val saltHex = kdf.optString("saltHex", "")
        val username = if (obj.has("username")) obj.optString("username") else null
        val createdAt = if (obj.has("createdAt")) obj.optString("createdAt") else null
        val nonceHex = obj.optString("nonceHex", "")
        val ciphertextHex = obj.optString("ciphertextHex", "")
        // accountId is optional; omitted ⇒ null in the AAD.
        val accountId = if (obj.has("accountId")) obj.optString("accountId") else null

        if (m < 1 || t < 1 || p < 1 || saltHex.isEmpty() || username == null ||
            createdAt == null || nonceHex.isEmpty() || ciphertextHex.isEmpty()
        ) {
            throw KeyfileException("missing or malformed fields", KeyfileException.Code.MALFORMED)
        }
        val salt = HexUtil.decode(saltHex)
        val nonce = HexUtil.decode(nonceHex)
        val ctAndTag = HexUtil.decode(ciphertextHex)
        if (salt == null || nonce == null || ctAndTag == null) {
            throw KeyfileException("malformed hex fields", KeyfileException.Code.MALFORMED)
        }
        if (ctAndTag.size < 16) {
            throw KeyfileException("ciphertext too short", KeyfileException.Code.MALFORMED)
        }

        val params = ArgonParams(m = m, t = t, p = p)
        val key = deriveKey(passphrase, salt, params)
        val aad = aadBytes(ver, username, accountId, createdAt, params)

        val seed = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, nonce),
            )
            cipher.updateAAD(aad)
            // javax GCM consumes ciphertext || 16B tag — pass ctAndTag whole.
            cipher.doFinal(ctAndTag)
        } catch (_: AEADBadTagException) {
            throw KeyfileException(
                "wrong passphrase or corrupted/tampered file",
                KeyfileException.Code.BAD_PASSPHRASE,
            )
        } catch (e: KeyfileException) {
            throw e
        } catch (_: Throwable) {
            throw KeyfileException(
                "wrong passphrase or corrupted/tampered file",
                KeyfileException.Code.BAD_PASSPHRASE,
            )
        }
        if (seed.size != 32) {
            throw KeyfileException("decrypted seed is not 32 bytes", KeyfileException.Code.MALFORMED)
        }
        return Pair(seed, Meta(username = username, accountId = accountId, createdAt = createdAt))
    }

    // ── Helpers ────────────────────────────────────────────────────

    /** Build the envelope JSON by hand so the field set + accountId
     *  omission match the TS writer's shape exactly. We assemble the
     *  text directly (rather than JSONObject.toString, which doesn't
     *  preserve key order) keyed to the canonical field order. */
    private fun envelopeJson(
        meta: Meta,
        params: ArgonParams,
        saltHex: String,
        nonceHex: String,
        ciphertextHex: String,
    ): String {
        fun q(s: String): String = JSONObject.quote(s)
        val sb = StringBuilder()
        sb.append("{\n")
        sb.append("  \"magic\": ").append(q(MAGIC)).append(",\n")
        sb.append("  \"version\": ").append(VERSION).append(",\n")
        sb.append("  \"username\": ").append(q(meta.username)).append(",\n")
        if (meta.accountId != null) {
            sb.append("  \"accountId\": ").append(q(meta.accountId)).append(",\n")
        }
        sb.append("  \"createdAt\": ").append(q(meta.createdAt)).append(",\n")
        sb.append("  \"kdf\": {\n")
        sb.append("    \"algo\": ").append(q("argon2id")).append(",\n")
        sb.append("    \"m\": ").append(params.m).append(",\n")
        sb.append("    \"t\": ").append(params.t).append(",\n")
        sb.append("    \"p\": ").append(params.p).append(",\n")
        sb.append("    \"saltHex\": ").append(q(saltHex)).append("\n")
        sb.append("  },\n")
        sb.append("  \"aead\": ").append(q("aes-256-gcm")).append(",\n")
        sb.append("  \"nonceHex\": ").append(q(nonceHex)).append(",\n")
        sb.append("  \"ciphertextHex\": ").append(q(ciphertextHex)).append("\n")
        sb.append("}\n")
        return sb.toString()
    }

    /** UTC ISO-8601 with milliseconds — matches the createdAt shape in
     *  the golden keyfile (2026-05-25T00:00:00.000Z). */
    fun nowIso(): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(java.util.Date())
    }
}
