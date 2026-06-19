// #91 — AI-chat alerts: foreground long-poll → app-initiated LOCAL
// notification → teal operations sliver. Kotlin mirror of iOS AiChatAlertPoller.
//
// The AI build chat (vibe-code / scratch) pauses when the model asks the owner
// a question (`talkToUser`) or requests an env var (`requestEnvVar`). The
// daemon queues a VALUE-FREE `ai-chat-needs-you` event on the phone-pollable
// AlertInbox at that transition. This poller drains it on a 5s foreground
// cadence (matching BootApprovalWatcher):
//
//   1. GET /api/phone/alerts?since=<cursor> over the paired-session pipe.
//   2. For each ai-chat-needs-you envelope: upsert a build op into the
//      ActiveOperationsCenter (deep-links to VibeCodeChat), and raise a LOCAL
//      notification (once per session+tool).
//   3. ACK the drained range so the bounded queue doesn't re-deliver.
//
// The real FCM push wake is owner-gated on Play presence. This foreground poll
// is the always-on path that works today; the notification + sliver feed are
// identical whether the wake came from a push or this poll. The drain client +
// the notifier are injected so the loop is unit-testable with no OkHttp and no
// NotificationManager.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AiChatRequest
import com.flagshipserver.app.api.PhoneAlert
import com.flagshipserver.app.api.PhoneAlertClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class AiChatAlertPoller(
    private val operations: ActiveOperationsCenter,
    private val client: PhoneAlertClient,
    /** Gate — only drain while this returns true (paired + unlocked). Mirrors
     *  the sliver's hide-under-lock so nothing surfaces over the lock screen. */
    private val isActiveGate: () -> Boolean,
    /** Raise a LOCAL notification for a paused build. Injected so tests don't
     *  touch NotificationManager; the app wires the FCM-channel notifier. */
    private val notify: (sessionId: String, request: AiChatRequest) -> Unit,
    private val pollIntervalMs: Long = 5_000L,
) {
    /** ACK cursor — the highest alert id we've drained. */
    private var cursor: Int = 0
    /** Dedup set so a re-drain (e.g. after a failed ACK) won't re-notify the
     *  same pending tool. Keyed by "<sessionId>|<toolUseId>". */
    private val notified = mutableSetOf<String>()

    private var job: Job? = null

    fun start(scope: CoroutineScope) {
        stop()
        job = scope.launch {
            while (isActive) {
                if (isActiveGate()) {
                    drainOnce()
                }
                delay(pollIntervalMs)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    /** One drain: fetch since the cursor, act on every ai-chat-needs-you
     *  envelope, ACK the range, advance the cursor. Best-effort: a transport
     *  blip leaves the cursor where it was so the next tick re-drains; the
     *  notifier is dedup-guarded so a re-drain won't double-notify. Returns the
     *  number of AI-chat alerts handled (for tests / pull-to-refresh). */
    suspend fun drainOnce(): Int {
        val resp = try {
            client.fetchAlerts(cursor)
        } catch (t: Throwable) {
            return 0
        }
        if (resp.events.isEmpty()) return 0

        var maxId = cursor
        var handled = 0
        for (env in resp.events) {
            if (env.id > maxId) maxId = env.id
            val alert = env.alert
            if (alert !is PhoneAlert.AiChatNeedsYou || alert.sessionId.isEmpty()) continue
            // Surface in the operations sliver, deep-linking to the chat. Keyed
            // by the session so the live build feeder + this alert feeder
            // reconcile on the same op rather than dueling.
            operations.upsertBuild(
                id = alert.sessionId,
                subject = "AI build",
                onServer = null,
                target = DeepLink.VibeCodeChat(alert.sessionId),
            )
            val dedupKey = "${alert.sessionId}|${alert.toolUseId}"
            if (notified.add(dedupKey)) {
                notify(alert.sessionId, alert.request)
            }
            handled += 1
        }

        if (maxId > cursor) {
            cursor = maxId
            // Best-effort ACK — a failure just means we re-drain next tick.
            try {
                client.ackAlerts(maxId)
            } catch (_: Throwable) {
                // swallow — re-drained next tick
            }
        }
        return handled
    }
}
