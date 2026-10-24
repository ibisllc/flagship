package com.flagshipserver.app.keystore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.flagshipserver.app.core.pq.PqHex
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The PQ seeds' session key (architecture v2, pq-suites.md §18). The ML-DSA seeds used to sit
 * under a Keystore key with a 300-second authentication window, so a hybrid signature made more
 * than five minutes after the unlock prompt (a PQ session handshake, a strict server's order)
 * either failed or asked again. Now the unlock prompt itself carries a CryptoObject: its cipher,
 * bound to a per-use-auth Keystore key, opens this session's key-encryption key (KEK), and every
 * seed is wrapped under that KEK in software. The KEK lives in memory only while the session is
 * unlocked ([clear] on lock, background and sign-out), exactly like the account key the same
 * prompt releases, so a hybrid signature never needs a second prompt and never outlives the
 * session. Without a KEK (no vault, a phone that cannot make the key) the old wrapping applies.
 */
object PqSessionKek {
    @Volatile var vault: PqKekVault? = null
    @Volatile private var kek: ByteArray? = null
    /** Called once the KEK is open (rewrap old seeds while the prompt's authentication is fresh). */
    @Volatile var onOpened: (() -> Unit)? = null

    fun current(): ByteArray? = kek?.copyOf()
    fun isOpen(): Boolean = kek != null

    /** The cipher the unlock prompt should carry, or null to prompt without one. */
    fun begin(): PqKekVault.Pending? = runCatching { vault?.begin() }.getOrNull()

    /** After the prompt succeeded with [pending]'s cipher (now authenticated): open the KEK. */
    fun finish(pending: PqKekVault.Pending, authenticated: Cipher?) {
        val v = vault ?: return
        val k = runCatching { v.finish(pending, authenticated ?: pending.cipher) }.getOrNull() ?: return
        kek?.fill(0)
        kek = k
        runCatching { onOpened?.invoke() }
    }

    fun clear() {
        kek?.fill(0)
        kek = null
    }

    /** Test seam: open with a known KEK. */
    internal fun openForTest(k: ByteArray?) {
        clear()
        kek = k?.copyOf()
    }
}

/** Where the wrapped KEK is kept and the Keystore key that opens it. */
interface PqKekVault {
    class Pending(val cipher: Cipher, val creating: Boolean)
    fun begin(): Pending
    /** Returns the 32-byte KEK, creating and storing it on [Pending.creating]. */
    fun finish(p: Pending, authenticated: Cipher): ByteArray
}

/**
 * The Keystore half: an AES-256-GCM key that releases only with authentication for each use
 * (biometric-or-credential), so its cipher works only inside the prompt that carried it.
 */
class KeystorePqKekVault(context: Context, private val alias: String = ALIAS) : PqKekVault {
    private val prefs = context.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE)

    companion object {
        const val ALIAS = "com.flagship.pq.kek-wrap.v2"
        private const val BLOB = "pq.kek.v2"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val IV_LEN = 12
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        return try {
            generate(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            generate(strongBox = false)
        }
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // 0: every use needs its own authentication, i.e. the CryptoObject of a prompt.
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setInvalidatedByBiometricEnrollment(false)
            .setIsStrongBoxBacked(strongBox)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    override fun begin(): PqKekVault.Pending {
        val blob = prefs.getString(BLOB, null)?.let { PqHex.decode(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        return if (blob != null && blob.size > IV_LEN) {
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob.copyOfRange(0, IV_LEN)))
            PqKekVault.Pending(c, creating = false)
        } else {
            c.init(Cipher.ENCRYPT_MODE, key())
            PqKekVault.Pending(c, creating = true)
        }
    }

    override fun finish(p: PqKekVault.Pending, authenticated: Cipher): ByteArray {
        if (!p.creating) {
            val blob = PqHex.decode(prefs.getString(BLOB, null) ?: error("no KEK")) ?: error("corrupt KEK blob")
            return authenticated.doFinal(blob.copyOfRange(IV_LEN, blob.size))
        }
        val kek = ByteArray(32).also(SecureRandom()::nextBytes)
        val ct = authenticated.doFinal(kek)
        prefs.edit().putString(BLOB, PqHex.encode(authenticated.iv + ct)).commit()
        return kek
    }
}

/**
 * Seeds wrapped under the session KEK (software AES-256-GCM, blob `0x02 || iv || ct`), with the
 * old Keystore-window wrapping ([legacy]) for blobs made before. A new seed is wrapped under the
 * KEK when the session holds one, else the old way; an old blob is rewrapped by [PqKeyStore.rewrapUnderSessionKek].
 */
class SessionKekPqSeedWrapper(
    private val legacy: PqSeedWrapper,
    private val kek: () -> ByteArray? = { PqSessionKek.current() },
    private val rng: SecureRandom = SecureRandom(),
) : PqSeedWrapper {
    override val label = legacy.label

    companion object {
        const val V2: Byte = 0x02
        private const val IV_LEN = 12
        fun isV2(blob: ByteArray): Boolean = blob.size == 1 + IV_LEN + 32 + 16 && blob[0] == V2
    }

    override fun wrap(seed: ByteArray): ByteArray {
        val k = kek() ?: return legacy.wrap(seed)
        try {
            val iv = ByteArray(IV_LEN).also(rng::nextBytes)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(128, iv))
            c.updateAAD(AAD)
            return byteArrayOf(V2) + iv + c.doFinal(seed)
        } finally {
            k.fill(0)
        }
    }

    override fun unwrap(blob: ByteArray): ByteArray {
        if (!isV2(blob)) return legacy.unwrap(blob)
        val k = kek() ?: throw IllegalStateException("the PQ keys are locked until the next unlock")
        try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(k, "AES"), GCMParameterSpec(128, blob.copyOfRange(1, 1 + IV_LEN)))
            c.updateAAD(AAD)
            return c.doFinal(blob.copyOfRange(1 + IV_LEN, blob.size))
        } finally {
            k.fill(0)
        }
    }

    /** True when [blob] is still under the old wrapping. */
    fun isLegacy(blob: ByteArray): Boolean = !isV2(blob)

    private val AAD = "flagship/pq-seed-wrap/v2".toByteArray()
}
