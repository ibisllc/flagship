// Durable, encrypted-at-rest record of an in-flight phone↔burner pairing
// session, so the session SURVIVES the phone briefly locking + the app being
// suspended (and, in the worst case, the process being killed). On the next
// foreground/launch the BurnerPairController reconnects to the SAME relay
// `sid` reusing the SAME ephemeral X25519 keypair — the Mac burner holds the
// session and auto-resumes on an identical `phone-hello` pubkey (no second
// SAS). Kotlin mirror of apps/mobile/shared/.../BurnerPairingStore.swift.
//
// The raw material (the ephemeral private key + the unsealed recipe wire) lives
// ONLY in EncryptedSharedPreferences (AndroidKeyStore-wrapped MasterKey), the
// same posture as AiKeyStore — flagshipserver.com never sees it. It is WIPED on
// explicit disconnect / `expired` / an incoming `session-ended`.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One in-flight pairing session, persisted for resume. All key/recipe material
 * is base64url-encoded so the record is a flat JSON blob. Mirror of the iOS
 * PersistedBurnerPairing.
 */
@Serializable
data class PersistedBurnerPairing(
    /** The relay session id (`/burner-pipe/<sid>`). */
    val sid: String,
    /** The phone's ephemeral X25519 PRIVATE key, base64url — reused verbatim on
     *  resume so the burner recognises the same peer and skips the SAS. */
    val phoneSkB64: String,
    /** The burner's public key, base64url (null when typed-code + not yet learned). */
    val burnerPkB64: String? = null,
    /** The SAS was confirmed → on resume we skip the match screen. */
    val confirmed: Boolean = false,
    /** The recipe was delivered → on resume we don't re-deliver. */
    val recipeDelivered: Boolean = false,
    /** The verified server domain, for display on resume. */
    val serverDomain: String = "",
    /** The unsealed recipe wire JSON, so the recipe can be re-sealed +
     *  re-delivered after a resume WITHOUT re-minting (which would mint a new
     *  auth-code/serial). null until minted. */
    val recipeWire: String? = null,
    /** The minted auth-code serial (pending-pod bookkeeping). null until minted. */
    val serial: String? = null,
    /** Session deadline, ms since epoch (~1h), from the relay `accepted` frame. */
    val expiresAtMs: Long,
)

/** Synchronous load/save/clear of the single active pairing record. */
interface BurnerPairingStore {
    fun load(): PersistedBurnerPairing?
    fun save(rec: PersistedBurnerPairing)
    fun clear()
}

/**
 * EncryptedSharedPreferences-backed store (mirrors AiKeyStore's primitives).
 * The JSON record lives under an AndroidKeyStore-wrapped MasterKey — device-
 * local, never replicated. Build one per use via [from]; Robolectric injects an
 * in-memory SharedPreferences via [forTest].
 */
class EncryptedBurnerPairingStore private constructor(
    private val prefs: SharedPreferences,
) : BurnerPairingStore {

    override fun load(): PersistedBurnerPairing? {
        val raw = prefs.getString(RECORD_KEY, null) ?: return null
        return try {
            json.decodeFromString(PersistedBurnerPairing.serializer(), raw)
        } catch (_: Exception) {
            // Corrupt blob — surface "no session" rather than throw.
            null
        }
    }

    override fun save(rec: PersistedBurnerPairing) {
        val raw = json.encodeToString(PersistedBurnerPairing.serializer(), rec)
        prefs.edit().putString(RECORD_KEY, raw).apply()
    }

    override fun clear() {
        prefs.edit().remove(RECORD_KEY).apply()
    }

    companion object {
        private const val FILE_NAME = "flagship-burner-pairing"
        private const val RECORD_KEY = "active-session"
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun from(context: Context): EncryptedBurnerPairingStore {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                context,
                FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return EncryptedBurnerPairingStore(prefs)
        }

        /** Test seam: inject an in-memory SharedPreferences (Robolectric). */
        fun forTest(prefs: SharedPreferences) = EncryptedBurnerPairingStore(prefs)
    }
}

/** In-memory store for tests/preview — no persistence across process restarts.
 *  Mirror of the iOS InMemoryBurnerPairingStore. */
class InMemoryBurnerPairingStore(initial: PersistedBurnerPairing? = null) : BurnerPairingStore {
    private var rec: PersistedBurnerPairing? = initial
    override fun load(): PersistedBurnerPairing? = rec
    override fun save(rec: PersistedBurnerPairing) { this.rec = rec }
    override fun clear() { rec = null }
}
