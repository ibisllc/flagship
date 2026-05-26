// Persistent dismissal flag for the Home post-creation backup-reminder
// banner. Mirrors:
//   - iOS FlagshipCore/RecoveryBannerStore.swift
//   - webapp localStorage key `flagship.recovery.banner.dismissed.v1`
//     in apps/web/public/webapp/views/home.js.
// Source of truth that recovery isn't enrolled is AppState.hasCloudRecovery;
// a real enrolment clears that signal. This flag only quiets the banner
// the user has already acknowledged, so it stays hidden across launches.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val RECOVERY_BANNER_PREFS = "flagship.recoveryBanner"
private const val KEY_DISMISSED = "dismissed.v1"

class RecoveryBannerStore(private val prefs: SharedPreferences) {

    private val _dismissed = MutableStateFlow(prefs.getBoolean(KEY_DISMISSED, false))

    /** True once the user has tapped "Not now" on the post-creation
     *  backup-reminder banner. Persisted across launches. */
    val dismissed: StateFlow<Boolean> = _dismissed.asStateFlow()

    fun setDismissed(value: Boolean) {
        prefs.edit().putBoolean(KEY_DISMISSED, value).apply()
        _dismissed.value = value
    }

    companion object {
        fun fromContext(ctx: Context): RecoveryBannerStore {
            val prefs = ctx.getSharedPreferences(RECOVERY_BANNER_PREFS, Context.MODE_PRIVATE)
            return RecoveryBannerStore(prefs)
        }

        /** Pure predicate — show the banner iff cloud recovery is not
         *  yet enrolled AND the user hasn't persistently dismissed.
         *  Mirrors the webapp's `shouldShowRecoveryBanner`. */
        fun shouldShow(hasCloudRecovery: Boolean, dismissed: Boolean): Boolean {
            return !hasCloudRecovery && !dismissed
        }
    }
}
