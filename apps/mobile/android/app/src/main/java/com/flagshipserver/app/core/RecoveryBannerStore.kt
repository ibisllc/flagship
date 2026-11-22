// Home's recovery reminders (owner, 2026-11-21: no backup page after creating an account; Home reminds instead).
// Two cards, one at a time: cloud recovery while it isn't set up, then a backup file once the cloud card was put off
// and there is still neither cloud recovery nor a backup file saved from this device (KeyBackupStore). Their x
// snoozes the card for a week rather than hiding it for good. Mirrors iOS FlagshipCore/RecoveryBannerStore.swift and
// the webapp's homeReminder (apps/web/public/webapp/views/home.js). UI only: AppState.hasCloudRecovery is the truth.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val RECOVERY_BANNER_PREFS = "flagship.recoveryBanner"
private const val KEY_LEGACY_DISMISSED = "dismissed.v1"
private const val KEY_DISMISSED_AT = "dismissedAt.v2"
private const val KEY_BACKUP_FILE_DISMISSED_AT = "backupFileDismissedAt.v1"

class RecoveryBannerStore(
    private val prefs: SharedPreferences,
    private val now: () -> Long = System::currentTimeMillis,
) {

    init {
        // A dismissal from before the snooze counts as put off from today.
        if (prefs.getBoolean(KEY_LEGACY_DISMISSED, false) && !prefs.contains(KEY_DISMISSED_AT)) {
            prefs.edit().putLong(KEY_DISMISSED_AT, now()).apply()
        }
        prefs.edit().remove(KEY_LEGACY_DISMISSED).apply()
    }

    private val _dismissedAt = MutableStateFlow(prefs.getLong(KEY_DISMISSED_AT, 0L))
    private val _backupFileDismissedAt = MutableStateFlow(prefs.getLong(KEY_BACKUP_FILE_DISMISSED_AT, 0L))

    /** When the cloud recovery card was last put off (0 = never). */
    val dismissedAt: StateFlow<Long> = _dismissedAt.asStateFlow()

    /** When the backup file card was last put off (0 = never). */
    val backupFileDismissedAt: StateFlow<Long> = _backupFileDismissedAt.asStateFlow()

    fun isDismissed(): Boolean = isSnoozed(_dismissedAt.value, now())
    fun isBackupFileDismissed(): Boolean = isSnoozed(_backupFileDismissedAt.value, now())

    /** True puts the cloud recovery card off for a week; false brings it back. */
    fun setDismissed(value: Boolean) {
        val at = if (value) now() else 0L
        prefs.edit().putLong(KEY_DISMISSED_AT, at).apply()
        _dismissedAt.value = at
    }

    fun setBackupFileDismissed(value: Boolean) {
        val at = if (value) now() else 0L
        prefs.edit().putLong(KEY_BACKUP_FILE_DISMISSED_AT, at).apply()
        _backupFileDismissedAt.value = at
    }

    companion object {
        const val SNOOZE_MS: Long = 7L * 24 * 60 * 60 * 1000

        fun fromContext(ctx: Context): RecoveryBannerStore {
            val prefs = ctx.getSharedPreferences(RECOVERY_BANNER_PREFS, Context.MODE_PRIVATE)
            return RecoveryBannerStore(prefs)
        }

        fun isSnoozed(at: Long, now: Long): Boolean = at > 0L && now - at < SNOOZE_MS

        /** The cloud recovery card: recovery isn't set up and the card isn't snoozed. */
        fun shouldShow(hasCloudRecovery: Boolean, dismissed: Boolean): Boolean = !hasCloudRecovery && !dismissed

        /** The backup file card: the cloud card is snoozed and there is still neither cloud recovery nor a backup
         *  file saved from this device, and this card isn't snoozed itself. */
        fun shouldShowBackupFile(hasCloudRecovery: Boolean, recoverySnoozed: Boolean, hasBackupFile: Boolean, dismissed: Boolean): Boolean =
            !hasCloudRecovery && recoverySnoozed && !hasBackupFile && !dismissed
    }
}
