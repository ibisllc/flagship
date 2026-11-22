// The voi.ci call screen (docs/voici-calls.md §8, "Call screen"; voici-calls-v2.md §1.4): the ringing screen
// (Decline / Answer), the call (VoiciCallStage: audio route, Mute, Camera, Flip, End), and the line that says why a
// call ended. Shown over the lock screen by the full-screen notification. The microphone is asked for on Answer and the camera on the Camera tap, never
// before; leaving the screen pauses our camera, and the caller sees "Camera paused".

package com.flagshipserver.app.calls

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.R
import com.flagshipserver.app.ui.theme.FlagshipTheme

class VoiciCallActivity : ComponentActivity() {
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { VoiciCallCenter.answer(this) }
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) VoiciCallCenter.setCamera(this, true) else cameraRefused = true
    }
    private var cameraRefused by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        handle(intent)
        setContent { FlagshipTheme { CallScreen() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        VoiciCallCenter.onScreenVisible()
    }

    override fun onStop() {
        super.onStop()
        VoiciCallCenter.onScreenHidden()
    }

    private fun handle(intent: Intent?) {
        if (intent?.action == ACTION_ANSWER) answer()
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun unlockToAnswer() {
        VoiciCallCenter.unlockToAnswer()
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun answer() {
        // The notification's Answer on a phone whose app is locked: the unlock is the answer.
        if (VoiciCallCenter.ui.value.phase == VoiciCallCenter.Phase.NeedsUnlock) return unlockToAnswer()
        if (granted(Manifest.permission.RECORD_AUDIO)) VoiciCallCenter.answer(this) else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun toggleCamera(on: Boolean) {
        cameraRefused = false
        if (!on) VoiciCallCenter.setCamera(this, false)
        else if (granted(Manifest.permission.CAMERA)) VoiciCallCenter.setCamera(this, true)
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    @Composable
    private fun CallScreen() {
        val ui by VoiciCallCenter.ui.collectAsState()
        when (ui.phase) {
            VoiciCallCenter.Phase.Ringing -> VoiciRingingStage(ui.name, statusLine(ui), onDecline = { VoiciCallCenter.decline() }, onAnswer = { answer() }, onOpenApp = null)
            VoiciCallCenter.Phase.NeedsUnlock -> VoiciRingingStage(
                ui.name,
                statusLine(ui),
                onDecline = {
                    VoiciCallCenter.decline()
                    finish()
                },
                onAnswer = null,
                onOpenApp = { unlockToAnswer() },
            )
            else -> {
                val over = ui.phase == VoiciCallCenter.Phase.Ended || ui.phase == VoiciCallCenter.Phase.Idle
                val slow = ui.phase == VoiciCallCenter.Phase.Connecting && ui.slow
                VoiciCallStage(
                    CallStageState(
                        name = ui.name,
                        status = if (slow) statusLine(ui) + "\n" + stringResource(R.string.voici_call_slow) else statusLine(ui),
                        connectedAt = if (ui.phase == VoiciCallCenter.Phase.Connected) ui.connectedAt else null,
                        muted = ui.muted,
                        cameraOn = ui.cameraOn,
                        cameraFront = ui.cameraFront,
                        remoteCameraOn = ui.phase == VoiciCallCenter.Phase.Connected && ui.remoteCamera == "on",
                        remoteCameraPaused = VoiciCallScreenModel.remoteCamera(ui) == VoiciCallScreenModel.RemoteCamera.Paused,
                        offersVideo = ui.video,
                        over = over,
                        media = VoiciCallCenter.mediaEngine,
                        notice = if (cameraRefused) stringResource(R.string.voici_call_camera_denied) else null,
                    ),
                    CallStageActions(
                        toggleMute = { VoiciCallCenter.setMuted(!ui.muted) },
                        toggleCamera = { toggleCamera(!ui.cameraOn) },
                        flipCamera = { VoiciCallCenter.flipCamera() },
                        hangUp = { VoiciCallCenter.hangUp() },
                        close = {
                            cameraRefused = false
                            finish()
                        },
                        dismissNotice = { cameraRefused = false },
                    ),
                    tag = "voici-call",
                )
            }
        }
    }

    @Composable
    private fun statusLine(ui: VoiciCallCenter.Ui): String = stringResource(VoiciCallScreenModel.status(ui))

    companion object {
        const val ACTION_ANSWER = "com.flagshipserver.app.calls.ANSWER"
    }
}

/** What the call screen shows for a state (pure, so the unit tests can pin it). */
object VoiciCallScreenModel {
    enum class RemoteCamera { On, Paused }

    fun status(ui: VoiciCallCenter.Ui): Int = when (ui.phase) {
        VoiciCallCenter.Phase.Ringing -> R.string.voici_call_incoming_title
        VoiciCallCenter.Phase.NeedsUnlock -> R.string.voici_call_unlock
        VoiciCallCenter.Phase.Connecting -> when (ui.step) {
            VoiciCallConnectStep.Route -> R.string.voici_call_step_route
            VoiciCallConnectStep.Secure -> R.string.voici_call_step_secure
            VoiciCallConnectStep.Path -> R.string.voici_call_step_path
            VoiciCallConnectStep.Audio -> R.string.voici_call_step_audio
            null -> R.string.voici_call_connecting
        }
        VoiciCallCenter.Phase.Connected -> R.string.voici_call_connected
        VoiciCallCenter.Phase.Idle, VoiciCallCenter.Phase.Ended -> when (ui.endCode) {
            "answered-elsewhere" -> R.string.voici_call_answered_elsewhere
            "media-unavailable" -> R.string.voici_call_media_unavailable
            "device-unsupported" -> R.string.voici_call_device_unsupported
            "failed" -> R.string.voici_call_failed
            "limit" -> R.string.voici_call_limit
            else -> R.string.voici_call_ended
        }
    }

    fun remoteCamera(ui: VoiciCallCenter.Ui): RemoteCamera? = when {
        ui.phase != VoiciCallCenter.Phase.Connected -> null
        ui.remoteCamera == "on" -> RemoteCamera.On
        ui.remoteCamera == "paused" -> RemoteCamera.Paused
        else -> null
    }
}
