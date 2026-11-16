// The one call this app is placing (docs/voici-calls.md "Calling from the app"), for the Calls screen and the Call
// buttons: built with the app's media engine (CallMediaFactory: our libwebrtc build, or the stub), the pinning factory's client for the
// room and the /qr-pipe handoff, and the system browser for the fallback.

package com.flagshipserver.app.calls

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciIntegrity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

object VoiciOutgoingCalls {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http by lazy { com.flagshipserver.app.core.HttpClientFactory.build().newBuilder().pingInterval(20, TimeUnit.SECONDS).build() }

    /** The device-integrity source attestations use (MainActivity sets Play Integrity; mock runs NONE). */
    @Volatile var integrity: VoiciIntegrity = VoiciIntegrity.NONE
    /** Seams for the mock gym: a scripted room and pipe instead of `.com`'s. */
    @Volatile var roomFactory: () -> VoiciCallerRoom = { LiveVoiciCallerRoom(http) }
    @Volatile var pipeFactory: () -> VoiciCallHandoffPipe = { LiveVoiciCallHandoffPipe(http) }
    /** The link the last handoff opened (the mock gym reads it; the browser gets it in an intent). */
    @Volatile var lastBrowserLink: String? = null
    @Volatile var openBrowserOverride: ((String) -> Unit)? = null
    /** A seam for tests and the mock gym; null = this build's engine (the stub hands the call to the browser). */
    @Volatile var engineFactory: (() -> CallMediaEngine)? = null

    private val _current = MutableStateFlow<VoiciOutgoingCall?>(null)
    val current: StateFlow<VoiciOutgoingCall?> = _current.asStateFlow()

    /** Calls [target]; false when a call is already going or there is no account here. */
    fun start(context: Context, target: VoiciCallTarget, video: Boolean, allowCallBack: Boolean = false): Boolean {
        val center = VoiciCenter.shared ?: return false
        val busy = _current.value?.state?.value
        if (busy != null && busy !is VoiciOutgoingState.Ended && busy !is VoiciOutgoingState.Failed && busy !is VoiciOutgoingState.Browser) return false
        val app = context.applicationContext
        val engine = engineFactory?.invoke() ?: CallMediaFactory.make(app)
        val call = center.outgoingCall(target, video, integrity, engine, roomFactory(), pipeFactory(), allowCallBack) { link ->
            lastBrowserLink = link
            openBrowserOverride?.invoke(link) ?: openInBrowser(app, link)
        }
        _current.value = call
        scope.launch { call.start() }
        return true
    }

    fun dismiss() {
        _current.value?.hangUp()
        _current.value = null
    }

    private fun openInBrowser(context: Context, link: String) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // No browser: the handoff times out and the call says it couldn't open one.
        }
    }
}
