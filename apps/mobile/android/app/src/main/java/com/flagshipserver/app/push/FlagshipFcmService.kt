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
        // static holder so we can reach it from this service context. It
        // ignores the token while Settings → Push notifications is off.
        PushHolder.registrar?.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data

        // Provisioning observability — a canonical `provision-status` push
        // (category=="provision-status") is WAKE-ONLY: the foregrounded
        // install-progress screen polls GET /api/order/<serial>/status to
        // drive the UI, so the service just renders the standard
        // notification. The Worker's deepLink (`…/app/install-progress`) names
        // no order, so the tap target is rebuilt with this push's serial.
        val provisionEvent = ProvisionStatusPush.parse(data)
        if (provisionEvent != null) {
            data["deepLink"] = ProvisionStatusPush.deepLink(provisionEvent)
        }

        // Boot-secret RELAY — a `secret-request` push means one of the user's
        // boxes posted a SecretRequest to its `.com` mailbox and `.com` woke
        // us to come finish the handshake. It names no server, so the text is
        // fixed and the tap opens the approvals list, which fetches and
        // re-verifies the pending requests.
        val shareStartup = ShareStartupPush.matches(data)
        if (shareStartup) {
            data["title"] = ShareStartupPush.TITLE
            data["body"] = ShareStartupPush.BODY
            data.remove("deepLink")
        }
        val secretEvent = if (shareStartup) null else SecretRequestPush.parse(data)
        secretEvent?.let { event ->
            SecretRequestBridge.onSecretRequest?.invoke(event)
            data["title"] = SecretRequestPush.TITLE
            data["body"] = SecretRequestPush.BODY
            data["deepLink"] = com.flagshipserver.app.core.Endpoints.appRoute("secret-requests")
        }

        AccountNoticePush.body(data)?.let { body ->
            data["title"] = AccountNoticePush.TITLE
            data["body"] = body
            data.remove("deepLink")
        }

        // A `generic` push (§3a; `app-access` from an older box) names no
        // app or host: the phone asks its boxes over the paired session, and
        // a tap just opens the app, whose foreground fetch shows the request.
        val category = data["category"]
        if (category == GENERIC_CATEGORY || category == APP_ACCESS_CATEGORY) {
            com.flagshipserver.app.core.AccessRequestBridge.onAccessRequest?.invoke()
            data["title"] = "Flagship"
            data["body"] = if (category == GENERIC_CATEGORY) GENERIC_TEXT else APP_ACCESS_TEXT
            data.remove("deepLink")
        }

        // Settings → Push notifications is off: the registration is (being)
        // revoked, so a push that still arrives is not shown. An open app
        // has already been woken above.
        if (!com.flagshipserver.app.core.PrivacySettings.fromContext(this).pushNotificationsEnabled.value) return

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
        const val GENERIC_CATEGORY = "generic"
        const val GENERIC_TEXT = "Open Flagship to see what's new."
        const val APP_ACCESS_CATEGORY = "app-access"
        const val APP_ACCESS_TEXT = "One of your apps wants to reach the internet"
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
         * tool kind). The tap intent carries `https://<control host>/app/vibecode/<sessionId>`,
         * so it routes to [com.flagshipserver.app.core.DeepLink.VibeCodeChat]
         * exactly like a real FCM `vibecode-needs-you` wake. Best-effort: if the
         * POST_NOTIFICATIONS permission isn't granted the system drops it
         * silently — the operations sliver already carries the signal.
         */
        fun showAiChatNotification(context: Context, sessionId: String, isEnvVar: Boolean) {
            ensureChannel(context)
            val deepLink = com.flagshipserver.app.core.Endpoints.appRoute("vibecode/$sessionId")
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
