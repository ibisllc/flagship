package com.flagshipserver.app.keystore

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Generates and holds the User Master Key inside Android Keystore (with
 * StrongBox when available), plus derived secrets that the rest of the
 * app needs:
 *   - IRK (Ed25519) — signs every IRK-bound canonical message.
 *   - PushX25519 — per-device ECDH keypair for encrypted push payloads.
 *
 * The IRK is derived deterministically from the UMK via HKDF-SHA256;
 * we cache the derived seed in EncryptedSharedPreferences so we don't
 * have to round-trip through the AndroidKeyStore + biometric prompt on
 * every send. The Push X25519 keypair lives there too.
 *
 * Why not store everything in AndroidKeyStore: Ed25519 isn't a first-
 * class KeyStore algorithm on every device; for parity with the iOS
 * CryptoKit code-path we keep raw seed bytes wrapped under an AES-GCM
 * KeyStore key (EncryptedSharedPreferences does this internally).
 */
object Keystore {
    private const val UMK_ALIAS = "com.flagship.umk"
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"

    private const val FILE_NAME = "flagship-keystore"
    private const val KEY_UMK_SEED = "umk.seed"
    private const val KEY_IRK_SEED = "irk.seed"
    private const val KEY_PUSH_X25519_PRIV = "push.x25519.priv"
    private const val KEY_PUSH_TOKEN_ID = "push.tokenId"

    private val rng = SecureRandom()
    @Volatile private var prefs: SharedPreferences? = null

    /** Wire up the encrypted-prefs file. Idempotent. App init calls
     *  this from MainActivity.onCreate. */
    fun attach(context: Context) {
        if (prefs != null) return
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context, FILE_NAME, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /** Test-only: attach to a plain SharedPreferences. */
    fun attachForTest(testPrefs: SharedPreferences) {
        prefs = testPrefs
    }

    private fun requirePrefs(): SharedPreferences =
        prefs ?: error("Keystore not attached — call Keystore.attach(context) from app init.")

    /** Generate the UMK in AndroidKeyStore (with StrongBox if available).
     *  This is the symmetric "anchor" key; in production it would wrap
     *  the cached seeds. Stub left over from the scaffolding step. */
    fun generateUMK(useStrongBox: Boolean = true): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val spec = KeyGenParameterSpec.Builder(
            UMK_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setIsStrongBoxBacked(useStrongBox)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    /** Return a 32-byte UMK seed, creating it on first call. */
    fun loadOrCreateUmkSeed(): ByteArray {
        val p = requirePrefs()
        p.getString(KEY_UMK_SEED, null)?.let { hex ->
            HexUtil.decode(hex)?.let { return it }
        }
        val seed = ByteArray(32).also(rng::nextBytes)
        p.edit().putString(KEY_UMK_SEED, HexUtil.encode(seed)).apply()
        return seed
    }

    /** Derive (and cache) the IRK Ed25519 keypair. `reason` is logged
     *  by the iOS side for biometric prompts; here it's surfaced for
     *  later wiring to BiometricPrompt — currently unused. */
    suspend fun deriveIRK(reason: String = "Sign Flagship request"): Ed25519Sign {
        @Suppress("UNUSED_VARIABLE") val _r = reason
        val p = requirePrefs()
        val seedHex = p.getString(KEY_IRK_SEED, null)
        val seed = if (seedHex != null) {
            HexUtil.decode(seedHex) ?: error("corrupt IRK seed")
        } else {
            val umk = loadOrCreateUmkSeed()
            val derived = hkdf(umk, salt = "flagship/irk/v1".toByteArray(),
                info = "ed25519-seed".toByteArray(), length = 32)
            p.edit().putString(KEY_IRK_SEED, HexUtil.encode(derived)).apply()
            derived
        }
        return Ed25519Sign(seed)
    }

    /** Public-key half of the IRK, hex-encoded. */
    suspend fun irkPubHex(): String {
        val p = requirePrefs()
        val seedHex = p.getString(KEY_IRK_SEED, null) ?: run {
            deriveIRK("init"); p.getString(KEY_IRK_SEED, null)!!
        }
        val seed = HexUtil.decode(seedHex)!!
        val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
        return HexUtil.encode(pair.publicKey)
    }

    data class X25519KeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

    /** Load (or create + persist) the per-device X25519 keypair used to
     *  receive encrypted push payloads. */
    fun loadOrCreatePushX25519(): X25519KeyPair {
        val p = requirePrefs()
        val privHex = p.getString(KEY_PUSH_X25519_PRIV, null)
        val priv = if (privHex != null) HexUtil.decode(privHex)!! else {
            val k = X25519.generatePrivateKey()
            p.edit().putString(KEY_PUSH_X25519_PRIV, HexUtil.encode(k)).apply()
            k
        }
        val pub = X25519.publicFromPrivate(priv)
        return X25519KeyPair(privateKey = priv, publicKey = pub)
    }

    /** Last-registered push tokenId; null if no current registration. */
    fun pushTokenId(): String? = requirePrefs().getString(KEY_PUSH_TOKEN_ID, null)

    fun setPushTokenId(id: String?) {
        val p = requirePrefs().edit()
        if (id == null) p.remove(KEY_PUSH_TOKEN_ID) else p.putString(KEY_PUSH_TOKEN_ID, id)
        p.apply()
    }

    // ---- HKDF-SHA256 ----------------------------------------------------

    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(javax.crypto.spec.SecretKeySpec(prk, "HmacSHA256"))
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
