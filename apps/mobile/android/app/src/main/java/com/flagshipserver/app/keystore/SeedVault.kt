package com.flagshipserver.app.keystore

import android.content.SharedPreferences
import com.flagshipserver.app.core.HexUtil
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Custody of the account's seed-class secrets on Android: the account seed (UMK) and the admin
 * master root, per profile. They are sealed (AES-256-GCM in software) under the session KEK
 * ([PqSessionKek]), which the unlock prompt's CryptoObject opens from an AndroidKeyStore key that
 * needs the person's authentication for every use (strong biometric or the device PIN, pattern or
 * password on Android 11+; Android 10 per KeyAuthSpec). That is iOS's `.userPresence` custody:
 * nothing opens these seeds without a fresh unlock of this phone, and the one unlock opens them for
 * the whole app session; with the session locked they cannot be read and background work waits.
 *
 * Everything else the owner-key path derives (the IRK, the AID, per-app ids, SWK, CGK, the account
 * device key) is computed from the UMK when needed; the IRK seed is cached in memory only.
 *
 * Storage, in the Keystore's preferences file: the legacy plaintext slot `<slot>` (hex, inside
 * EncryptedSharedPreferences whose master key needs no authentication) and the sealed slot
 * `sealed.<slot>` (hex of `0x01 || iv || ct`, AAD names the slot). Invariant: a legacy value, when
 * present, is the newest (a write with the KEK open removes it; a write without one keeps it and
 * drops the sealed copy), so reads prefer it. [migrate] moves legacy values under the KEK.
 */
object SeedVault {
    const val SEALED_PREFIX = "sealed."
    const val UMK = "umk.seed"
    const val ADMIN_ROOT = "admin.root.seed"
    private val BASES = listOf(UMK, ADMIN_ROOT)
    private const val VERSION: Byte = 0x01
    private const val IV_LEN = 12
    private val rng = SecureRandom()

    fun isSeedSlot(key: String): Boolean = BASES.any { key == it || key.startsWith("$it.") }

    fun sealedKey(slot: String): String = SEALED_PREFIX + slot

    sealed class Read {
        data object Absent : Read()
        /** Still in the old storage (before migration, or a phone that can't make the key). */
        class Legacy(val bytes: ByteArray) : Read()
        class Opened(val bytes: ByteArray) : Read()
        /** Sealed, and the session KEK is closed: the app session is locked. */
        data object Locked : Read()
        /** Sealed, the KEK is open, and the record doesn't open under it: the Keystore key that
         *  protected it is gone (the screen lock was removed) or the record is damaged. */
        data object Unreadable : Read()
    }

    fun has(prefs: SharedPreferences, slot: String): Boolean =
        prefs.getString(slot, null) != null || prefs.getString(sealedKey(slot), null) != null

    fun isSealed(prefs: SharedPreferences, slot: String): Boolean =
        prefs.getString(slot, null) == null && prefs.getString(sealedKey(slot), null) != null

    fun read(prefs: SharedPreferences, slot: String, kek: ByteArray?): Read {
        prefs.getString(slot, null)?.let { hex ->
            HexUtil.decode(hex)?.let { return Read.Legacy(it) }
        }
        val sealed = prefs.getString(sealedKey(slot), null)?.let { HexUtil.decode(it) } ?: return Read.Absent
        if (kek == null) return Read.Locked
        return open(sealed, slot, kek)?.let { Read.Opened(it) } ?: Read.Unreadable
    }

    /** Store [value] in [slot]: sealed when the KEK is open (and the legacy copy goes), else in the
     *  old storage, which the next unlock moves. Returns true when sealed. */
    fun write(prefs: SharedPreferences, slot: String, value: ByteArray, kek: ByteArray?): Boolean {
        if (kek != null) {
            val ok = prefs.edit().putString(sealedKey(slot), HexUtil.encode(seal(value, slot, kek))).commit()
            if (ok && open(prefs.getString(sealedKey(slot), null)?.let { HexUtil.decode(it) }, slot, kek)?.contentEquals(value) == true) {
                prefs.edit().remove(slot).commit()
                return true
            }
        }
        prefs.edit().putString(slot, HexUtil.encode(value)).commit()
        prefs.edit().remove(sealedKey(slot)).commit()
        return false
    }

    fun remove(editor: SharedPreferences.Editor, slot: String) {
        editor.remove(slot)
        editor.remove(sealedKey(slot))
    }

    /** One slot's step in [migrate]. */
    enum class Step {
        /** Sealed, read back and checked, and the old copy deleted. */
        MOVED,
        /** Sealed copy written but it did not read back equal: removed, the old copy kept. */
        VERIFY_FAILED,
        /** The sealed copy could not be written: the old copy kept. */
        WRITE_FAILED,
    }

    /**
     * Move every legacy seed slot (every profile) under [kek]: seal, commit, read the sealed copy
     * back and compare, and only then delete the old copy. A crash at any point leaves at least one
     * readable copy (the legacy value wins reads until it is deleted). The old on-disk IRK seed
     * caches, derivable from the UMK, are deleted once that profile's UMK is held.
     */
    fun migrate(prefs: SharedPreferences, kek: ByteArray): Map<String, Step> {
        val out = LinkedHashMap<String, Step>()
        for (slot in prefs.all.keys.filter { isSeedSlot(it) }.sorted()) {
            val value = prefs.getString(slot, null)?.let { HexUtil.decode(it) } ?: continue
            val sealedHex = HexUtil.encode(seal(value, slot, kek))
            if (!prefs.edit().putString(sealedKey(slot), sealedHex).commit()) {
                out[slot] = Step.WRITE_FAILED
                continue
            }
            val back = prefs.getString(sealedKey(slot), null)?.let { HexUtil.decode(it) }
            if (open(back, slot, kek)?.contentEquals(value) != true) {
                prefs.edit().remove(sealedKey(slot)).commit()
                out[slot] = Step.VERIFY_FAILED
                continue
            }
            prefs.edit().remove(slot).commit()
            out[slot] = Step.MOVED
        }
        dropDerivableIrkCaches(prefs)
        return out
    }

    /** Old builds cached the IRK seed per version on disk ("irk.seed[.<profile>][.vN]"). It is
     *  HKDF(UMK), so it goes once the profile's UMK is held (legacy or sealed). */
    fun dropDerivableIrkCaches(prefs: SharedPreferences) {
        val e = prefs.edit()
        var any = false
        for (key in prefs.all.keys) {
            if (key != "irk.seed" && !key.startsWith("irk.seed.")) continue
            val profileSuffix = key.removePrefix("irk.seed").replace(Regex("\\.v\\d+$"), "")
            if (has(prefs, UMK + profileSuffix)) { e.remove(key); any = true }
        }
        if (any) e.commit()
    }

    /** Sealed slots that don't open under [kek] (see [Read.Unreadable]). */
    fun unreadableSlots(prefs: SharedPreferences, kek: ByteArray): List<String> =
        prefs.all.keys.filter { it.startsWith(SEALED_PREFIX) && isSeedSlot(it.removePrefix(SEALED_PREFIX)) }
            .map { it.removePrefix(SEALED_PREFIX) }
            .filter { prefs.getString(it, null) == null && read(prefs, it, kek) is Read.Unreadable }
            .sorted()

    fun hasSealed(prefs: SharedPreferences): Boolean =
        prefs.all.keys.any { it.startsWith(SEALED_PREFIX) && isSeedSlot(it.removePrefix(SEALED_PREFIX)) }

    internal fun seal(value: ByteArray, slot: String, kek: ByteArray): ByteArray {
        val iv = ByteArray(IV_LEN).also(rng::nextBytes)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(kek, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad(slot))
        return byteArrayOf(VERSION) + iv + c.doFinal(value)
    }

    internal fun open(blob: ByteArray?, slot: String, kek: ByteArray): ByteArray? {
        if (blob == null || blob.size <= 1 + IV_LEN + 16 || blob[0] != VERSION) return null
        return runCatching {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(kek, "AES"), GCMParameterSpec(128, blob.copyOfRange(1, 1 + IV_LEN)))
            c.updateAAD(aad(slot))
            c.doFinal(blob.copyOfRange(1 + IV_LEN, blob.size))
        }.getOrNull()
    }

    private fun aad(slot: String) = "flagship/seed-vault/v1|$slot".toByteArray()

    // ---- What the UI shows ----------------------------------------------

    private val _lost = MutableStateFlow(false)
    /** True once an unlock found this phone's sealed account key unreadable (the Keystore key was
     *  invalidated, i.e. the screen lock was removed). The shell shows [AccountKeyLostScreen]. */
    val lost: StateFlow<Boolean> = _lost.asStateFlow()
    fun markLost(value: Boolean) { _lost.value = value }
}

/** The sealed account key does not open under this phone's session key any more (the Keystore key
 *  was invalidated when the screen lock was removed): only the account's recovery restores it. */
class AccountKeyUnreadableException :
    Exception(com.flagshipserver.app.core.FSStrings.get(com.flagshipserver.app.R.string.account_key_unreadable_short))
