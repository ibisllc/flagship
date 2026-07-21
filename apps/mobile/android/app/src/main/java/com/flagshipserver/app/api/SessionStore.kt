// Kotlin equivalent of FlagshipAPI/Client/SessionStoring + KeychainSessionStore.
//
// Backed by EncryptedSharedPreferences so the 32-byte session token
// stays at-rest-encrypted; the file is excluded from auto-backup via
// the manifest's android:fullBackupContent="false" + allowBackup="false".

package com.flagshipserver.app.api

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * Holds the paired pod's base URL + the 32-byte hex session token used for the
 * `x-flagship-session` header read by [LiveScreensClient].
 *
 * MULTI-POD (Fix B) — the single `podBaseUrl` / `sessionToken` slots are the
 * ACTIVE pod's, mirrored from a pod-keyed token store (`sessionToken(forPodId)`)
 * by [activatePod]. Pairing a 2nd box writes its token under its OWN pod id
 * (`pod-<lowercased-fqdn>`) — it no longer overwrites the 1st box's token. The
 * per-pod store is a JSON `{podId: token}` blob in the same backing prefs, so
 * `LiveScreensClient` keeps reading the single active slots transparently.
 * Mirror of iOS FlagshipAPI SessionStoring.
 */
interface SessionStoring {
    val podBaseUrl: StateFlow<String?>
    val sessionToken: StateFlow<String?>
    fun setPodBaseUrl(url: String?)
    fun setSessionToken(token: String?)
    fun clear()

    // ---- Per-pod token store (Fix B) ----

    /** The stored session token for [podId] (`pod-<lowercased-fqdn>`), or null. */
    fun sessionToken(forPodId: String): String?

    /** Persist [token] for [podId]. null ⇒ remove that pod's token. */
    fun setSessionToken(token: String?, forPodId: String)

    /** The pod ids that currently have a stored per-pod token. */
    fun podTokenIds(): List<String>

    /**
     * Best-effort one-time migration: if a legacy single [sessionToken] exists
     * but [anchorPodId] has no per-pod token yet, attribute the legacy token to
     * it. Idempotent — a no-op once the pod has a token or there's no legacy one.
     */
    fun migrateSingleTokenToPod(anchorPodId: String)

    /**
     * Activate [podId]: point the single base-URL + token slots at it from the
     * per-pod store. A pod with no stored token activates with a null token (the
     * BFF then 401s → the "pair this device" affordance), NEVER borrowing another
     * pod's token. Mirror of iOS SessionStoring.activatePod.
     */
    fun activatePod(podId: String?, baseUrl: String?) {
        setPodBaseUrl(baseUrl)
        if (!podId.isNullOrEmpty()) {
            setSessionToken(sessionToken(forPodId = podId))
        } else {
            setSessionToken(null)
        }
    }
}

/** EncryptedSharedPreferences-backed implementation. Tests can pass any
 *  SharedPreferences (e.g. `MemoryPreferences`) to avoid Android KeyStore. */
class EncryptedSessionStore(private val prefs: SharedPreferences) : SessionStoring {
    private val _podBaseUrl = MutableStateFlow(prefs.getString(KEY_BASE_URL, null))
    private val _sessionToken = MutableStateFlow(prefs.getString(KEY_TOKEN, null))

    override val podBaseUrl: StateFlow<String?> = _podBaseUrl.asStateFlow()
    override val sessionToken: StateFlow<String?> = _sessionToken.asStateFlow()

    override fun setPodBaseUrl(url: String?) {
        _podBaseUrl.value = url
        prefs.edit().apply { if (url == null) remove(KEY_BASE_URL) else putString(KEY_BASE_URL, url) }.apply()
    }

    override fun setSessionToken(token: String?) {
        _sessionToken.value = token
        prefs.edit().apply { if (token == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, token) }.apply()
    }

    override fun clear() {
        _podBaseUrl.value = null
        _sessionToken.value = null
        prefs.edit().clear().apply()
    }

    // ---- Per-pod token store (Fix B) ----

    private fun readPodTokens(): MutableMap<String, String> {
        val raw = prefs.getString(KEY_POD_TOKENS, null) ?: return mutableMapOf()
        return runCatching {
            val obj = JSONObject(raw)
            val map = mutableMapOf<String, String>()
            obj.keys().forEach { k -> map[k] = obj.getString(k) }
            map
        }.getOrDefault(mutableMapOf())
    }

    private fun writePodTokens(map: Map<String, String>) {
        prefs.edit().apply {
            if (map.isEmpty()) remove(KEY_POD_TOKENS)
            else putString(KEY_POD_TOKENS, JSONObject(map as Map<*, *>).toString())
        }.apply()
    }

    override fun sessionToken(forPodId: String): String? {
        if (forPodId.isEmpty()) return null
        return readPodTokens()[forPodId.lowercase()]
    }

    override fun setSessionToken(token: String?, forPodId: String) {
        if (forPodId.isEmpty()) return
        val map = readPodTokens()
        val key = forPodId.lowercase()
        if (token != null) map[key] = token else map.remove(key)
        writePodTokens(map)
    }

    override fun podTokenIds(): List<String> = readPodTokens().keys.toList()

    override fun migrateSingleTokenToPod(anchorPodId: String) {
        val key = anchorPodId.lowercase()
        if (key.isEmpty()) return
        val map = readPodTokens()
        if (map[key] != null) return                              // already attributed
        val legacy = prefs.getString(KEY_TOKEN, null)
        if (legacy.isNullOrEmpty()) return
        map[key] = legacy
        writePodTokens(map)
    }

    companion object {
        private const val FILE_NAME = "flagship-session"
        private const val KEY_BASE_URL = "podBaseUrl"
        private const val KEY_TOKEN = "sessionToken"
        private const val KEY_POD_TOKENS = "podTokens"

        fun create(context: Context): EncryptedSessionStore {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                context, FILE_NAME, masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return EncryptedSessionStore(prefs)
        }
    }
}

/** In-memory implementation for tests + previews. */
class InMemorySessionStore : SessionStoring {
    private val _podBaseUrl = MutableStateFlow<String?>(null)
    private val _sessionToken = MutableStateFlow<String?>(null)
    private val podTokens = mutableMapOf<String, String>()
    override val podBaseUrl: StateFlow<String?> = _podBaseUrl.asStateFlow()
    override val sessionToken: StateFlow<String?> = _sessionToken.asStateFlow()
    override fun setPodBaseUrl(url: String?) { _podBaseUrl.value = url }
    override fun setSessionToken(token: String?) { _sessionToken.value = token }
    override fun clear() {
        _podBaseUrl.value = null
        _sessionToken.value = null
        podTokens.clear()
    }

    override fun sessionToken(forPodId: String): String? =
        if (forPodId.isEmpty()) null else podTokens[forPodId.lowercase()]

    override fun setSessionToken(token: String?, forPodId: String) {
        if (forPodId.isEmpty()) return
        val key = forPodId.lowercase()
        if (token != null) podTokens[key] = token else podTokens.remove(key)
    }

    override fun podTokenIds(): List<String> = podTokens.keys.toList()

    override fun migrateSingleTokenToPod(anchorPodId: String) {
        val key = anchorPodId.lowercase()
        if (key.isEmpty() || podTokens[key] != null) return
        val legacy = _sessionToken.value
        if (legacy.isNullOrEmpty()) return
        podTokens[key] = legacy
    }
}
