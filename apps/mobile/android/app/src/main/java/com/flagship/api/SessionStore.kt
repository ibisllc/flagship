// Kotlin equivalent of FlagshipAPI/Client/SessionStoring + KeychainSessionStore.
//
// Backed by EncryptedSharedPreferences so the 32-byte session token
// stays at-rest-encrypted; the file is excluded from auto-backup via
// the manifest's android:fullBackupContent="false" + allowBackup="false".

package com.flagship.api

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

interface SessionStoring {
    val podBaseUrl: StateFlow<String?>
    val sessionToken: StateFlow<String?>
    fun setPodBaseUrl(url: String?)
    fun setSessionToken(token: String?)
    fun clear()
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

    companion object {
        private const val FILE_NAME = "flagship-session"
        private const val KEY_BASE_URL = "podBaseUrl"
        private const val KEY_TOKEN = "sessionToken"

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
    override val podBaseUrl: StateFlow<String?> = _podBaseUrl.asStateFlow()
    override val sessionToken: StateFlow<String?> = _sessionToken.asStateFlow()
    override fun setPodBaseUrl(url: String?) { _podBaseUrl.value = url }
    override fun setSessionToken(token: String?) { _sessionToken.value = token }
    override fun clear() { _podBaseUrl.value = null; _sessionToken.value = null }
}
