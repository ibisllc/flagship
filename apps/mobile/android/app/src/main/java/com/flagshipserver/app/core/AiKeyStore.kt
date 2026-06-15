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
)

/**
 * The transient credential handed to a build. Matches the daemon BYOK wire
 * contract: `{ provider, apiKey, baseUrl? }`. Held in memory only — never
 * persisted unless the user explicitly saved the underlying entry.
 */
data class AiCredential(
    val provider: String,
    val apiKey: String,
    val baseUrl: String? = null,
)

object AiKeyStore {

    val SUPPORTED_PROVIDERS = listOf("anthropic", "openai", "google", "openrouter", "ollama")

    private const val FILE_NAME = "flagship-ai-keys"
    private const val RECORD_KEY = "entries"

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
    fun add(provider: String, apiKey: String, label: String, baseUrl: String? = null): SavedAiKey {
        require(provider.isNotBlank()) { "provider required" }
        require(apiKey.isNotBlank()) { "apiKey required" }
        val entry = SavedAiKey(
            id = newId(),
            provider = provider.trim(),
            label = label.trim().ifBlank { provider.trim() },
            apiKey = apiKey.trim(),
            baseUrl = baseUrl?.trim()?.ifBlank { null },
        )
        val next = list() + entry
        persist(next)
        return entry
    }

    fun delete(id: String) {
        persist(list().filterNot { it.id == id })
    }

    fun clear() {
        store().edit().remove(RECORD_KEY).apply()
    }

    /** Most-recently-added entry is treated as active (the confirm default). */
    fun active(): SavedAiKey? = list().lastOrNull()

    /** The full credential for a saved entry, for handing to a build. */
    fun credentialFor(id: String): AiCredential? =
        get(id)?.let { AiCredential(it.provider, it.apiKey, it.baseUrl) }

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
