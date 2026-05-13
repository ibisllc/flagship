// FirebaseMessagingService entry point. Forwards onNewToken events to
// PushRegistrar (which signs + POSTs to .com), and routes incoming
// notifications through to NotificationCenter for in-app handling.
//
// The MainActivity registers this service in AndroidManifest.xml under
// `com.google.firebase.MESSAGING_EVENT`.

package com.flagshipserver.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.net.toUri
import com.flagshipserver.app.MainActivity
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FlagshipFcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // The app-scope PushRegistrar is wired up by MainActivity onto a
        // static holder so we can reach it from this service context.
        PushHolder.registrar?.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data["title"] ?: message.notification?.title ?: "Flagship"
        val body = data["body"] ?: message.notification?.body ?: ""
        val deepLink = data["deepLink"]

        ensureChannel(this)
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            if (!deepLink.isNullOrEmpty()) {
                data["deepLink"] = deepLink  // round-trip into the activity
                this.data = deepLink.toUri()
            }
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(this, 0, intent, pendingFlags)

        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID_BASE + (message.messageId?.hashCode() ?: 0), notif)
    }

    companion object {
        private const val CHANNEL_ID = "flagship.alerts"
        private const val NOTIF_ID_BASE = 1000

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID, "Flagship alerts", NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = "Unlock requests, deploy events, and other phone alerts." }
            )
        }
    }
}

/** Static handle for the FCM service to reach the app-scope registrar.
 *  Set once by MainActivity at app launch; cleared on signOut. */
object PushHolder {
    @Volatile var registrar: PushRegistrar? = null
}
