// Account-wide TLS-certificate validity window (days). Kotlin mirror of
// FlagshipCore/CertValidityStore.swift + the webapp lib/certValidity.js.
//
// The dead-man's-switch: how long a server your devices manage keeps serving
// before its certificate lapses if no admin device surfaces to renew. Set once
// (in Settings) and stamped into each managed server's signed blob at creation
// as `offlineWindowDays`. The wire still carries it per-blob, so each grant
// *could* differ; we just don't surface that. Default 30 days.
//
// Non-secret, device-local — plain SharedPreferences, same as ServerSettingsStore.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class CertValidityStore(private val prefs: SharedPreferences) {
    /** The account-wide validity window in days. Non-preset writes clamp to the
     *  default so a stray value can't widen the window unexpectedly. */
    var days: Int
        get() {
            val raw = prefs.getInt(DAYS_KEY, DEFAULT_DAYS)
            return if (PRESETS.contains(raw)) raw else DEFAULT_DAYS
        }
        set(value) {
            val clamped = if (PRESETS.contains(value)) value else DEFAULT_DAYS
            prefs.edit().putInt(DAYS_KEY, clamped).apply()
        }

    companion object {
        val PRESETS = listOf(7, 30, 90)
        const val DEFAULT_DAYS = 30
        private const val PREFS = "flagship.certValidity"
        private const val DAYS_KEY = "validityDays"

        fun from(context: Context): CertValidityStore =
            CertValidityStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
