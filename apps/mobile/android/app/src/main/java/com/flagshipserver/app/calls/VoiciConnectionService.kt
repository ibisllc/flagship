// The self-managed Telecom side of a voi.ci call (docs/voici-calls.md §4): Telecom knows a call is ringing or
// active (so other call apps, Bluetooth headsets and Wear OS see it), and we draw every screen ourselves.

package com.flagshipserver.app.calls

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telecom.VideoProfile

class VoiciConnection(private val service: ConnectionService) : Connection() {
    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        videoState = VideoProfile.STATE_AUDIO_ONLY
    }

    override fun onShowIncomingCallUi() = VoiciCallCenter.showIncoming(service)
    override fun onAnswer() = VoiciCallCenter.answer(service)
    override fun onAnswer(videoState: Int) = VoiciCallCenter.answer(service)
    override fun onReject() = VoiciCallCenter.decline()
    override fun onDisconnect() = VoiciCallCenter.hangUp()
    override fun onAbort() = VoiciCallCenter.hangUp()
}

class VoiciConnectionService : ConnectionService() {
    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val callId = request?.extras?.getString(VoiciCallCenter.EXTRA_CALL_ID) ?: ""
        return VoiciConnection(this).apply {
            setAddress(VoiciCallCenter.address(callId), TelecomManager.PRESENTATION_ALLOWED)
            setCallerDisplayName(VoiciCallCenter.ui.value.name, TelecomManager.PRESENTATION_ALLOWED)
            setRinging()
            VoiciCallCenter.connection = this
        }
    }

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        // Telecom won't ring it (another call is active): our own notification still does.
        VoiciCallCenter.showIncoming(this)
    }
}

/** Decline (ringing) and Hang up (ongoing) from the call notification. */
class VoiciCallActionReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
        when (intent.action) {
            DECLINE -> VoiciCallCenter.decline()
            HANG_UP -> VoiciCallCenter.hangUp()
        }
    }

    companion object {
        const val DECLINE = "com.flagshipserver.app.calls.DECLINE"
        const val HANG_UP = "com.flagshipserver.app.calls.HANG_UP"
    }
}

internal fun disconnectCause(code: String): DisconnectCause = DisconnectCause(
    when (code) {
        "answered-elsewhere" -> DisconnectCause.ANSWERED_ELSEWHERE
        "decline" -> DisconnectCause.REJECTED
        "hangup" -> DisconnectCause.LOCAL
        "no-answer", "cancel" -> DisconnectCause.MISSED
        else -> DisconnectCause.REMOTE
    },
)
