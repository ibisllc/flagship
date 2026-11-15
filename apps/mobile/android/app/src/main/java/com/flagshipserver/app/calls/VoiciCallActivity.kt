// The voi.ci call screen (docs/voici-calls.md §8; voici-calls-v2.md §1.4): incoming (Answer / Decline), the call
// (Mute, Camera, Hang up, "Quantum-safe call"), and the line that says why a call ended. Shown over the lock screen
// by the full-screen notification. The microphone is asked for on Answer and the camera on the Camera tap, never
// before; leaving the screen pauses our camera, and the caller sees "Camera paused".

package com.flagshipserver.app.calls

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.flagshipserver.app.MainActivity
import com.flagshipserver.app.R
import com.flagshipserver.app.core.fsString
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

    private fun answer() {
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
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(ui.name, style = MaterialTheme.typography.headlineMedium)
                Spacer(Modifier.height(8.dp))
                Text(statusLine(ui), style = MaterialTheme.typography.bodyLarge)
                remoteCameraLine(ui)?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.bodyMedium)
                }
                if (cameraRefused) {
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.voici_call_camera_denied), style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(32.dp))
                when (ui.phase) {
                    VoiciCallCenter.Phase.Ringing -> Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Button(onClick = { VoiciCallCenter.decline() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.voici_call_decline)) }
                        Button(onClick = { answer() }) { Text(stringResource(R.string.voici_call_answer)) }
                    }
                    VoiciCallCenter.Phase.NeedsUnlock -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Button(onClick = { startActivity(Intent(this@VoiciCallActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }) {
                            Text(stringResource(R.string.voici_call_open_app))
                        }
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = { VoiciCallCenter.decline(); finish() }) { Text(stringResource(R.string.voici_call_decline)) }
                    }
                    VoiciCallCenter.Phase.Connecting, VoiciCallCenter.Phase.Connected -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(onClick = { VoiciCallCenter.setMuted(!ui.muted) }) {
                            Text(stringResource(if (ui.muted) R.string.voici_call_unmute else R.string.voici_call_mute))
                        }
                        if (ui.video) OutlinedButton(onClick = { toggleCamera(!ui.cameraOn) }) {
                            Text(stringResource(if (ui.cameraOn) R.string.voici_call_camera_off else R.string.voici_call_camera))
                        }
                        Button(onClick = { VoiciCallCenter.hangUp() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.voici_call_hang_up)) }
                    }
                    VoiciCallCenter.Phase.Ended, VoiciCallCenter.Phase.Idle -> Button(onClick = { finish() }) { Text(stringResource(R.string.voici_call_close)) }
                }
            }
        }
    }

    @Composable
    private fun statusLine(ui: VoiciCallCenter.Ui): String = stringResource(VoiciCallScreenModel.status(ui))

    @Composable
    private fun remoteCameraLine(ui: VoiciCallCenter.Ui): String? = when (VoiciCallScreenModel.remoteCamera(ui)) {
        VoiciCallScreenModel.RemoteCamera.On -> fsString(R.string.voici_call_remote_camera_on, ui.name)
        VoiciCallScreenModel.RemoteCamera.Paused -> stringResource(R.string.voici_call_camera_paused)
        null -> null
    }

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
        VoiciCallCenter.Phase.Connecting -> R.string.voici_call_connecting
        VoiciCallCenter.Phase.Connected -> R.string.voici_call_connected
        VoiciCallCenter.Phase.Idle, VoiciCallCenter.Phase.Ended -> when (ui.endCode) {
            "answered-elsewhere" -> R.string.voici_call_answered_elsewhere
            "media-unavailable" -> R.string.voici_call_media_unavailable
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
