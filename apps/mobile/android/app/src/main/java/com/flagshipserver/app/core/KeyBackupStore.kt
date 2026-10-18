// Whether an account-key file (.flagshipkey) was written on this device
// (docs/account-gone.md "Backed-up state"): the same meaning as the webapp's
// `keyBackupAt`. Set when the export screen's save succeeds; read by the
// Sign out warning on an admin device. Per account name, kept in the app's own
// preferences, and forgotten when the device's copy of the account is removed.

package com.flagshipserver.app.core

import android.content.Context

object KeyBackupStore {
    private const val PREFS = "flagship.keyBackup"

    private fun key(username: String) = "at.${username.trim().lowercase()}"

    fun markWritten(context: Context, username: String, now: Long = System.currentTimeMillis()) {
        if (username.isBlank()) return
        runCatching { context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(key(username), now).apply() }
    }

    fun isWritten(context: Context, username: String?): Boolean {
        if (username.isNullOrBlank()) return false
        return runCatching {
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(key(username), 0L) > 0L
        }.getOrDefault(false)
    }

    fun forget(context: Context, username: String?) {
        if (username.isNullOrBlank()) return
        runCatching { context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(key(username)).apply() }
    }
}
