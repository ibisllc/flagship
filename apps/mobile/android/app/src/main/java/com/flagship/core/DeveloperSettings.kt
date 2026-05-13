// Kotlin mirror of FlagshipCore/DeveloperSettings.swift.
//
// Persisted toggles for the Developer section. Backed by
// EncryptedSharedPreferences so dev-only secrets (e.g. a private mock
// session token) can be saved here too without leaking to backup.

package com.flagship.core

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
