// A page owner rings this account back (docs/voici-calls.md, "Who may call a page, and ringing a caller back"): the
// caller allowed call-backs in a conversation it started on that page, so `.com` holds a ring-back channel naming this
// account, and the owner's ring arrives as a content-free push (category "voici-ring") with a hint sealed to this
// account's thread key for that page. The app opens the hint, rings with the page's name, and on Answer dials out to
// the page (the pseudonymous side always dials out; the owner never learns who answers).

package com.flagshipserver.app.calls

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciRings
import com.flagshipserver.app.push.VoiciRingPush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** The page that rings and what it offers, from an opened hint. */
data class VoiciRingHint(val target: VoiciCallTarget, val ringId: String, val video: Boolean, val issuedAt: Long)

object VoiciRingCenter {
    const val ACTION_ANSWER = "com.flagshipserver.app.calls.RING_ANSWER"
    const val EXTRA_USERNAME = "voiciRingUser"
    const val EXTRA_PAGE_ID = "voiciRingPage"
    const val EXTRA_VIDEO = "voiciRingVideo"
    private const val NOTIF_ID = 7302
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun onPush(context: Context, push: VoiciRingPush.Payload) {
        val app = context.applicationContext
        scope.launch {
            // A push that woke a killed app finds the voi.ci center the main screen would have made.
            runCatching { com.flagshipserver.app.AppRuntime.prepareCalls(app) }
            val hint = runCatching { VoiciCenter.shared?.openRingHint(push.ringId, push.hint) }.getOrNull()
            // Locked (the thread keys are with the account) or not for a page this device knows: a generic ring that
            // opens the app; the owner's ring shows again in the conversation while it lasts.
            ring(app, hint)
        }
    }

    private fun ring(context: Context, hint: VoiciRingHint?) {
        VoiciCallCenter.ensureChannel(context)
        val name = hint?.let { FSStrings.get(R.string.voici_calls_peer_page, it.target.username) }
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP }
            ?: return
        val open = PendingIntent.getActivity(context, 7302, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = NotificationCompat.Builder(context, VoiciCallCenter.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setContentTitle(FSStrings.get(R.string.voici_call_incoming_title))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter(VoiciRings.RING_TTL_MS)
        if (hint == null) {
            b.setContentText(FSStrings.get(R.string.voici_ring_incoming_locked))
        } else {
            val answer = Intent(launch).setAction(ACTION_ANSWER)
                .putExtra(EXTRA_USERNAME, hint.target.username).putExtra(EXTRA_PAGE_ID, hint.target.pageId).putExtra(EXTRA_VIDEO, hint.video)
            val answerPi = PendingIntent.getActivity(context, 7303, answer, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val decline = PendingIntent.getBroadcast(context, 7304, Intent(context, VoiciCallActionReceiver::class.java).setAction(VoiciCallActionReceiver.RING_DECLINE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            b.setContentText(FSStrings.get(R.string.voici_ring_incoming, name!!))
                .setFullScreenIntent(answerPi, true)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(Person.Builder().setName(name).setImportant(true).build(), decline, answerPi))
        }
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, b.build())
        // The calls channel is silent (VoiciCallCenter.ensureChannel): the ring is the phone's ringtone, for the ring time.
        CallRinger.start(context)
        ringTimeout?.cancel()
        ringTimeout = scope.launch {
            kotlinx.coroutines.delay(VoiciRings.RING_TTL_MS)
            val p = VoiciCallCenter.ui.value.phase
            if (p != VoiciCallCenter.Phase.Ringing && p != VoiciCallCenter.Phase.NeedsUnlock) CallRinger.stop()
        }
    }

    @Volatile private var ringTimeout: kotlinx.coroutines.Job? = null

    /** The app came to the front: the ring stops, the notification stays for the ring time. */
    fun stopRinging() {
        if (ringTimeout?.isActive != true) return
        ringTimeout?.cancel()
        // A call to this account's page ringing at the same time keeps its ring.
        val p = VoiciCallCenter.ui.value.phase
        if (p != VoiciCallCenter.Phase.Ringing && p != VoiciCallCenter.Phase.NeedsUnlock) CallRinger.stop()
    }

    fun clear(context: Context) {
        ringTimeout?.cancel()
        CallRinger.stop()
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
    }

    /** MainActivity got the Answer tap: dial out to the page that rang (the channel is already attached). */
    fun answer(context: Context, intent: Intent): Boolean {
        if (intent.action != ACTION_ANSWER) return false
        val user = intent.getStringExtra(EXTRA_USERNAME) ?: return false
        val page = intent.getStringExtra(EXTRA_PAGE_ID) ?: return false
        clear(context)
        VoiciOutgoingCalls.start(context, VoiciCallTarget(user, page), intent.getBooleanExtra(EXTRA_VIDEO, false), allowCallBack = false)
        return true
    }
}
