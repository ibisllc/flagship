// One notification channel per kind of push, so the owner can mute app
// requests without muting boot approvals. `.com` sends FCM only a category
// (and, for a boot approval, a fixed kind); the channel comes from those
// alone, like the fixed text does. Everything unrecognised stays on the
// original `flagship.alerts` channel, which keeps the owner's settings.

package com.flagshipserver.app.push

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

object NotificationChannels {
    data class Channel(val id: String, val name: String, val description: String, val importance: Int)

    val APPROVALS get() = Channel(
        "flagship.approvals", FSStrings.get(R.string.approval_requests),
        FSStrings.get(R.string.a_server_waiting_for_you_to),
        NotificationManager.IMPORTANCE_HIGH,
    )
    val SETUP get() = Channel(
        "flagship.setup", FSStrings.get(R.string.server_setup),
        FSStrings.get(R.string.progress_while_a_new_server_installs),
        NotificationManager.IMPORTANCE_LOW,
    )
    val SECURITY get() = Channel(
        "flagship.security", FSStrings.get(R.string.account_and_server_alerts),
        FSStrings.get(R.string.new_servers_certificate_warnings_device),
        NotificationManager.IMPORTANCE_HIGH,
    )
    val APPS get() = Channel(
        "flagship.apps", FSStrings.get(R.string.app_requests),
        FSStrings.get(R.string.one_of_your_apps_asking_to),
        NotificationManager.IMPORTANCE_DEFAULT,
    )
    val BUILDS get() = Channel(
        "flagship.builds", FSStrings.get(R.string.ai_builds),
        FSStrings.get(R.string.an_ai_build_waiting_for_your),
        NotificationManager.IMPORTANCE_DEFAULT,
    )
    val REMINDERS get() = Channel(
        "flagship.reminders", FSStrings.get(R.string.check_in_reminders),
        FSStrings.get(R.string.reminders_to_check_in_before_a),
        NotificationManager.IMPORTANCE_HIGH,
    )
    val GENERAL get() = Channel(
        "flagship.alerts", FSStrings.get(R.string.other_alerts),
        FSStrings.get(R.string.everything_else_from_flagship),
        NotificationManager.IMPORTANCE_DEFAULT,
    )

    val all = listOf(APPROVALS, SETUP, SECURITY, APPS, BUILDS, REMINDERS, GENERAL)

    private val SECURITY_CATEGORIES = setOf(
        "server-registered",
        "cert-alert",
        "ct-unexpected-cert",
        "re-pair-initiated",
        "re-pair-urgent",
        "totp-failed-rate",
        InviteCreatedPush.CATEGORY,
    )

    /** The channel a push with this category (and kind) posts on. */
    fun forPush(category: String?, kind: String?): Channel = when {
        kind == ShareStartupPush.KIND -> APPROVALS
        kind == "secret-request" || category == "secret-request" -> APPROVALS
        category == "provision-status" || kind == "provision-status" -> SETUP
        category in SECURITY_CATEGORIES -> SECURITY
        category == FlagshipFcmService.APP_ACCESS_CATEGORY -> APPS
        category == "vibecode-needs-you" -> BUILDS
        else -> GENERAL
    }

    fun ensureAll(context: Context) {
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        for (c in all) {
            // Re-creating an existing channel only updates its name and
            // description; the owner's importance and sound choices stay.
            mgr.createNotificationChannel(
                NotificationChannel(c.id, c.name, c.importance).apply { description = c.description },
            )
        }
    }
}
