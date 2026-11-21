// What a call needs from the system to ring: notifications on (POST_NOTIFICATIONS is a runtime permission from API 33)
// and, from API 34, the full-screen intent grant (Play may revoke it for apps that are not calling or alarm apps, and a
// user can turn it off), without which a call is only a heads-up notification and never covers the lock screen.

package com.flagshipserver.app.calls

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

object RingReadiness {
    private const val PREFS = "ring_readiness"
    private const val ASKED = "notifications_asked"

    fun notificationsEnabled(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun fullScreenAllowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /** The system prompt is shown at most once on its own (after the first unlock); later, only from Calls settings. */
    fun shouldAskOnUnlock(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 33 && !notificationsEnabled(context) &&
            !context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASKED, false)

    fun markAsked(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ASKED, true).apply()
    }

    fun notificationSettings(context: Context): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

    fun fullScreenSettings(context: Context): Intent =
        if (Build.VERSION.SDK_INT >= 34) {
            Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
        } else {
            notificationSettings(context)
        }
}
