// The ongoing "your server is installing" notification: one per install,
// updated in place with a progress bar through the canonical phase ladder,
// then left as a dismissable "live" or "problem" notice for five minutes.
// Android's stand-in for iOS's install Live Activity. Silent after the first
// post (low-importance channel, alert once), and shown only while the owner
// allows Flagship's notifications.

package com.flagshipserver.app.companion

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.flagshipserver.app.R
import com.flagshipserver.app.core.PrivacySettings
import com.flagshipserver.app.push.NotificationChannels

object ProvisionNotifier {
    private const val ID_BASE = 4000

    fun notificationId(key: String): Int = ID_BASE + (key.hashCode() and 0x7ff)

    @SuppressLint("MissingPermission") // areNotificationsEnabled() covers POST_NOTIFICATIONS
    fun show(context: Context, update: ProvisionUpdate) {
        val notice = ProvisionNoticeModel.notice(update) ?: return
        val mgr = NotificationManagerCompat.from(context)
        if (!mgr.areNotificationsEnabled()) return
        if (!PrivacySettings.fromContext(context).pushNotificationsEnabled.value) return
        NotificationChannels.ensureAll(context)
        val tap = PendingIntent.getActivity(
            context,
            notificationId(update.key),
            PodStatusWidget.openIntent(context, notice.tapUrl),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = NotificationCompat.Builder(context, NotificationChannels.SETUP.id)
            .setSmallIcon(R.drawable.ic_stat_server)
            .setContentTitle(notice.title)
            .setContentText(notice.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.text))
            .setContentIntent(tap)
            .setOnlyAlertOnce(true)
            .setOngoing(notice.ongoing)
            .setAutoCancel(!notice.ongoing)
            .setCategory(if (notice.ongoing) NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_STATUS)
            .setSilent(true)
        if (notice.ongoing) b.setProgress(100, notice.progress, false)
        notice.timeoutMs?.let(b::setTimeoutAfter)
        mgr.notify(notificationId(update.key), b.build())
    }
}
