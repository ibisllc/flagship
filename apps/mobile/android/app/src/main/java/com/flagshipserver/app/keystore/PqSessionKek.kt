package com.flagshipserver.app.keystore

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.flagshipserver.app.core.AndroidVersionPolicy
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

    /** The cipher the unlock prompt should carry, or null to prompt without one.
     *  [strongBiometric]: a strong biometric is enrolled now (KeyAuthSpec.strongBiometricEnrolled). */
    fun begin(strongBiometric: Boolean): PqKekVault.Pending? = runCatching { vault?.begin(strongBiometric) }
        .onFailure { com.flagshipserver.app.core.ErrorLog.step("pq-kek", "begin: ${it.javaClass.simpleName}") }
        .getOrNull()

    /** The vault's key opens after a plain prompt instead of riding in it (an Android 10 window key). */
    fun opensAfterPrompt(strongBiometric: Boolean): Boolean =
        runCatching { vault?.opensAfterPrompt(strongBiometric) == true }.getOrDefault(false)

    /** After the prompt succeeded with [pending]'s cipher (now authenticated): open the KEK. */
    fun finish(pending: PqKekVault.Pending, authenticated: Cipher?) {
        val v = vault ?: return
        val k = runCatching { v.finish(pending, authenticated ?: pending.cipher) }
            .onFailure { com.flagshipserver.app.core.ErrorLog.step("pq-kek", "finish: ${it.javaClass.simpleName}") }
            .getOrNull() ?: return
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
    /**
     * [binding] is how the key behind [cipher] opens, which sets the prompt's authenticators (a key
     * made per use on Android 10 takes a strong biometric only). [upgradeTo] is set when the prompt
     * carries a new per-use key that replaces a window key (see [PqKekPlan.UPGRADE_WINDOW]).
     */
    class Pending(
        val cipher: Cipher,
        val creating: Boolean,
        val binding: AndroidVersionPolicy.KeyBinding? = null,
        val upgradeTo: String? = null,
    )
    /** [strongBiometric]: a strong biometric is enrolled now. Throws when the key can't be opened. */
    fun begin(strongBiometric: Boolean): Pending
    /** True when the key opens for a short window after a plain prompt (an Android 10 key made
     *  without a strong biometric), so the prompt must not carry its cipher; [begin] is then
     *  called after the prompt succeeded. */
    fun opensAfterPrompt(strongBiometric: Boolean): Boolean = false
    /** Returns the 32-byte KEK, creating and storing it on [Pending.creating]. */
    fun finish(p: Pending, authenticated: Cipher): ByteArray
}

/** What the unlock does with the PQ session key's Keystore key. */
enum class PqKekPlan {
    /** Nothing wrapped yet: make a per-use key and carry its cipher in the prompt. */
    CREATE_PER_USE,
    /** Nothing wrapped yet, Android 10 with no strong biometric: make a window key, plain prompt. */
    CREATE_WINDOW,
    /** Carry the per-use key's cipher in the prompt. */
    OPEN_PER_USE,
    /** A window key that can't be replaced now: plain prompt, then the key opens for its window. */
    OPEN_WINDOW,
    /**
     * A window key (made on Android 10 before a fingerprint was enrolled) and a per-use key can be
     * made now: the prompt carries a new per-use key's cipher; the strong authentication that
     * answers it also opens the old key's window, so the same KEK moves under the new key and the
     * old key is deleted. One prompt, no KEK lost.
     */
    UPGRADE_WINDOW,
    /** A per-use key only a strong biometric opens, and none is enrolled: the KEK stays closed
     *  (PQ signatures wait) until a fingerprint is enrolled again. */
    UNAVAILABLE;

    val opensAfterPrompt: Boolean get() = this == CREATE_WINDOW || this == OPEN_WINDOW

    companion object {
        /** Pure: [existing] is the stored key's binding (null when none), [hasBlob] whether a
         *  KEK is wrapped under it, [upgradeFailed] whether replacing a window key failed before. */
        fun plan(
            sdk: Int,
            strongBiometric: Boolean,
            existing: AndroidVersionPolicy.KeyBinding?,
            hasBlob: Boolean,
            upgradeFailed: Boolean,
        ): PqKekPlan {
            val perUse = AndroidVersionPolicy.canMakePerUseKey(sdk, strongBiometric)
            return when {
                existing == null || !hasBlob -> if (perUse) CREATE_PER_USE else CREATE_WINDOW
                existing == AndroidVersionPolicy.KeyBinding.WINDOW -> if (perUse && !upgradeFailed) UPGRADE_WINDOW else OPEN_WINDOW
                existing == AndroidVersionPolicy.KeyBinding.PER_USE_BIOMETRIC_ONLY -> if (strongBiometric) OPEN_PER_USE else UNAVAILABLE
                else -> OPEN_PER_USE
            }
        }
    }
}

/**
 * The Keystore half: an AES-256-GCM key that releases only with authentication for each use, so
 * its cipher works only inside the prompt that carried it. API 30+: strong biometric or PIN.
 * Android 10: a strong biometric only (the OS can't let the PIN authorize one use), or, with no
 * strong biometric enrolled, a short window after the prompt, replaced by a per-use key at the
 * first unlock after one is enrolled ([PqKekPlan]). Each key is judged by how it was made, so a key
 * made on Android 10 keeps working after the phone moves to Android 11+.
 */
class KeystorePqKekVault(
    context: Context,
    private val alias: String = ALIAS,
    private val sdk: Int = Build.VERSION.SDK_INT,
) : PqKekVault {
    private val prefs = context.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE)
    private val suffix = if (alias == ALIAS) "" else ".$alias"
    private val blobKey = BLOB + suffix
    private val aliasKey = CURRENT_ALIAS + suffix
    private val upgradeFailedKey = UPGRADE_FAILED + suffix
    private val perUseRefusedKey = PER_USE_REFUSED + suffix

    companion object {
        const val ALIAS = "com.flagship.pq.kek-wrap.v2"
        private const val BLOB = "pq.kek.v2"
        /** The alias holding the key now, once a window key was replaced (absent: [ALIAS]). */
        private const val CURRENT_ALIAS = "pq.kek.v2.alias"
        private const val UPGRADE_FAILED = "pq.kek.v2.upgrade-failed"
        /** Android 10 refused to make a per-use key here: keep to the window key. */
        private const val PER_USE_REFUSED = "pq.kek.v2.per-use-refused"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val IV_LEN = 12
    }

    private fun ks(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    private fun currentAlias(): String = prefs.getString(aliasKey, null) ?: alias
    private fun otherAlias(): String = if (currentAlias() == alias) "$alias.per-use" else alias
    private fun existing(): SecretKey? = ks().getKey(currentAlias(), null) as? SecretKey
    private fun blob(): ByteArray? = prefs.getString(blobKey, null)?.let { PqHex.decode(it) }?.takeIf { it.size > IV_LEN }
    private fun deleteKey(a: String) { runCatching { ks().deleteEntry(a) } }

    private fun bindingOf(key: SecretKey): AndroidVersionPolicy.KeyBinding =
        KeyAuthSpec.binding(key, sdk) ?: if (sdk >= Build.VERSION_CODES.R) {
            AndroidVersionPolicy.KeyBinding.PER_USE_BIOMETRIC_OR_PIN
        } else {
            AndroidVersionPolicy.KeyBinding.PER_USE_BIOMETRIC_ONLY
        }

    /** What the next unlock does (exposed for the device test). */
    fun plan(strongBiometric: Boolean): PqKekPlan = PqKekPlan.plan(
        sdk,
        strongBiometric && !prefs.getBoolean(perUseRefusedKey, false),
        existing()?.let(::bindingOf),
        blob() != null,
        prefs.getBoolean(upgradeFailedKey, false),
    )

    private fun generate(a: String, strongBiometric: Boolean): SecretKey {
        val perUseOnApi29 = strongBiometric && sdk < Build.VERSION_CODES.R
        return try {
            generateAnyBox(a, strongBiometric)
        } catch (e: Exception) {
            if (!perUseOnApi29) throw e
            // The OS refused a per-use key although a strong biometric looked enrolled (it checks the
            // biometric's authenticator id itself). Remember it, so this phone keeps the window key.
            com.flagshipserver.app.core.ErrorLog.step("pq-kek", "per-use key refused: ${e.javaClass.simpleName}")
            prefs.edit().putBoolean(perUseRefusedKey, true).commit()
            throw e
        }
    }

    private fun generateAnyBox(a: String, strongBiometric: Boolean): SecretKey = try {
        generate(a, strongBiometric, strongBox = true)
    } catch (_: StrongBoxUnavailableException) {
        generate(a, strongBiometric, strongBox = false)
    }

    private fun generate(a: String, strongBiometric: Boolean, strongBox: Boolean): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val builder = KeyGenParameterSpec.Builder(a, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        // 0: every use needs its own authentication, i.e. the CryptoObject of a prompt. On Android 10
        // without a strong biometric, a short window the prompt opens instead (KeyAuthSpec).
        val spec = KeyAuthSpec.require(builder, 0, strongBiometric, sdk)
            // Enrolling another fingerprint must not destroy the KEK (and with it the PQ seeds,
            // which `.com` binds once per Ed25519 key): the key stays bound to the screen lock.
            .setInvalidatedByBiometricEnrollment(false)
            .setIsStrongBoxBacked(strongBox)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    override fun opensAfterPrompt(strongBiometric: Boolean): Boolean = plan(strongBiometric).opensAfterPrompt

    override fun begin(strongBiometric: Boolean): PqKekVault.Pending {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        val strong = strongBiometric && !prefs.getBoolean(perUseRefusedKey, false)
        return when (plan(strongBiometric)) {
            PqKekPlan.CREATE_PER_USE, PqKekPlan.CREATE_WINDOW -> {
                // Nothing is wrapped yet: start from a key made the strongest way this phone allows now.
                deleteKey(currentAlias())
                prefs.edit().remove(aliasKey).remove(upgradeFailedKey).commit()
                val key = generate(alias, strong)
                c.init(Cipher.ENCRYPT_MODE, key)
                PqKekVault.Pending(c, creating = true, binding = bindingOf(key))
            }
            PqKekPlan.OPEN_PER_USE, PqKekPlan.OPEN_WINDOW -> {
                val key = existing() ?: error("no PQ KEK key")
                val b = blob() ?: error("no KEK")
                try {
                    c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, b.copyOfRange(0, IV_LEN)))
                } catch (e: KeyPermanentlyInvalidatedException) {
                    // The key is gone for good (the screen lock was removed): what it wrapped can't
                    // be recovered. Start a new KEK; seeds under the old one stay locked.
                    com.flagshipserver.app.core.ErrorLog.step("pq-kek", "key permanently invalidated; making a new one")
                    deleteKey(currentAlias())
                    prefs.edit().remove(blobKey).remove(aliasKey).remove(upgradeFailedKey).commit()
                    return begin(strongBiometric)
                }
                PqKekVault.Pending(c, creating = false, binding = bindingOf(key))
            }
            PqKekPlan.UPGRADE_WINDOW -> {
                val next = otherAlias()
                deleteKey(next)
                val key = generate(next, strong)
                c.init(Cipher.ENCRYPT_MODE, key)
                PqKekVault.Pending(c, creating = true, binding = bindingOf(key), upgradeTo = next)
            }
            PqKekPlan.UNAVAILABLE -> error("the PQ session key needs a strong biometric; none is enrolled")
        }
    }

    override fun finish(p: PqKekVault.Pending, authenticated: Cipher): ByteArray {
        p.upgradeTo?.let { return upgrade(it, authenticated) }
        if (!p.creating) {
            val blob = blob() ?: error("no KEK")
            return authenticated.doFinal(blob.copyOfRange(IV_LEN, blob.size))
        }
        val kek = ByteArray(32).also(SecureRandom()::nextBytes)
        val ct = authenticated.doFinal(kek)
        prefs.edit().putString(blobKey, PqHex.encode(authenticated.iv + ct)).commit()
        return kek
    }

    /** The prompt carried the new per-use key ([next]); its strong authentication also opened the
     *  old window key, so the KEK moves across unchanged. On failure the old key is kept as it was
     *  and the upgrade isn't tried again (it opens as a window key, as before). */
    private fun upgrade(next: String, authenticated: Cipher): ByteArray {
        val old = currentAlias()
        val kek = try {
            val key = existing() ?: error("no PQ KEK key")
            val b = blob() ?: error("no KEK")
            val d = Cipher.getInstance("AES/GCM/NoPadding")
            d.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, b.copyOfRange(0, IV_LEN)))
            d.doFinal(b.copyOfRange(IV_LEN, b.size))
        } catch (t: Throwable) {
            deleteKey(next)
            prefs.edit().putBoolean(upgradeFailedKey, true).commit()
            throw t
        }
        val ct = authenticated.doFinal(kek)
        val saved = prefs.edit()
            .putString(blobKey, PqHex.encode(authenticated.iv + ct))
            .putString(aliasKey, next)
            .remove(upgradeFailedKey)
            .commit()
        if (saved) deleteKey(old)
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
