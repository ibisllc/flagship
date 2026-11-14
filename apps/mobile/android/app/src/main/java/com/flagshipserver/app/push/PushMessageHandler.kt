// One handler for every push, whichever transport carried it: FCM's data map
// or the same map decrypted from a UnifiedPush message.

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
import kotlinx.coroutines.launch

object PushMessageHandler {
    private const val NOTIF_ID_BASE = 1000

    fun handle(
        context: Context,
        data: MutableMap<String, String>,
        messageId: String?,
        fallbackTitle: String? = null,
        fallbackBody: String? = null,
    ) {

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

        // An abuse notice or a suspension: refresh what Home and the suspended screen show.
        if (data["category"] == NotificationChannels.ABUSE_NOTICE_CATEGORY) {
            com.flagshipserver.app.core.AbuseNoticeCenter.shared?.let { c ->
                kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch { runCatching { c.refresh() } }
            }
        }

        AccountNoticePush.body(data)?.let { body ->
            data["title"] = AccountNoticePush.TITLE
            data["body"] = body
            data.remove("deepLink")
        }

        if (InviteCreatedPush.matches(data)) {
            data["title"] = InviteCreatedPush.TITLE
            data["body"] = InviteCreatedPush.BODY
            data["deepLink"] = InviteCreatedPush.deepLink()
        }

        if (AccessListsPush.matches(data)) {
            data["title"] = AccessListsPush.TITLE
            data["body"] = AccessListsPush.BODY
            data["deepLink"] = AccessListsPush.deepLink()
        }

        // A `generic` push (§3a; `app-access` from an older box) names no
        // app or host: an app's internet request, or a build chat waiting on
        // the owner (ownerWake.ts). The phone asks its boxes over the paired
        // sessions for both, and a tap just opens the app, whose foreground
        // fetch shows what's waiting.
        val category = data["category"]
        if (category == FlagshipFcmService.GENERIC_CATEGORY || category == FlagshipFcmService.APP_ACCESS_CATEGORY) {
            com.flagshipserver.app.core.AccessRequestBridge.onAccessRequest?.invoke()
            if (category == FlagshipFcmService.GENERIC_CATEGORY) com.flagshipserver.app.core.AiChatAlertBridge.onWake?.invoke()
            data["title"] = "Flagship"
            data["body"] = if (category == FlagshipFcmService.GENERIC_CATEGORY) FlagshipFcmService.GENERIC_TEXT else FlagshipFcmService.APP_ACCESS_TEXT
            data.remove("deepLink")
        }

        // voi.ci Messages (§8.3): content-free; the app fetches and opens what arrived. The text is fixed here.
        if (category == NotificationChannels.MESSAGES_CATEGORY || category == NotificationChannels.PAGE_DRAFTS_CATEGORY) {
            com.flagshipserver.app.core.voici.VoiciCenter.shared?.let { c -> c.scope.launch { runCatching { c.refresh() } } }
            val drafts = category == NotificationChannels.PAGE_DRAFTS_CATEGORY
            data["title"] = "Flagship"
            data["body"] = FSStrings.get(if (drafts) R.string.voici_push_drafts else R.string.voici_push_message)
            data["deepLink"] = com.flagshipserver.app.core.Endpoints.appRoute(if (drafts) "page-editor" else "messages")
        }

        // Settings → Push notifications is off: the registration is (being)
        // revoked, so a push that still arrives is not shown. An open app
        // has already been woken above.
        if (!com.flagshipserver.app.core.PrivacySettings.fromContext(context).pushNotificationsEnabled.value) return

        // An install's checkpoints update its one ongoing setup notification
        // instead of each posting a new one.
        if (provisionEvent != null) {
            com.flagshipserver.app.companion.ProvisionProgressCenter.report(
                context,
                com.flagshipserver.app.companion.ProvisionUpdate(
                    key = provisionEvent.serial.ifEmpty { "provision" },
                    serial = provisionEvent.serial.ifEmpty { null },
                    podName = null,
                    phase = provisionEvent.phase,
                    detail = provisionEvent.detail,
                ),
            )
            return
        }

        val title = data["title"] ?: fallbackTitle ?: "Flagship"
        val body = data["body"] ?: fallbackBody ?: ""
        val deepLink = data["deepLink"]

        FlagshipFcmService.ensureChannel(context)
        val channel = NotificationChannels.forPush(data["category"], data["kind"])
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            if (!deepLink.isNullOrEmpty()) {
                data["deepLink"] = deepLink  // round-trip into the activity
                this.data = deepLink.toUri()
            }
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(context, 0, intent, pendingFlags)

        val notif = NotificationCompat.Builder(context, channel.id)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID_BASE + (messageId?.hashCode() ?: 0), notif)
    }
}
