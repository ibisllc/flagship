// Kotlin mirror of FlagshipCore/DeveloperSettings.swift.
//
// Persisted toggles for the Developer section. Backed by
// EncryptedSharedPreferences so dev-only secrets (e.g. a private mock
// session token) can be saved here too without leaking to backup.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class DeveloperSettings(prefs: SharedPreferences) {
    private val store: SharedPreferences = prefs

    companion object {
        private const val FILE_NAME = "flagship-dev"
        private const val KEY_LIVE = "useLiveClient"
        private const val KEY_UNLOCKED = "unlocked"
        private const val KEY_MOCK_LATENCY = "mockLatencyMs"
        private const val KEY_APEX_HOST = "apexHost"

        /** Install (or clear) the [Endpoints] override from an apex host.
         *  Empty / the prod host ⇒ clear (prod default). Shared by the
         *  launch-intent reader and the persisted-field path. */
        fun applyApexOverride(host: String) {
            val trimmed = host.trim().lowercase()
            if (trimmed.isEmpty() || trimmed == Endpoints.PROD_CONTROL_HOST) {
                Endpoints.setOverride(null)
            } else {
                Endpoints.setOverride(trimmed)
            }
        }

        fun create(context: Context): DeveloperSettings {
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
            return DeveloperSettings(prefs)
        }
    }

    private val _useLiveClient = MutableStateFlow(store.getBoolean(KEY_LIVE, false))
    val useLiveClient: StateFlow<Boolean> = _useLiveClient.asStateFlow()

    /// "Developer" subsection in Settings is gated behind a 3-tap easter
    /// egg on the version row. Persists once unlocked.
    private val _unlocked = MutableStateFlow(store.getBoolean(KEY_UNLOCKED, false))
    val unlocked: StateFlow<Boolean> = _unlocked.asStateFlow()

    private val _mockLatencyMs = MutableStateFlow(store.getInt(KEY_MOCK_LATENCY, 180))
    val mockLatencyMs: StateFlow<Int> = _mockLatencyMs.asStateFlow()

    /**
     * Backend apex-host OVERRIDE (the gym test-build seam). Empty ⇒ prod
     * default (`flagshipserver.com`). When set to e.g. `gym.flagshipserver.com`,
     * every client retargets at the gym backend (and the data plane mirrors
     * the `gym.` prefix). Persisted so a test build stays pointed at the gym
     * across launches; PROD ships empty so [Endpoints] resolves to today's
     * literal byte-for-byte. The launch-intent extra `flagship.apexHost` (read
     * in MainActivity) sets this before clients build.
     */
    private val _apexHost = MutableStateFlow(store.getString(KEY_APEX_HOST, "") ?: "")
    val apexHost: StateFlow<String> = _apexHost.asStateFlow()

    init {
        // Apply a persisted override at construction so a test build is pointed
        // at the gym backend before the first client is built. A prod build has
        // no persisted value ⇒ leave Endpoints alone (prod default). We do NOT
        // CLEAR on empty here, so an override already installed by the launch
        // intent (read in MainActivity before this) survives.
        if (_apexHost.value.isNotBlank()) applyApexOverride(_apexHost.value)
    }

    fun setApexHost(value: String) {
        _apexHost.value = value
        store.edit().putString(KEY_APEX_HOST, value).apply()
        applyApexOverride(value)
    }

    fun setUseLiveClient(value: Boolean) {
        _useLiveClient.value = value
        store.edit().putBoolean(KEY_LIVE, value).apply()
    }

    fun setUnlocked(value: Boolean) {
        _unlocked.value = value
        store.edit().putBoolean(KEY_UNLOCKED, value).apply()
    }

    fun setMockLatencyMs(value: Int) {
        _mockLatencyMs.value = value
        store.edit().putInt(KEY_MOCK_LATENCY, value).apply()
    }
}
