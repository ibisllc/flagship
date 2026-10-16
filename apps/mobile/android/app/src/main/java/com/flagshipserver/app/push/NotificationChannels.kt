// One notification channel per kind of push, so the owner can mute app
// requests without muting boot approvals. `.com` sends FCM only a category
// (and, for a boot approval, a fixed kind); the channel comes from those
// alone, like the fixed text does. Everything unrecognised stays on the
// original `flagship.alerts` channel, which keeps the owner's settings.

package com.flagshipserver.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

object NotificationChannels {
    data class Channel(val id: String, val name: String, val description: String, val importance: Int)

    val APPROVALS = Channel(
        "flagship.approvals", "Approval requests",
        "A server waiting for you to unlock or authorize it.",
        NotificationManager.IMPORTANCE_HIGH,
    )
    val SETUP = Channel(
        "flagship.setup", "Server setup",
        "Progress while a new server installs.",
        NotificationManager.IMPORTANCE_LOW,
    )
    val SECURITY = Channel(
        "flagship.security", "Account and server alerts",
        "New servers, certificate warnings, device changes, sign-in alerts and invites from your other devices.",
        NotificationManager.IMPORTANCE_HIGH,
    )
    val APPS = Channel(
        "flagship.apps", "App requests",
        "One of your apps asking to reach the internet.",
        NotificationManager.IMPORTANCE_DEFAULT,
    )
    val BUILDS = Channel(
        "flagship.builds", "AI builds",
        "An AI build waiting for your answer.",
        NotificationManager.IMPORTANCE_DEFAULT,
    )
    val REMINDERS = Channel(
        "flagship.reminders", "Check-in reminders",
        "Reminders to check in before a server's dead-man switch runs out.",
        NotificationManager.IMPORTANCE_HIGH,
    )
    val GENERAL = Channel(
        "flagship.alerts", "Other alerts",
        "Everything else from Flagship.",
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
        AccessListsPush.CATEGORY,
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
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
