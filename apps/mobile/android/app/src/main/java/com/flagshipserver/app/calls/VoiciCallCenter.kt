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
        /** Our camera is the front one (the preview shows mirrored). */
        val cameraFront: Boolean = true,
        /** When the call connected (ms since the epoch): the call screen's timer runs from it. */
        val connectedAt: Long? = null,
        /** The caller's camera: "on", "off" or "paused". */
        val remoteCamera: String = "off",
        /** Why the call ended or couldn't connect, as a code the screen turns into a sentence. */
        val endCode: String? = null,
        /** While connecting: the step under way, and whether it has run longer than usual (VoiciCallConnectSteps). */
        val step: VoiciCallConnectStep? = null,
        val slow: Boolean = false,
    )

    const val CHANNEL_ID = "flagship.calls"
    const val QUIET_CHANNEL_ID = "flagship.calls.quiet"
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
    /** The call's media engine, for the call screen's video pictures. */
    val mediaEngine: CallMediaEngine? get() = media
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
     * A call that arrives at [nowMs] rings here only while fresh and inside the owner's business hours. The phone's own
     * Do Not Disturb applies to the incoming-call notification (see [ensureChannel]); the app keeps no quiet hours.
     */
    fun shouldRing(
        issuedAt: Long,
        nowMs: Long,
        /** The owner's call hours (synced between the owner's devices): outside them nothing rings, so it's missed. */
        hours: com.flagshipserver.app.core.voici.VoiciCallHours? = null,
    ): Boolean =
        nowMs - issuedAt <= VoiciCalls.RING_MS && com.flagshipserver.app.core.voici.VoiciCallHoursSettings.allow(hours, nowMs)

    fun onPush(context: Context, push: VoiciCallPush.Payload) {
        app = context.applicationContext
        val store = CallSettingsStore(app)
        // Outside the owner's business hours the device stays out of the room: nothing rings, and the unanswered call
        // becomes a missed call.
        if (!shouldRing(push.issuedAt, System.currentTimeMillis(), hours = store.callHours())) return
        if (session != null || pendingPush != null) return
        pendingPush = push
        update { Ui(phase = Phase.Ringing, callId = push.callId, name = FSStrings.get(R.string.voici_call_someone)) }
        scope.launch {
            val keys = runCatching { VoiciCenter.shared?.callKeys() }.getOrNull()
                // "Answer calls while Flagship is locked" is on: the call key answers; the caller stays "Someone on voi.ci".
                ?: runCatching { VoiciCenter.shared?.lockedCallKeys() }.getOrNull()
            if ((keys == null || !startSession(push, keys)) && session == null) update { it.copy(phase = Phase.NeedsUnlock) }
            ring(push)
        }
        // A ring that never joined the room (locked and never unlocked) learns nothing from the caller: end it when
        // the ring time is up, or Telecom keeps it ringing and every later call is ignored as busy.
        scope.launch {
            kotlinx.coroutines.delay((push.issuedAt + VoiciCalls.RING_MS - System.currentTimeMillis()).coerceAtLeast(0L))
            if (pendingPush === push && session == null) finish("no-answer")
        }
    }

    private val joinLock = Any()

    /** Joins the room once per call: the unlock fires several signals at once, and a second socket for the same device
     *  would get the room's "won" too and end the call; the answering one would then be left open, so `.com` keeps the
     *  account "on another call". Returns false when a session already exists. */
    private fun startSession(push: VoiciCallPush.Payload, keys: VoiciCallKeys): Boolean = synchronized(joinLock) {
        if (session != null || pendingPush !== push) return false
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
        lateinit var s: VoiciCallSession
        s = VoiciCallSession(push, keys, m, http, scope, listenerFor { s })
        session = s
        s.connect()
        true
    }

    /** The account was unlocked while a call rings: join the room now. */
    fun onUnlocked() {
        val push = pendingPush ?: return
        if (session != null) return
        scope.launch {
            val keys = runCatching { VoiciCenter.shared?.callKeys() }.getOrNull() ?: return@launch
            if (!startSession(push, keys)) return@launch
            update { it.copy(phase = Phase.Ringing) }
            // The unlock lands on Home: bring the call screen forward so Answer is in front of the owner.
            if (::app.isInitialized) runCatching {
                app.startActivity(Intent(app, VoiciCallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            }
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

    /**
     * The calls channel never bypasses Do Not Disturb (no setBypassDnd), and every ring is a CATEGORY_CALL notification
     * on it: while the phone is in Do Not Disturb, Android lets it sound and go full screen only when the user's
     * Do Not Disturb allows calls. The self-managed Telecom connection does not ring by itself; its incoming UI is this
     * notification (VoiciConnection.onShowIncomingCallUi).
     */
    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, FSStrings.get(R.string.voici_call_channel), NotificationManager.IMPORTANCE_HIGH).apply {
                description = FSStrings.get(R.string.voici_call_channel_desc)
            },
        )
        // The call in progress, and a ring while the call screen is already in front: no heads-up over the call screen.
        mgr.createNotificationChannel(
            NotificationChannel(QUIET_CHANNEL_ID, FSStrings.get(R.string.voici_call_channel_quiet), NotificationManager.IMPORTANCE_LOW),
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

    /** The call screen is in front: the incoming notification moves to the quiet channel, so no heads-up covers it. */
    @Volatile private var screenVisible = false

    /** The incoming-call notification: full-screen on a locked phone, a heads-up otherwise; quiet while the call screen shows. */
    fun showIncoming(context: Context, quiet: Boolean = screenVisible) {
        ensureChannel(context)
        val caller = Person.Builder().setName(_ui.value.name).setImportant(true).build()
        val b = NotificationCompat.Builder(context, if (quiet) QUIET_CHANNEL_ID else CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setContentTitle(FSStrings.get(R.string.voici_call_incoming_title))
            .setContentText(FSStrings.get(R.string.voici_call_incoming_from, _ui.value.name))
            .setContentIntent(activityIntent(context, null))
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, broadcast(context, VoiciCallActionReceiver.DECLINE), activityIntent(context, VoiciCallActivity.ACTION_ANSWER)))
            .setTimeoutAfter(VoiciCalls.RING_MS)
        if (!quiet) b.setFullScreenIntent(activityIntent(context, null), true)
        val n = b.build()
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, n)
    }

    fun ongoingNotification(context: Context) = NotificationCompat.Builder(context.also { ensureChannel(it) }, QUIET_CHANNEL_ID)
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
        update { it.copy(cameraOn = on, cameraFront = if (on && !it.cameraOn) true else it.cameraFront) }
        if (on) VoiciCallService.start(context)
        return true
    }

    /** Front or back camera while ours runs. */
    fun flipCamera() {
        if (!_ui.value.cameraOn || media?.flipCamera() != true) return
        update { it.copy(cameraFront = !it.cameraFront) }
    }

    /** The call screen left the foreground: pause our camera (voici-calls-v2.md §1.4). */
    fun onScreenHidden() {
        screenVisible = false
        if (!_ui.value.cameraOn) return
        media?.setCamera(false)
        session?.sendCamera("paused")
        pausedByBackground = true
        update { it.copy(cameraOn = false) }
    }

    fun onScreenVisible() {
        screenVisible = true
        val phase = _ui.value.phase
        // Only over an unlocked phone: on the lock screen the ring is the full-screen intent, never a heads-up.
        val locked = ::app.isInitialized && (app.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked
        if (::app.isInitialized && !locked && (phase == Phase.Ringing || phase == Phase.NeedsUnlock)) showIncoming(app, quiet = true)
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
        val ending = session
        session = null
        // Whatever ended the call, its room socket closes too (a no-op when the session ended it): an open one would
        // keep `.com` holding the account as "on another call".
        ending?.leave()
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
        CallAudioRouter.reset()
        update { it.copy(phase = Phase.Ended, endCode = code, cameraOn = false, step = null, slow = false, connectedAt = null) }
    }

    /** Events count only from the call's current session; a stray one (a duplicate join) is ignored. */
    private fun listenerFor(owner: () -> VoiciCallSession) = object : VoiciCallSession.Listener {
        private fun current() = session === owner()
        override fun onRequest(request: VoiciCallRequest) {
            if (current()) update { it.copy(video = request.hasVideo) }
        }
        override fun onWon() {
            if (!current()) return
            update { it.copy(phase = Phase.Connecting) }
            step(VoiciCallConnectStep.Path)
        }
        override fun onPathOpen() {
            if (current()) step(VoiciCallConnectStep.Audio)
        }
        override fun onConnected() {
            if (!current()) return
            stopConnectClock()
            val at = System.currentTimeMillis()
            connectedAt = at
            update { it.copy(phase = Phase.Connected, step = null, slow = false, connectedAt = at) }
        }
        override fun onEnded(reason: String) {
            if (current()) finish(reason)
        }
        override fun onRemoteCamera(state: String) {
            if (current()) update { it.copy(remoteCamera = state) }
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
