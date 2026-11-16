// Social → Calls (docs/voici-calls.md "Calling from the app"): the call history (incoming, outgoing and missed, newest
// first, kept on this device; missed calls from `.com`), Call / Video call on every page this account can call, and
// the call this app is placing. A visitor of this account's own page is rung back from their thread (tapping the
// row opens it), only through the conversation's ring-back channel (VoiciCenter.callVisitor).

package com.flagshipserver.app.ui.screens

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.CallMade
import androidx.compose.material.icons.outlined.CallMissed
import androidx.compose.material.icons.outlined.CallReceived
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.calls.VoiciCallRecord
import com.flagshipserver.app.calls.VoiciCallTarget
import com.flagshipserver.app.calls.VoiciOutgoingCall
import com.flagshipserver.app.calls.VoiciOutgoingCalls
import com.flagshipserver.app.calls.VoiciOutgoingState
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/**
 * Call / Video call for a page this account can call. Before the call, the call-back pop-up (docs/voici-calls.md,
 * owner additions): "Call and allow call-back" attaches this conversation's ring-back channel, "Call without
 * call-back" doesn't. The microphone is asked for on the tap; a refusal still calls (the browser asks its own).
 */
@Composable
fun VoiciCallButtons(target: VoiciCallTarget, tagPrefix: String = "call") {
    val context = LocalContext.current
    var pendingVideo by remember { mutableStateOf<Boolean?>(null) }
    var allowBack by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<Boolean?>(null) }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        pendingVideo?.let { v -> VoiciOutgoingCalls.start(context, target, v, allowCallBack = allowBack) }
        pendingVideo = null
    }
    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSGhostButton(stringResource(R.string.voici_call_action), { asking = false }, modifier = Modifier.testTag("$tagPrefix-audio"))
        FSGhostButton(stringResource(R.string.voici_call_video_action), { asking = true }, modifier = Modifier.testTag("$tagPrefix-video"))
    }
    asking?.let { video ->
        val name = stringResource(R.string.voici_calls_peer_page, target.username)
        val go = { allow: Boolean ->
            asking = null
            allowBack = allow
            pendingVideo = video
            mic.launch(Manifest.permission.RECORD_AUDIO)
        }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { asking = null },
            title = { Text(stringResource(R.string.voici_call_back_prompt_title, name)) },
            text = { Text(stringResource(R.string.voici_call_back_prompt_body, name)) },
            confirmButton = { FSPrimaryButton(stringResource(R.string.voici_call_and_allow_back), { go(true) }, modifier = Modifier.testTag("$tagPrefix-allow-back")) },
            dismissButton = { FSGhostButton(stringResource(R.string.voici_call_without_back), { go(false) }, modifier = Modifier.testTag("$tagPrefix-no-back")) },
        )
    }
}

/** The call this app is placing: its status, and Mute / Camera / Hang up while it runs, Close when it is over. */
@Composable
fun VoiciOutgoingCallPanel(call: VoiciOutgoingCall) {
    val state by call.state.collectAsState()
    val name = stringResource(R.string.voici_calls_peer_page, call.target.username)
    var muted by remember(call) { mutableStateOf(false) }
    var cameraOn by remember(call) { mutableStateOf(false) }
    val over = state is VoiciOutgoingState.Ended || state is VoiciOutgoingState.Failed || state is VoiciOutgoingState.Browser
    FSCard(modifier = Modifier.testTag("outgoing-call")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(name, style = MaterialTheme.typography.titleMedium)
            Text(VoiciCopy.outgoingStatus(state, name), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("outgoing-call-status"))
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (over) {
                    FSSecondaryButton(stringResource(R.string.voici_call_close), { VoiciOutgoingCalls.dismiss() }, modifier = Modifier.testTag("outgoing-call-close"))
                } else {
                    FSGhostButton(stringResource(if (muted) R.string.voici_call_unmute else R.string.voici_call_mute), {
                        muted = !muted
                        call.setMuted(muted)
                    }, modifier = Modifier.testTag("outgoing-call-mute"))
                    if (call.video) {
                        FSGhostButton(stringResource(if (cameraOn) R.string.voici_call_camera_off else R.string.voici_call_camera), {
                            if (call.setCamera(!cameraOn)) cameraOn = !cameraOn
                        }, modifier = Modifier.testTag("outgoing-call-camera"))
                    }
                    FSPrimaryButton(stringResource(R.string.voici_call_hang_up), { call.hangUp() }, modifier = Modifier.testTag("outgoing-call-hang-up"))
                }
            }
        }
    }
}

@Composable
fun VoiciCallHistoryScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return
    val messages by center.messages.collectAsState()
    val version by center.callHistoryVersion.collectAsState()
    val current by VoiciOutgoingCalls.current.collectAsState()
    LaunchedEffect(center) { runCatching { center.refreshInbox() } }
    val history = remember(version, messages.missedCalls) { center.callHistory() }
    val nicknames = messages.state.nicknames.mapValues { it.value.name }
    val anonBlocked = remember(version) { center.anonBlocks() }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val toasts = com.flagshipserver.app.core.LocalToastCenter.current
    FSScreen(title = stringResource(R.string.voici_calls_header), onBack = { nav.popBackStack() }, titleTag = "calls-title") {
        current?.let { VoiciOutgoingCallPanel(it) }
        if (history.isEmpty()) {
            FSEmptyState(title = stringResource(R.string.voici_calls_history_empty), icon = Icons.Outlined.Call, modifier = Modifier.testTag("calls-empty"))
        } else {
            FSGroup {
                history.forEachIndexed { i, r ->
                    CallHistoryRow(r, nicknames, anonBlocked, onOpenThread = { conv -> nav.navigate("thread/$conv") }) { conv, block ->
                        scope.launch { center.blockAnonymous(conv, block)?.let { toasts.error(VoiciCopy.sendError(it)) } }
                    }
                    if (i < history.size - 1) FSDivider(0.dp)
                }
            }
        }
        Text(stringResource(R.string.voici_calls_history_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun CallHistoryRow(r: VoiciCallRecord, nicknames: Map<String, String>, anonBlocked: Set<String>, onOpenThread: (String) -> Unit, onBlockAnonymous: (String, Boolean) -> Unit) {
    // An anonymous caller (an "anyone" page) has no thread: its row offers Block / Unblock instead.
    val anonConv = r.conv?.takeIf { r.pseudonymPub != null && r.pseudonymPub.length != 64 }
    val time = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(r.at))
    FSRow(
        title = VoiciCopy.callPeer(r, nicknames),
        subtitle = stringResource(R.string.voici_calls_history_line, stringResource(VoiciCopy.callOutcome(r)), time),
        icon = when {
            r.outcome == "missed" -> Icons.Outlined.CallMissed
            r.direction == "out" -> Icons.Outlined.CallMade
            else -> Icons.Outlined.CallReceived
        },
        onClick = if (anonConv == null) r.conv?.let { c -> { onOpenThread(c) } } else null,
        trailing = when {
            r.callable -> ({ VoiciCallButtons(VoiciCallTarget(r.peerUsername!!, r.peerPageId!!), "calls-row") })
            anonConv != null -> ({
                val blocked = anonConv in anonBlocked
                FSGhostButton(stringResource(if (blocked) R.string.voici_menu_unblock else R.string.voici_menu_block), { onBlockAnonymous(anonConv, !blocked) }, modifier = Modifier.testTag("calls-row-anon-block"))
            })
            else -> null
        },
        modifier = Modifier.fillMaxWidth().testTag("calls-row"),
    )
}
