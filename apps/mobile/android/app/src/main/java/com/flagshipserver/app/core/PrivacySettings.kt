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

class PrivacySettings(private val prefs: SharedPreferences) {

    private val _requireBiometricAtLaunch =
        MutableStateFlow(prefs.getBoolean(KEY_REQUIRE_BIOMETRIC, false))

    /** True iff the user has opted in to requiring a BiometricPrompt
     *  evaluation each time the app cold-launches or returns from
     *  background. Opt-in (default false) so a fresh install doesn't
     *  lock anyone out before they've seen the option. */
    val requireBiometricAtLaunch: StateFlow<Boolean> =
        _requireBiometricAtLaunch.asStateFlow()

    fun setRequireBiometricAtLaunch(value: Boolean) {
        prefs.edit().putBoolean(KEY_REQUIRE_BIOMETRIC, value).apply()
        _requireBiometricAtLaunch.value = value
    }

    companion object {
        fun fromContext(ctx: Context): PrivacySettings {
            val prefs = ctx.getSharedPreferences(PRIVACY_PREFS, Context.MODE_PRIVATE)
            return PrivacySettings(prefs)
        }
    }
}
