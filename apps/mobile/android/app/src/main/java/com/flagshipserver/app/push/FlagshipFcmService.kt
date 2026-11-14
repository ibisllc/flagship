// FirebaseMessagingService entry point. Forwards onNewToken events to
// PushRegistrar (which signs + POSTs to .com), and routes incoming
// notifications through to NotificationCenter for in-app handling.
//
// The MainActivity registers this service in AndroidManifest.xml under
// `com.google.firebase.MESSAGING_EVENT`.

package com.flagshipserver.app.push

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
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
        if (PushTransportStore.from(this).lastRegistered?.startsWith("unifiedpush|") == true) return
        PushMessageHandler.handle(
            this,
            message.data.toMutableMap(),
            message.messageId,
            message.notification?.title,
            message.notification?.body,
        )
    }

    companion object {
        const val GENERIC_CATEGORY = "generic"
        val GENERIC_TEXT get() = FSStrings.get(R.string.open_flagship_to_see_whats_new)
        const val APP_ACCESS_CATEGORY = "app-access"
        val APP_ACCESS_TEXT get() = FSStrings.get(R.string.one_of_your_apps_wants_to)
        private const val NOTIF_ID_BASE = 1000

        /** Every channel (one per kind of push, see NotificationChannels). */
        fun ensureChannel(context: Context) = NotificationChannels.ensureAll(context)

        /** The chat's link, naming the server the session is on (the webapp's aiChatDeepLink). */
        fun aiChatDeepLink(sessionId: String, server: String?): String =
            com.flagshipserver.app.core.Endpoints.appRoute(
                "vibecode/$sessionId",
                server?.takeIf { it.isNotEmpty() }?.let { mapOf("server" to it) } ?: emptyMap(),
            )

        /** The app's page, naming the server it runs on. */
        fun appDetailDeepLink(serviceId: String, server: String?): String =
            com.flagshipserver.app.core.Endpoints.appRoute(
                "app",
                mapOf("appId" to serviceId) + (server?.takeIf { it.isNotEmpty() }?.let { mapOf("server" to it) } ?: emptyMap()),
            )

        /** An app on a server ran out of its disk limit: a content-free notice that opens the app's page. */
        fun showStorageFullNotification(context: Context, serviceId: String, server: String? = null) {
            ensureChannel(context)
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                data = appDetailDeepLink(serviceId, server).toUri()
            }
            val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pending = PendingIntent.getActivity(context, ("storage|$serviceId").hashCode(), intent, pendingFlags)
            val notif = NotificationCompat.Builder(context, NotificationChannels.APPS.id)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Flagship")
                .setContentText(com.flagshipserver.app.core.AppStorageText.ALERT)
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build()
            val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            mgr.notify(NOTIF_ID_BASE + ("storage|$serviceId").hashCode(), notif)
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
        fun showAiChatNotification(context: Context, sessionId: String, isEnvVar: Boolean, server: String? = null) {
            ensureChannel(context)
            val deepLink = aiChatDeepLink(sessionId, server)
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                data = deepLink.toUri()
            }
            val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            // A per-session request code so distinct sessions don't collide.
            val pending = PendingIntent.getActivity(context, sessionId.hashCode(), intent, pendingFlags)
            val body = if (isEnvVar) {
                FSStrings.get(R.string.the_ai_needs_an_environment_variable)
            } else {
                FSStrings.get(R.string.the_ai_is_asking_you_a)
            }
            val notif = NotificationCompat.Builder(context, NotificationChannels.BUILDS.id)
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
