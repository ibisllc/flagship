// Rings and runs voi.ci calls on this phone (docs/voici-calls.md §4, §8; voici-calls-v2.md §1.4). A `voici-call` push
// becomes a self-managed Telecom connection (VoiciConnectionService), which shows our full-screen incoming-call
// notification (CallStyle, USE_FULL_SCREEN_INTENT) and VoiciCallActivity. One call at a time; the room tells the other
// ringing devices when this one answers. Answering starts the phoneCall foreground service (VoiciCallService).
//
// The call starts as audio. The camera is asked for only on the Camera tap in the call screen, and it pauses (the
// caller sees "Camera paused") whenever the call screen is not visible: Android gives no app camera from the background.

package com.flagshipserver.app.calls

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.voici.VoiciCalls
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciCallRequest
import com.flagshipserver.app.push.VoiciCallPush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

object VoiciCallCenter {
    enum class Phase { Idle, Ringing, NeedsUnlock, Connecting, Connected, Ended }

    data class Ui(
        val phase: Phase = Phase.Idle,
        val callId: String? = null,
        val name: String = "",
        /** The caller offered video, so the Camera button shows. */
        val video: Boolean = false,
        val muted: Boolean = false,
        val cameraOn: Boolean = false,
        /** The caller's camera: "on", "off" or "paused". */
        val remoteCamera: String = "off",
        /** Why the call ended or couldn't connect, as a code the screen turns into a sentence. */
        val endCode: String? = null,
        /** While connecting: the step under way, and whether it has run longer than usual (VoiciCallConnectSteps). */
        val step: VoiciCallConnectStep? = null,
        val slow: Boolean = false,
    )

    const val CHANNEL_ID = "flagship.calls"
    const val NOTIF_ID = 7301
    const val EXTRA_CALL_ID = "voiciCallId"
    private const val ACCOUNT_ID = "voici"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    /** The room WebSocket to `.com`: the pinning factory's client (the update lock, account-gone and pin rules apply), with a ping. */
    private val http by lazy { com.flagshipserver.app.core.HttpClientFactory.build().newBuilder().pingInterval(20, TimeUnit.SECONDS).build() }
    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    /** The WebRTC implementation: our libwebrtc build when the app was built with it (CallMediaFactory), else the stub. */
    @Volatile var mediaFactory: () -> CallMediaEngine = { CallMediaFactory.make(app) }

    @Volatile private var session: VoiciCallSession? = null
    @Volatile private var media: CallMediaEngine? = null
    /** This device holds its bare name for the call in progress (PhoneRouteController.callStarted). */
    @Volatile private var holdsRoute = false
    private val steps = VoiciCallConnectSteps()
    @Volatile private var slowJob: kotlinx.coroutines.Job? = null
    @Volatile private var limitJob: kotlinx.coroutines.Job? = null
    @Volatile private var gaveUp = false
    @Volatile private var pendingPush: VoiciCallPush.Payload? = null
    @Volatile internal var connection: VoiciConnection? = null
    @Volatile private var pausedByBackground = false
    @Volatile private var connectedAt: Long? = null
    private lateinit var app: Context

    private fun update(f: (Ui) -> Ui) {
        _ui.value = f(_ui.value)
    }

    // ── ringing ──

    /**
     * A call that arrives at [nowMs] rings here only while fresh and outside this device's Do Not Disturb hours. A
     * quiet device stays out of the room, so another device can answer and an unanswered call becomes a missed call.
     */
    fun shouldRing(
        issuedAt: Long,
        nowMs: Long,
        quiet: CallQuietHours,
        calendar: java.util.Calendar = java.util.Calendar.getInstance(),
        /** The owner's call hours (synced between the owner's devices): outside them nothing rings, so it's missed. */
        hours: com.flagshipserver.app.core.voici.VoiciCallHours? = null,
    ): Boolean =
        nowMs - issuedAt <= VoiciCalls.RING_MS && !quiet.isQuiet(nowMs, calendar) && com.flagshipserver.app.core.voici.VoiciCallHoursSettings.allow(hours, nowMs)

    fun onPush(context: Context, push: VoiciCallPush.Payload) {
        app = context.applicationContext
        val store = CallSettingsStore(app)
        // Outside the owner's call hours (or this device's Do Not Disturb) the device stays out of the room: nothing
        // rings, and the unanswered call becomes a missed call.
        if (!shouldRing(push.issuedAt, System.currentTimeMillis(), store.quietHours(), hours = store.callHours())) return
        if (session != null || pendingPush != null) return
        pendingPush = push
        update { Ui(phase = Phase.Ringing, callId = push.callId, name = FSStrings.get(R.string.voici_call_someone)) }
        scope.launch {
            val keys = runCatching { VoiciCenter.shared?.callKeys() }.getOrNull()
                // "Answer calls while Flagship is locked" is on: the call key answers; the caller stays "Someone on voi.ci".
                ?: runCatching { VoiciCenter.shared?.lockedCallKeys() }.getOrNull()
            if (keys != null) startSession(push, keys) else update { it.copy(phase = Phase.NeedsUnlock) }
            ring(push)
        }
    }

    private fun startSession(push: VoiciCallPush.Payload, keys: VoiciCallKeys) {
        val sealed = runCatching { android.util.Base64.decode(push.sealed, android.util.Base64.DEFAULT) }.getOrNull()
        val who = sealed?.let { keys.openPush(push.callId, it) }
        if (who != null) update { it.copy(name = keys.nicknames[who.third] ?: VoiciCopy.visitorName(who.third)) }
        val m = mediaFactory()
        media = m
        // The caller's media arrives only through this phone's bare name: hold it while the call rings and runs, even
        // with the app in the background.
        if (!holdsRoute) {
            holdsRoute = true
            com.flagshipserver.app.phoneroute.PhoneRouteController.callStarted()
        }
        val s = VoiciCallSession(push, keys, m, http, scope, listener)
        session = s
        s.connect()
    }

    /** The account was unlocked while a call rings: join the room now. */
    fun onUnlocked() {
        val push = pendingPush ?: return
        if (session != null) return
        scope.launch {
            val keys = runCatching { VoiciCenter.shared?.callKeys() }.getOrNull() ?: return@launch
            update { it.copy(phase = Phase.Ringing) }
            startSession(push, keys)
        }
    }

    private fun phoneAccount(context: Context): PhoneAccountHandle =
        PhoneAccountHandle(ComponentName(context, VoiciConnectionService::class.java), ACCOUNT_ID)

    private fun ring(push: VoiciCallPush.Payload) {
        val tm = app.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        try {
            if (tm == null) throw IllegalStateException("no telecom")
            val handle = phoneAccount(app)
            tm.registerPhoneAccount(
                PhoneAccount.builder(handle, FSStrings.get(R.string.voici_call_account))
                    .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED or PhoneAccount.CAPABILITY_VIDEO_CALLING or PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING)
                    .build(),
            )
            tm.addNewIncomingCall(handle, Bundle().apply { putString(EXTRA_CALL_ID, push.callId) })
        } catch (_: Exception) {
            // Telecom refused (no permission, a call already active): the notification alone still rings.
            showIncoming(app)
        }
    }

    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, FSStrings.get(R.string.voici_call_channel), NotificationManager.IMPORTANCE_HIGH).apply {
                description = FSStrings.get(R.string.voici_call_channel_desc)
            },
        )
    }

    private fun activityIntent(context: Context, action: String?): PendingIntent {
        val i = Intent(context, VoiciCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (action != null) this.action = action
        }
        return PendingIntent.getActivity(context, action.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun broadcast(context: Context, action: String): PendingIntent =
        PendingIntent.getBroadcast(context, action.hashCode(), Intent(context, VoiciCallActionReceiver::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** The incoming-call notification: full-screen on a locked phone, a heads-up otherwise. */
    fun showIncoming(context: Context) {
        ensureChannel(context)
        val caller = Person.Builder().setName(_ui.value.name).setImportant(true).build()
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setContentTitle(FSStrings.get(R.string.voici_call_incoming_title))
            .setContentText(FSStrings.get(R.string.voici_call_incoming_from, _ui.value.name))
            .setFullScreenIntent(activityIntent(context, null), true)
            .setContentIntent(activityIntent(context, null))
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, broadcast(context, VoiciCallActionReceiver.DECLINE), activityIntent(context, VoiciCallActivity.ACTION_ANSWER)))
            .setTimeoutAfter(VoiciCalls.RING_MS)
            .build()
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, n)
    }

    fun ongoingNotification(context: Context) = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.sym_call_outgoing)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setOngoing(true)
        .setContentTitle(FSStrings.get(R.string.voici_call_ongoing))
        .setContentIntent(activityIntent(context, null))
        .setStyle(NotificationCompat.CallStyle.forOngoingCall(Person.Builder().setName(_ui.value.name).build(), broadcast(context, VoiciCallActionReceiver.HANG_UP)))
        .build()

    private fun clearNotification() {
        if (!::app.isInitialized) return
        (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
    }

    // ── actions ──

    fun hasCamera(context: Context): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    fun answer(context: Context) {
        val s = session ?: return
        if (_ui.value.phase != Phase.Ringing) return
        update { it.copy(phase = Phase.Connecting) }
        startConnectClock()
        step(VoiciCallConnectStep.Route)
        clearNotification()
        scope.launch {
            // The answer sends the caller to this phone's TURN at once, and a caller's browser tries it only once.
            com.flagshipserver.app.phoneroute.PhoneRouteController.awaitHolding(8_000)
            step(VoiciCallConnectStep.Secure)
            when (val code = s.answer(cameraAble = hasCamera(context))) {
                null -> {
                    connection?.setActive()
                    VoiciCallService.start(context)
                }
                else -> {
                    s.leave()
                    finish(code)
                }
            }
        }
    }

    fun decline() {
        val s = session
        if (s != null) s.decline() else finish("decline")
    }

    fun hangUp() {
        val s = session
        when {
            s == null -> finish("hangup")
            _ui.value.phase == Phase.Ringing || _ui.value.phase == Phase.NeedsUnlock -> s.decline()
            else -> s.hangUp()
        }
    }

    fun setMuted(muted: Boolean) {
        media?.setMuted(muted)
        update { it.copy(muted = muted) }
    }

    /** The Camera tap (the screen asked for the permission first). False when the camera can't start. */
    fun setCamera(context: Context, on: Boolean): Boolean {
        val u = _ui.value
        if (!u.video || (u.phase != Phase.Connecting && u.phase != Phase.Connected)) return false
        if (on && ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return false
        if (media?.setCamera(on) != true) return false
        pausedByBackground = false
        session?.sendCamera(if (on) "on" else "off")
        update { it.copy(cameraOn = on) }
        if (on) VoiciCallService.start(context)
        return true
    }

    /** The call screen left the foreground: pause our camera (voici-calls-v2.md §1.4). */
    fun onScreenHidden() {
        if (!_ui.value.cameraOn) return
        media?.setCamera(false)
        session?.sendCamera("paused")
        pausedByBackground = true
        update { it.copy(cameraOn = false) }
    }

    fun onScreenVisible() {
        if (!pausedByBackground) return
        pausedByBackground = false
        if (media?.setCamera(true) == true) {
            session?.sendCamera("on")
            update { it.copy(cameraOn = true) }
        }
    }

    // ── connecting steps ──

    private fun startConnectClock() {
        steps.reset()
        limitJob?.cancel()
        limitJob = scope.launch {
            kotlinx.coroutines.delay(VoiciCallConnectSteps.LIMIT_MS)
            if (_ui.value.phase == Phase.Connecting) giveUp()
        }
    }

    private fun step(s: VoiciCallConnectStep) {
        if (_ui.value.phase != Phase.Connecting || !steps.advance(s)) return
        update { it.copy(step = s, slow = false) }
        slowJob?.cancel()
        slowJob = scope.launch {
            kotlinx.coroutines.delay(VoiciCallConnectSteps.SLOW_MS)
            if (_ui.value.phase == Phase.Connecting && _ui.value.step == s) update { it.copy(slow = true) }
        }
    }

    private fun stopConnectClock() {
        slowJob?.cancel()
        limitJob?.cancel()
        slowJob = null
        limitJob = null
    }

    /** Connecting took too long: end the call for both sides, shown as "The call couldn't connect." */
    private fun giveUp() {
        gaveUp = true
        val s = session
        if (s != null) s.hangUp() else finish("failed")
    }

    private fun finish(reason: String) {
        // A call that gave up connecting ends as "failed", whatever its hang-up said.
        val code = if (gaveUp) "failed" else reason
        gaveUp = false
        stopConnectClock()
        recordIncoming(session?.request, code)
        connectedAt = null
        pendingPush = null
        session = null
        media = null
        pausedByBackground = false
        if (holdsRoute) {
            holdsRoute = false
            com.flagshipserver.app.phoneroute.PhoneRouteController.callEnded()
        }
        clearNotification()
        connection?.let { c ->
            c.setDisconnected(disconnectCause(code))
            c.destroy()
        }
        connection = null
        if (::app.isInitialized) VoiciCallService.stop(app)
        update { it.copy(phase = Phase.Ended, endCode = code, cameraOn = false, step = null, slow = false) }
    }

    private val listener = object : VoiciCallSession.Listener {
        override fun onRequest(request: VoiciCallRequest) {
            update { it.copy(video = request.hasVideo) }
        }
        override fun onWon() {
            update { it.copy(phase = Phase.Connecting) }
            step(VoiciCallConnectStep.Path)
        }
        override fun onPathOpen() = step(VoiciCallConnectStep.Audio)
        override fun onConnected() {
            stopConnectClock()
            connectedAt = System.currentTimeMillis()
            update { it.copy(phase = Phase.Connected, step = null, slow = false) }
        }
        override fun onEnded(reason: String) = finish(reason)
        override fun onRemoteCamera(state: String) {
            update { it.copy(remoteCamera = state) }
        }
    }

    /**
     * The call history keeps calls that rang here (docs/voici-calls.md "Calling from the app"), on this device only.
     * A call whose request never arrived (locked, never joined) is left to the missed calls `.com` holds.
     */
    private fun recordIncoming(request: VoiciCallRequest?, code: String) {
        val r = request ?: return
        val started = connectedAt
        val outcome = VoiciCallHistory.incomingOutcome(code, started != null) ?: return
        val now = System.currentTimeMillis()
        val rec = VoiciCallRecord(
            id = r.callId + "-in", callId = r.callId, direction = "in", outcome = outcome, conv = r.conv, pseudonymPub = r.from,
            media = r.media, at = started ?: r.issuedAt, durationMs = started?.let { now - it } ?: 0,
        )
        scope.launch { runCatching { VoiciCenter.shared?.recordCall(rec) } }
    }

    /** The address Telecom shows for a voi.ci call: never a phone number. */
    fun address(callId: String): Uri = Uri.fromParts("voici", callId, null)
}
