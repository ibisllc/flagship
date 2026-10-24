package com.flagshipserver.app.keystore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.flagshipserver.app.core.pq.PqHex
import com.flagshipserver.app.core.pq.PqHybrid
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Post-quantum identity keys on this phone (architecture v2 milestone 2; owner decision
 * 2026-10-23). Android's Keystore has no ML-DSA (checked on the android-36 SDK), so each
 * identity's ML-DSA-65 key is a software key: a 32-byte seed from the OS RNG, never derived from
 * the UMK or any other key, wrapped by an AES-256-GCM Android Keystore key (StrongBox when the
 * phone has one) that releases only after biometric-or-credential authentication. The seed is
 * unwrapped for one signature and wiped. It is never exported, escrowed, put in a pairing bundle
 * or in a recovery record: a lost phone loses its PQ keys, and a new key is bound only through
 * the account's existing rules (docs/architecture-v2/pq-suites.md §11).
 *
 * The label shown for these keys is [PqCustodyLabel.HARDWARE_WRAPPED], never "hardware PQ".
 */
enum class PqCustodyLabel(val text: String) {
    HARDWARE_WRAPPED("PQ, hardware-wrapped"),
}

/** Wraps and unwraps a PQ seed. Production: [KeystorePqSeedWrapper]; tests use a fake. */
interface PqSeedWrapper {
    val label: PqCustodyLabel
    fun wrap(seed: ByteArray): ByteArray
    /** Throws (e.g. `UserNotAuthenticatedException`) when the user hasn't authenticated recently. */
    fun unwrap(blob: ByteArray): ByteArray
}

/**
 * The Keystore wrap key. Auth-bound with a time window instead of per-use auth, so the prompt
 * the person already answered to unlock the app (BiometricGate asks for a strong biometric or
 * the device credential) also opens these seeds: binding at account creation or right after an
 * unlock never asks again. Outside the window an unwrap fails and the caller defers.
 */
class KeystorePqSeedWrapper(
    private val alias: String = ALIAS,
    private val authWindowSeconds: Int = AUTH_WINDOW_SECONDS,
) : PqSeedWrapper {
    override val label = PqCustodyLabel.HARDWARE_WRAPPED

    companion object {
        const val ALIAS = "com.flagship.pq.seed-wrap.v1"
        const val AUTH_WINDOW_SECONDS = 300
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
            .setUserAuthenticationParameters(
                authWindowSeconds,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
            )
            // Enrolling a new fingerprint must not silently destroy the PQ keys: the binding on
            // `.com` keeps the first ML-DSA key per Ed25519 key, so a lost seed can't be rebound.
            .setInvalidatedByBiometricEnrollment(false)
            .setIsStrongBoxBacked(strongBox)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    override fun wrap(seed: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return c.iv + c.doFinal(seed)
    }

    override fun unwrap(blob: ByteArray): ByteArray {
        require(blob.size > IV_LEN) { "short PQ seed blob" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob.copyOfRange(0, IV_LEN)))
        return c.doFinal(blob.copyOfRange(IV_LEN, blob.size))
    }
}

/**
 * Per-profile, per-identity ML-DSA-65 keys. What is stored is public (the ML-DSA public key,
 * the Ed25519 key it belongs to, the binding state) plus the Keystore-wrapped seed.
 */
class PqKeyStore(
    private val persistence: Persistence,
    private val wrapper: PqSeedWrapper,
    private val profile: () -> String? = { Keystore.activeProfile() },
    private val rng: SecureRandom = SecureRandom(),
) {
    interface Persistence {
        fun load(key: String): String?
        fun save(key: String, value: String)
        fun remove(key: String)
        /** Every stored key (for [rewrapUnderSessionKek]); empty where the store cannot list. */
        fun keys(): Set<String> = emptySet()
    }

    /** Where `.com` stands on this identity's binding, as this phone last learnt it. */
    enum class BindingState { UNSENT, BOUND, BOUND_ELSEWHERE }

    @Serializable
    data class Entry(
        val role: String,
        val subjectId: String,
        val ed25519PubHex: String,
        val mldsaPubHex: String,
        val wrappedSeedHex: String,
        val custody: String,
        val createdAt: Long,
        val state: String = BindingState.UNSENT.name,
    ) {
        val bindingState: BindingState get() = runCatching { BindingState.valueOf(state) }.getOrDefault(BindingState.UNSENT)
        val label: PqCustodyLabel get() = PqCustodyLabel.entries.firstOrNull { it.name == custody } ?: PqCustodyLabel.HARDWARE_WRAPPED
    }

    private val json = Json { ignoreUnknownKeys = true }

    private fun key(role: String, subjectId: String) = "pq.mldsa.v1.${profile() ?: "-"}.$role.$subjectId"

    fun entry(role: String, subjectId: String): Entry? =
        persistence.load(key(role, subjectId))?.let { runCatching { json.decodeFromString(Entry.serializer(), it) }.getOrNull() }

    /**
     * This identity's ML-DSA key for [ed25519PubHex]. A stored key for another Ed25519 key (the
     * identity rotated) is replaced by a fresh one; it is never carried over.
     */
    @Synchronized
    fun getOrCreate(role: String, subjectId: String, ed25519PubHex: String, now: Long): Entry {
        val ed = ed25519PubHex.lowercase()
        entry(role, subjectId)?.takeIf { it.ed25519PubHex == ed }?.let { return it }
        val seed = ByteArray(32).also(rng::nextBytes)
        try {
            val e = Entry(
                role = role,
                subjectId = subjectId,
                ed25519PubHex = ed,
                mldsaPubHex = PqHex.encode(PqHybrid.mldsa65PublicKey(seed)),
                wrappedSeedHex = PqHex.encode(wrapper.wrap(seed)),
                custody = wrapper.label.name,
                createdAt = now,
            )
            persistence.save(key(role, subjectId), json.encodeToString(Entry.serializer(), e))
            return e
        } finally {
            seed.fill(0)
        }
    }

    @Synchronized
    fun setState(role: String, subjectId: String, state: BindingState) {
        val e = entry(role, subjectId) ?: return
        persistence.save(key(role, subjectId), json.encodeToString(Entry.serializer(), e.copy(state = state.name)))
    }

    /** Another device's ML-DSA key is bound for this Ed25519 key: drop any key of ours, remember it. */
    @Synchronized
    fun recordElsewhere(role: String, subjectId: String, ed25519PubHex: String, mldsaPubHex: String, now: Long) {
        val e = Entry(role, subjectId, ed25519PubHex.lowercase(), mldsaPubHex, "", wrapper.label.name, now, BindingState.BOUND_ELSEWHERE.name)
        persistence.save(key(role, subjectId), json.encodeToString(Entry.serializer(), e))
    }

    @Synchronized
    fun forget(role: String, subjectId: String) = persistence.remove(key(role, subjectId))

    /**
     * Move every seed still under the old Keystore-window wrapping under the session KEK
     * ([SessionKekPqSeedWrapper]). Run right after the unlock prompt, while its authentication
     * still opens the old wrapping; a seed it cannot open stays as it was. Returns how many moved.
     */
    @Synchronized
    fun rewrapUnderSessionKek(): Int {
        val w = wrapper as? SessionKekPqSeedWrapper ?: return 0
        var moved = 0
        for (k in persistence.keys().filter { it.startsWith("pq.mldsa.v1.") }) {
            val e = persistence.load(k)?.let { runCatching { json.decodeFromString(Entry.serializer(), it) }.getOrNull() } ?: continue
            val blob = PqHex.decode(e.wrappedSeedHex) ?: continue
            if (blob.isEmpty() || !w.isLegacy(blob)) continue
            val seed = runCatching { w.unwrap(blob) }.getOrNull() ?: continue
            try {
                val again = w.wrap(seed)
                if (w.isLegacy(again)) return moved
                persistence.save(k, json.encodeToString(Entry.serializer(), e.copy(wrappedSeedHex = PqHex.encode(again))))
                moved += 1
            } finally {
                seed.fill(0)
            }
        }
        return moved
    }

    /**
     * The hybrid signature (§5) for [entry] over [payload]: [edSign] signs M' with the identity's
     * Ed25519 key, and the ML-DSA seed is unwrapped for this one signature.
     */
    fun sign(entry: Entry, purpose: String, payload: ByteArray, edSign: (ByteArray) -> ByteArray): ByteArray {
        val seed = wrapper.unwrap(PqHex.decode(entry.wrappedSeedHex) ?: error("corrupt PQ seed blob"))
        try {
            require(PqHex.encode(PqHybrid.mldsa65PublicKey(seed)) == entry.mldsaPubHex) { "PQ seed does not match its key" }
            return PqHybrid.hybridSignSplit(PqHex.decode(entry.ed25519PubHex)!!, edSign, seed, purpose, payload)
        } finally {
            seed.fill(0)
        }
    }
}

/** The PQ key entries live beside the box key pins: public keys and Keystore-wrapped seeds. */
class PqKeyPrefs(context: Context) : PqKeyStore.Persistence {
    private val prefs = context.getSharedPreferences("flagship.pqkeys.v1", Context.MODE_PRIVATE)
    override fun load(key: String): String? = prefs.getString(key, null)
    override fun save(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
    override fun keys(): Set<String> = prefs.all.keys
}
