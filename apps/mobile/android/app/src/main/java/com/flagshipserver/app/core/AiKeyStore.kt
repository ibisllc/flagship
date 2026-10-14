// Device-local saved AI-provider keys. Kotlin mirror of the webapp's
// apps/web/public/webapp/providers.js multi-key store + iOS AiKeyStore.
//
// Each saved entry is `{ id, provider, label, apiKey, baseUrl? }`. The list is
// persisted in EncryptedSharedPreferences (AndroidKeyStore-wrapped MasterKey)
// so the raw keys live ONLY on this device — flagshipserver.com never sees
// them. At build time the user picks (or confirms) one entry; the box then
// calls the provider directly with it.
//
// List UIs only ever get the MASKED slug (`provider · label · sk-…1234`) — the
// full apiKey is read back only when a build actually needs to hand it to the
// box.
//
// Robolectric drives the persistence path via `attachForTest`, exactly like
// Keystore / DeveloperSettings.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.security.SecureRandom

/** A saved provider key. Same shape as the webapp providers.js entry. */
@Serializable
data class SavedAiKey(
    val id: String,
    val provider: String,
    val label: String,
    val apiKey: String,
    val baseUrl: String? = null,
    /** Send this key's calls through the Flagship relay, so the provider sees
     *  Flagship's address instead of the box's. On for new keys and for keys
     *  saved before the setting existed. */
    val relay: Boolean = true,
)

/**
 * The transient credential handed to a build. Matches the daemon BYOK wire
 * contract: `{ provider, apiKey, baseUrl?, relay }`. Held in memory only —
 * never persisted unless the user explicitly saved the underlying entry.
 * [keyId] is the saved entry it came from (null for an unsaved key), so a
 * relay failure can offer to turn the relay off for that key.
 */
data class AiCredential(
    val provider: String,
    val apiKey: String,
    val baseUrl: String? = null,
    val relay: Boolean = true,
    val keyId: String? = null,
    /** "promo" for a free-AI-credits credential (FreeAiCredits); null for
     *  the owner's own key. The box pins a promo credential to its host. */
    val source: String? = null,
    /** The model a free-AI credential names; sent as the build's model. */
    val model: String? = null,
) {
    val isFreeAi: Boolean get() = source == "promo"
}

object AiKeyStore {

    val SUPPORTED_PROVIDERS = listOf("anthropic", "openai", "google", "openrouter", "ollama", "flagship")

    private const val FILE_NAME = "flagship-ai-keys"
    private const val RECORD_KEY = "entries"
    // Explicit "make default" pick. Absent (or pointing at a deleted entry) ⇒
    // the active key falls back to the most-recently-added one. Mirrors the
    // webapp's `activeId` + iOS SavedKeyStore.activeId.
    private const val ACTIVE_KEY = "activeId"

    /**
     * The built-in Flagship Inference entry's id. It is never a saved key:
     * pinning it as active makes builds default to Flagship Inference
     * (mirrors the webapp's PROMO_ID and iOS SavedKeyStore.flagshipInferenceId).
     */
    const val FLAGSHIP_INFERENCE_ID = "flagship-inference"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val rng = SecureRandom()

    private var prefs: SharedPreferences? = null

    fun attach(context: Context) {
        if (prefs != null) return
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /** Test seam: inject an in-memory SharedPreferences (Robolectric). */
    fun attachForTest(p: SharedPreferences) {
        prefs = p
    }

    private fun store(): SharedPreferences =
        prefs ?: error("AiKeyStore not attached — call attach(context) first")

    fun list(): List<SavedAiKey> {
        val raw = store().getString(RECORD_KEY, null) ?: return emptyList()
        return try {
            json.decodeFromString(ListSerializer(SavedAiKey.serializer()), raw)
        } catch (_: Exception) {
            // Corrupt blob — surface an empty list rather than throw, so the
            // user can recover by re-adding.
            emptyList()
        }
    }

    fun get(id: String): SavedAiKey? = list().firstOrNull { it.id == id }

    /**
     * Persist a new entry and return it. `provider`/`apiKey`/`label` are
     * required; `baseUrl` is optional. The first saved key becomes active.
     */
    fun add(provider: String, apiKey: String, label: String, baseUrl: String? = null, relay: Boolean = true): SavedAiKey {
        require(provider.isNotBlank()) { "provider required" }
        require(apiKey.isNotBlank()) { "apiKey required" }
        val entry = SavedAiKey(
            id = newId(),
            provider = provider.trim(),
            label = label.trim().ifBlank { provider.trim() },
            apiKey = apiKey.trim(),
            baseUrl = baseUrl?.trim()?.ifBlank { null },
            relay = relay,
        )
        val next = list() + entry
        persist(next)
        return entry
    }

    fun delete(id: String) {
        if (id == FLAGSHIP_INFERENCE_ID) return
        persist(list().filterNot { it.id == id })
        // Drop a dangling explicit-active pointer so active() cleanly falls
        // back to the most-recently-added entry.
        if (store().getString(ACTIVE_KEY, null) == id) {
            store().edit().remove(ACTIVE_KEY).apply()
        }
    }

    fun clear() {
        store().edit().remove(RECORD_KEY).remove(ACTIVE_KEY).apply()
    }

    /**
     * The active (confirm-default) entry: the user's explicit "make default"
     * pick if it's set AND still present, otherwise the most-recently-added
     * entry. Mirrors the webapp providers.js + iOS SavedKeyStore semantics.
     */
    fun active(): SavedAiKey? {
        val all = list()
        val explicit = store().getString(ACTIVE_KEY, null)
        if (explicit == FLAGSHIP_INFERENCE_ID) return null
        if (explicit != null) {
            all.firstOrNull { it.id == explicit }?.let { return it }
        }
        return all.lastOrNull()
    }

    /** The active entry's id (resolved like [active]), [FLAGSHIP_INFERENCE_ID]
     *  when Flagship Inference is pinned, or null when none. */
    fun activeId(): String? {
        if (store().getString(ACTIVE_KEY, null) == FLAGSHIP_INFERENCE_ID) return FLAGSHIP_INFERENCE_ID
        return active()?.id
    }

    /** Pin a saved entry (or [FLAGSHIP_INFERENCE_ID]) as the active
     *  (confirm-default) one. No-op for an unknown id, so a stale tap can't
     *  orphan the pointer. */
    fun setActive(id: String) {
        if (id == FLAGSHIP_INFERENCE_ID || list().any { it.id == id }) {
            store().edit().putString(ACTIVE_KEY, id).apply()
        }
    }

    /** Turn the Flagship relay on or off for a saved entry. No-op for an unknown id. */
    fun setRelay(id: String, on: Boolean) {
        val all = list()
        if (all.none { it.id == id }) return
        persist(all.map { if (it.id == id) it.copy(relay = on) else it })
    }

    /** The full credential for a saved entry, for handing to a build. */
    fun credentialFor(id: String): AiCredential? =
        get(id)?.let { AiCredential(it.provider, it.apiKey, it.baseUrl, relay = it.relay, keyId = it.id) }

    private fun persist(entries: List<SavedAiKey>) {
        val raw = json.encodeToString(ListSerializer(SavedAiKey.serializer()), entries)
        store().edit().putString(RECORD_KEY, raw).apply()
    }

    private fun newId(): String {
        val b = ByteArray(8)
        rng.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** `provider · label · sk-…1234`. Never exposes more than the last 4. */
    fun maskedSlug(entry: SavedAiKey): String =
        "${entry.provider} · ${entry.label} · ${maskKey(entry.apiKey)}"

    /** Mask a raw key to a `pre-…1234` form. Keys < 8 chars are fully masked. */
    fun maskKey(key: String): String {
        val k = key.trim()
        if (k.isEmpty()) return "—"
        if (k.length <= 8) return "…"
        val prefix = k.take(3)
        val last4 = k.takeLast(4)
        return "$prefix…$last4"
    }
}

/**
 * A call the box didn't send because the key asks for the Flagship relay and
 * the relay couldn't carry it. The box's message is shown as-is, with an
 * action that turns the relay off for that key.
 */
object AiRelay {
    const val TOGGLE_LABEL = "Send through the Flagship relay"
    const val TOGGLE_NOTE = "Better for your anonymity: the AI provider sees Flagship's address, not yours."
    const val CAPTION_ON = "Through the Flagship relay"
    const val CAPTION_OFF = "Direct"
    const val TURN_OFF_ACTION = "Turn the relay off for this key"
    const val TURNED_OFF = "The relay is off for this key. Try again."

    private val MARKERS = listOf(
        "the flagship relay isn't reachable",
        "the flagship relay didn't connect to",
        "the flagship relay only carries",
        "relay-unavailable",
    )

    fun caption(on: Boolean): String = if (on) CAPTION_ON else CAPTION_OFF

    fun isRelayFailure(message: String?): Boolean {
        val m = message?.lowercase()?.replace('’', '\'') ?: return false
        return MARKERS.any { m.contains(it) }
    }

    /** The saved key whose relay a failure is about: the one last handed to a
     *  build. Null when that key wasn't saved (nothing to switch). */
    @Volatile var lastUsedKeyId: String? = null

    /** The key to offer the action for, when [message] is a relay failure. */
    fun keyToTurnOff(message: String?): String? {
        if (!isRelayFailure(message)) return null
        val id = lastUsedKeyId ?: return null
        return runCatching { AiKeyStore.get(id) }.getOrNull()?.takeIf { it.relay }?.id
    }
}
