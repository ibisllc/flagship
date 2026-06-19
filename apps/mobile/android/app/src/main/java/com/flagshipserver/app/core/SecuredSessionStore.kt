// Device-local store of the browser QR-login sessions THIS phone authorized
// (docs/service-access-gating.md, "Web-experience gating"). When the visitor
// authorizes a knock, the box returns a phone-held `secretId` (the only handle
// to that browser session); the phone persists it here so the user can later
// see, refresh (online/offline), and stop the session from Settings → "Open
// secured sessions".
//
// Persisted in EncryptedSharedPreferences (AndroidKeyStore-wrapped MasterKey),
// exactly like AiKeyStore — the secretId is a bearer capability over the
// session, so it never leaves this device in the clear at rest. Each entry is
// `{ secretId, serverId, serviceRef, serviceUrl, browserAgent, startedAt }`.
//
// Robolectric drives the persistence path via `attachForTest`, like
// Keystore / AiKeyStore.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** A browser session this phone authorized via a knock. `serviceUrl` is the
 *  tier-2 canonical the browser is viewing (`https://<svc>.<server>`), derived
 *  at authorize time so the list can show + open it. */
@Serializable
data class SecuredSession(
    val secretId: String,
    val serverId: String,
    val serviceRef: String,
    val serviceUrl: String,
    val browserAgent: String,
    val startedAt: Long,
)

object SecuredSessionStore {
    private const val FILE_NAME = "flagship-secured-sessions"
    private const val RECORD_KEY = "entries"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

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
        prefs ?: error("SecuredSessionStore not attached — call attach(context) first")

    /** Newest-first (the most recently authorized session at the top). */
    fun list(): List<SecuredSession> {
        val raw = store().getString(RECORD_KEY, null) ?: return emptyList()
        return try {
            json.decodeFromString(ListSerializer(SecuredSession.serializer()), raw)
                .sortedByDescending { it.startedAt }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun get(secretId: String): SecuredSession? = list().firstOrNull { it.secretId == secretId }

    /** Persist (or replace, by secretId) a session. */
    fun upsert(session: SecuredSession) {
        val next = list().filterNot { it.secretId == session.secretId } + session
        persist(next)
    }

    fun remove(secretId: String) {
        persist(list().filterNot { it.secretId == secretId })
    }

    fun clear() {
        store().edit().remove(RECORD_KEY).apply()
    }

    /** Compose the tier-2 canonical the browser is viewing from the svc label +
     *  the box fqdn: `https://<svc>.<server>`. An empty label (apex service) →
     *  `https://<server>`. */
    fun serviceUrl(serverId: String, svc: String): String =
        if (svc.isBlank()) "https://$serverId" else "https://$svc.$serverId"

    private fun persist(entries: List<SecuredSession>) {
        val raw = json.encodeToString(ListSerializer(SecuredSession.serializer()), entries)
        store().edit().putString(RECORD_KEY, raw).apply()
    }
}
