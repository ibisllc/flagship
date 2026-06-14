// C12 — Kotlin mirror of FlagshipCore/PrivacySettings.swift.
//
// Persisted user preferences governing how the app gates access to
// its content. Today the only toggle is biometric-at-launch.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PRIVACY_PREFS = "flagship.privacy"
private const val KEY_REQUIRE_BIOMETRIC = "requireBiometricAtLaunch"
private const val KEY_REQUIRE_PASSPHRASE = "requirePassphraseAtLaunch"
private const val KEY_THEME_MODE = "themeMode"

/** App appearance: follow the system, or force light / dark. */
enum class ThemeMode { AUTO, LIGHT, DARK }

class PrivacySettings(private val prefs: SharedPreferences) {

    private val _requireBiometricAtLaunch =
        MutableStateFlow(prefs.getBoolean(KEY_REQUIRE_BIOMETRIC, true))

    /** True iff a BiometricPrompt evaluation is required each time the
     *  app cold-launches or returns from background. Defaults ON — a
     *  restored account opens behind a biometric unlock rather than a
     *  full sign-in; the user can turn it off to open straight in.
     *  `getBoolean` returns the default only when the key is unset, so an
     *  explicit choice is always honoured. */
    val requireBiometricAtLaunch: StateFlow<Boolean> =
        _requireBiometricAtLaunch.asStateFlow()

    fun setRequireBiometricAtLaunch(value: Boolean) {
        prefs.edit().putBoolean(KEY_REQUIRE_BIOMETRIC, value).apply()
        _requireBiometricAtLaunch.value = value
    }

    private val _requirePassphraseAtLaunch =
        MutableStateFlow(prefs.getBoolean(KEY_REQUIRE_PASSPHRASE, false))

    /** The strictest option: when ON, the app does NOT restore the
     *  persisted session on launch, so every open requires a full
     *  sign-in (the account passphrase), not just a biometric unlock.
     *  Default OFF. Supersedes [requireBiometricAtLaunch] when both set. */
    val requirePassphraseAtLaunch: StateFlow<Boolean> =
        _requirePassphraseAtLaunch.asStateFlow()

    fun setRequirePassphraseAtLaunch(value: Boolean) {
        prefs.edit().putBoolean(KEY_REQUIRE_PASSPHRASE, value).apply()
        _requirePassphraseAtLaunch.value = value
    }

    private val _themeMode = MutableStateFlow(
        runCatching { ThemeMode.valueOf(prefs.getString(KEY_THEME_MODE, null) ?: "AUTO") }
            .getOrDefault(ThemeMode.AUTO),
    )

    /** Chosen app appearance. Default AUTO (follow the system). The theme
     *  wrapper in MainActivity reads this to pick the light/dark palette. */
    val themeMode: StateFlow<ThemeMode> = _themeMode.asStateFlow()

    fun setThemeMode(value: ThemeMode) {
        prefs.edit().putString(KEY_THEME_MODE, value.name).apply()
        _themeMode.value = value
    }

    companion object {
        fun fromContext(ctx: Context): PrivacySettings {
            val prefs = ctx.getSharedPreferences(PRIVACY_PREFS, Context.MODE_PRIVATE)
            return PrivacySettings(prefs)
        }
    }
}
