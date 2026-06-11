// Schedules the dead-man affirmation reminders on the platform AlarmManager
// and re-posts them through the existing `flagship.alerts` notification
// channel. The reminder OFFSETS come from the pure
// core/DeadManReminders.due so they stay unit-testable; this file is the
// thin Android shell. See docs/lock-and-poweroff.md.

package com.flagshipserver.app.push

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.core.DeadManReminders
import kotlin.math.abs

/** Re-posts a single dead-man affirmation reminder as a notification. The
 *  user taps through to MANUALLY affirm (biometric) — we never auto-renew. */
class DeadManReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val serverDomain = intent.getStringExtra(EXTRA_SERVER) ?: return
        val label = intent.getStringExtra(EXTRA_LABEL) ?: "Affirm soon"
        FlagshipFcmService.ensureChannel(context)

        val launch = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            putExtra("deepLink", "flagship://deadman/$serverDomain")
        }
        val pending = PendingIntent.getActivity(
            context,
            abs(serverDomain.hashCode()),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(context, "flagship.alerts")
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle("Keep $serverDomain unlocked?")
            .setContentText("$label — tap to affirm.")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID_BASE + abs(("$serverDomain|$label").hashCode() % 1000), notif)
    }

    companion object {
        const val EXTRA_SERVER = "serverDomain"
        const val EXTRA_LABEL = "label"
        private const val NOTIF_ID_BASE = 2000
    }
}

/** Schedules / cancels the T-6h/T-1h/T-15m reminders for one server. */
object DeadManReminderScheduler {

    /** (Re)schedule all still-future reminders for [serverDomain] given the
     *  new [leaseExpiry]. Clears any prior alarms first so a fresh affirmation
     *  replaces the old schedule. */
    fun schedule(context: Context, serverDomain: String, leaseExpiry: Long, now: Long = System.currentTimeMillis()) {
        cancel(context, serverDomain)
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        DeadManReminders.due(leaseExpiry, now).forEachIndexed { idx, r ->
            val pi = pendingFor(context, serverDomain, idx, r.label)
            am.set(AlarmManager.RTC_WAKEUP, r.fireAt, pi)
        }
    }

    /** Cancel all reminders for [serverDomain] (lock disarmed / affirmed). */
    fun cancel(context: Context, serverDomain: String) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        // We schedule at most one reminder per lead time; cancel that many slots.
        for (idx in DeadManReminders.LEAD_TIMES_MS.indices) {
            am.cancel(pendingFor(context, serverDomain, idx, ""))
        }
    }

    private fun pendingFor(context: Context, serverDomain: String, idx: Int, label: String): PendingIntent {
        val intent = Intent(context, DeadManReminderReceiver::class.java).apply {
            putExtra(DeadManReminderReceiver.EXTRA_SERVER, serverDomain)
            putExtra(DeadManReminderReceiver.EXTRA_LABEL, label)
        }
        val requestCode = abs(serverDomain.hashCode()) * 8 + idx
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
