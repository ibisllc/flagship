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

        // Provisioning observability — a canonical `provision-status` push
        // (category=="provision-status") is WAKE-ONLY: the foregrounded
        // install-progress screen polls GET /api/order/<serial>/status to
        // drive the UI, so the service just renders the standard
        // notification (title/body/deepLink already in `data`, pointing at
        // flagship://install-progress). We still parse it so a missing
        // deepLink can be synthesized below.
        val provisionEvent = ProvisionStatusPush.parse(data)
        if (provisionEvent != null && data["deepLink"].isNullOrEmpty()) {
            data["deepLink"] = "flagship://install-progress"
        }

        // Boot-secret RELAY — a `secret-request` push means the user's box
        // posted a SecretRequest to its `.com` mailbox and `.com` woke us
        // to come finish the handshake. Surface it + route the tap into the
        // approvals surface (the phone fetches + re-verifies on open; the
        // push carries NO secret). Synthesize the deep link if the Worker
        // didn't include one.
        val secretEvent = SecretRequestPush.parse(data)
        secretEvent?.let { event ->
            SecretRequestBridge.onSecretRequest?.invoke(event)
            if (data["deepLink"].isNullOrEmpty()) {
                // Route into the v2 sealed-key RELAY approval list (the phone
                // fetches + re-verifies the pending request(s) on open; the
                // push carries no secret, so no per-id link is needed).
                data["deepLink"] = "flagship://secret-requests"
            }
        }

        val title = data["title"] ?: message.notification?.title
            ?: (secretEvent?.let { "Finish setting up ${it.serverFqdn}" }) ?: "Flagship"
        val body = data["body"] ?: message.notification?.body
            ?: (secretEvent?.let { "Open Flagship to confirm it's your box and release its boot secret." }) ?: ""
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

        /**
         * #91 — raise an app-initiated LOCAL notification that an AI build chat
         * is waiting on the owner. Value-free copy (driven only by the pending
         * tool kind). The tap intent carries `flagship://vibecode/<sessionId>`,
         * so it routes to [com.flagshipserver.app.core.DeepLink.VibeCodeChat]
         * exactly like a real FCM `vibecode-needs-you` wake. Best-effort: if the
         * POST_NOTIFICATIONS permission isn't granted the system drops it
         * silently — the operations sliver already carries the signal.
         */
        fun showAiChatNotification(context: Context, sessionId: String, isEnvVar: Boolean) {
            ensureChannel(context)
            val deepLink = "flagship://vibecode/$sessionId"
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                data = deepLink.toUri()
            }
            val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            // A per-session request code so distinct sessions don't collide.
            val pending = PendingIntent.getActivity(context, sessionId.hashCode(), intent, pendingFlags)
            val body = if (isEnvVar) {
                "The AI needs an environment variable to continue."
            } else {
                "The AI is asking you a question."
            }
            val notif = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Flagship")
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build()
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Per-session id so a re-fire replaces the prior banner.
            mgr.notify(NOTIF_ID_BASE + sessionId.hashCode(), notif)
        }
    }
}

/** Static handle for the FCM service to reach the app-scope registrar.
 *  Set once by MainActivity at app launch; cleared on signOut. */
object PushHolder {
    @Volatile var registrar: PushRegistrar? = null
}
