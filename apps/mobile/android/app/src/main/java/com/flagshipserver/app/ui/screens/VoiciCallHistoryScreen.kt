// Social → Calls, behind the Social page's round call button (docs/voici-calls.md "Calling from the app",
// docs/social-tabs.md): "Who to call" on top, then the call history (incoming, outgoing and missed, newest
// first, kept on this device; missed calls from `.com`), Call / Video call on every page this account can call, and
// the call this app is placing. A visitor of this account's own page is rung back from their thread (tapping the
// row opens it), or with the row's Call back when they never wrote, only through the conversation's ring-back
// channel (VoiciCenter.callVisitor).

package com.flagshipserver.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
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
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.calls.CallAudioRouter
import com.flagshipserver.app.calls.CallStageActions
import com.flagshipserver.app.calls.CallStageState
import com.flagshipserver.app.calls.VoiciCallRecord
import com.flagshipserver.app.calls.VoiciCallStage
import com.flagshipserver.app.calls.VoiciCallTarget
import com.flagshipserver.app.calls.VoiciOutgoingCall
import com.flagshipserver.app.calls.VoiciOutgoingCalls
import com.flagshipserver.app.calls.VoiciOutgoingState
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.voici.CallVisitorOutcome
import com.flagshipserver.app.core.voici.SocialActivity
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
 * Call / Video call for a page this account can call. Before the call, the call-back pop-up (CallBackPrompt). The
 * microphone is asked for on the tap; a refusal still calls (the browser asks its own).
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
        CallBackPrompt(target, tagPrefix, onDismiss = { asking = null }) { allow ->
            asking = null
            allowBack = allow
            pendingVideo = video
            mic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

/**
 * The call-back question before a call (docs/voici-calls.md, owner wording 2026-11-23): "Let brisk-quartz call you
 * back?", "brisk-quartz won't learn who you are." with an info button that opens "About call-backs", then "Call and
 * allow call-back" (attaches this conversation's ring-back channel) or "Call without call-back".
 */
@Composable
private fun CallBackPrompt(target: VoiciCallTarget, tagPrefix: String, onDismiss: () -> Unit, onChoose: (Boolean) -> Unit) {
    val center = LocalVoiciCenter.current
    var about by remember { mutableStateOf(false) }
    val name = target.username
    if (about) {
        // This account's visitor name on the page when the account key is open (no prompt just to show it).
        val visitor = remember(target.pageId) { center?.ownVisitorName(target.pageId) }
        val points = listOf(
            if (visitor != null) stringResource(R.string.voici_call_back_about_name, name, visitor)
            else stringResource(R.string.voici_call_back_about_name_unknown, name),
            stringResource(R.string.voici_call_back_about_note),
            stringResource(R.string.voici_call_back_about_deleted, name),
            stringResource(R.string.voici_call_back_about_without, name),
        )
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { about = false },
            title = { Text(stringResource(R.string.voici_call_back_about_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("$tagPrefix-about-text")) {
                    points.forEach { p ->
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text("\u2022")
                            Text(p)
                        }
                    }
                }
            },
            confirmButton = { FSGhostButton(stringResource(R.string.back), { about = false }, modifier = Modifier.testTag("$tagPrefix-about-back")) },
        )
    } else {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.voici_call_back_prompt_title, name)) },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.voici_call_back_prompt_body, name), modifier = Modifier.weight(1f, fill = false))
                    IconButton(onClick = { about = true }, modifier = Modifier.testTag("$tagPrefix-about")) {
                        Icon(Icons.Outlined.Info, contentDescription = stringResource(R.string.voici_call_back_about_title))
                    }
                }
            },
            confirmButton = { FSPrimaryButton(stringResource(R.string.voici_call_and_allow_back), { onChoose(true) }, modifier = Modifier.testTag("$tagPrefix-allow-back")) },
            dismissButton = { FSGhostButton(stringResource(R.string.voici_call_without_back), { onChoose(false) }, modifier = Modifier.testTag("$tagPrefix-no-back")) },
        )
    }
}

/**
 * The call this app is placing, full screen over the app (the same stage as a call answered here, docs/voici-calls.md
 * "Call screen"): status then timer, audio route, Mute, Camera, Flip and End while it runs, Close when it is over.
 * Back leaves the call running; only End ends it.
 */
@Composable
fun VoiciOutgoingCallPanel(call: VoiciOutgoingCall) {
    val context = LocalContext.current
    val state by call.state.collectAsState()
    val muted by call.muted.collectAsState()
    val cameraOn by call.cameraOn.collectAsState()
    val cameraFront by call.cameraFront.collectAsState()
    val remoteCamera by call.remoteCamera.collectAsState()
    var cameraRefused by remember(call) { mutableStateOf(false) }
    val name = stringResource(R.string.voici_calls_peer_page, call.target.username)
    val over = state is VoiciOutgoingState.Ended || state is VoiciOutgoingState.Failed || state is VoiciOutgoingState.Browser
    val live = state is VoiciOutgoingState.Ringing || state is VoiciOutgoingState.Connecting || state is VoiciOutgoingState.Connected
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok && call.setCamera(true)) cameraRefused = false else cameraRefused = true
    }
    // The call's sound goes through AudioManager while it rings and runs (it has no Telecom connection).
    DisposableEffect(call, live) {
        if (live) CallAudioRouter.startOwnCall(context)
        onDispose { if (live) CallAudioRouter.stopOwnCall(context) }
    }
    Dialog(
        onDismissRequest = { if (over) VoiciOutgoingCalls.dismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnClickOutside = false),
    ) {
        VoiciCallStage(
            CallStageState(
                name = name,
                status = VoiciCopy.outgoingStatus(state, name),
                connectedAt = (state as? VoiciOutgoingState.Connected)?.since,
                muted = muted,
                cameraOn = cameraOn,
                cameraFront = cameraFront,
                remoteCameraOn = state is VoiciOutgoingState.Connected && remoteCamera == "on",
                remoteCameraPaused = state is VoiciOutgoingState.Connected && remoteCamera == "paused",
                offersVideo = call.video && (state is VoiciOutgoingState.Connecting || state is VoiciOutgoingState.Connected),
                over = over,
                media = call.media,
                notice = when {
                    cameraRefused -> stringResource(R.string.voici_call_camera_denied)
                    // A 32-bit x86 device hands every call it places to the browser: say why.
                    state is VoiciOutgoingState.Browser && com.flagshipserver.app.calls.CallSupport.unavailableOnThisDevice ->
                        stringResource(R.string.voici_call_device_unsupported)
                    else -> null
                },
            ),
            CallStageActions(
                toggleMute = { call.setMuted(!muted) },
                toggleCamera = {
                    cameraRefused = false
                    when {
                        cameraOn -> call.setCamera(false)
                        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED -> if (!call.setCamera(true)) cameraRefused = true
                        else -> camera.launch(Manifest.permission.CAMERA)
                    }
                },
                flipCamera = { call.flipCamera() },
                hangUp = { call.hangUp() },
                close = { VoiciOutgoingCalls.dismiss() },
                dismissNotice = { cameraRefused = false },
            ),
            tag = "outgoing-call",
        )
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
    val ringBackOff = remember(version) { center.ringBackOff() }
    val blocked = remember(version, messages) { center.blockedPseudonyms() }
    val callsOn = center.page.collectAsState().value.callsOn
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val toasts = com.flagshipserver.app.core.LocalToastCenter.current
    // Every missed call so far counts as seen once this page is open (the Social call button's count).
    LaunchedEffect(history) { center.callsSeen() }
    FSScreen(title = stringResource(R.string.voici_calls_header), onBack = { nav.popBackStack() }, titleTag = "calls-title") {
        current?.let { VoiciOutgoingCallPanel(it) }
        WhoToCall(center)
        if (history.isEmpty()) {
            FSEmptyState(title = stringResource(R.string.voici_calls_history_empty), icon = Icons.Outlined.Call, modifier = Modifier.testTag("calls-empty"))
        } else {
            FSGroup {
                history.forEachIndexed { i, r ->
                    // A row opens its conversation: on the page this account called, or the caller's thread on this
                    // account's page when one exists (a caller who never wrote has none, so the row doesn't open).
                    val open: (() -> Unit)? = when {
                        r.direction == "out" && r.callable -> ({ nav.navigate("visitor/${r.peerUsername}/${r.peerPageId}") })
                        r.direction != "out" && r.conv != null && messages.conversations.any { it.conv == r.conv } -> ({ nav.navigate("thread/${r.conv}") })
                        else -> null
                    }
                    // A caller who never wrote (nothing to open) is rung back from the row while their conversation still
                    // allows call-backs: the thread's ring-back path, with its sentences (ThreadScreen).
                    val callBack: (() -> Unit)? = if (open == null && r.offersCallBack(false, ringBackOff, blocked, callsOn)) ({
                        scope.launch {
                            when (val o = center.callVisitor(r.conv!!, r.video, r.threadPub)) {
                                is CallVisitorOutcome.Ringing -> toasts.success(FSStrings.get(R.string.voici_call_back_ringing))
                                CallVisitorOutcome.NoCallBack -> toasts.error(FSStrings.get(R.string.voici_call_back_off))
                                is CallVisitorOutcome.Failed -> toasts.error(VoiciCopy.callFailure(o.code))
                            }
                        }
                    }) else null
                    CallHistoryRow(r, nicknames, anonBlocked, onOpen = open, onCallBack = callBack) { conv, block ->
                        scope.launch { center.blockAnonymous(conv, block)?.let { toasts.error(VoiciCopy.sendError(it)) } }
                    }
                    if (i < history.size - 1) FSDivider(0.dp)
                }
            }
        }
        Text(stringResource(R.string.voici_calls_history_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * "Who to call": a voi.ci username or link today (phone numbers later). The page is checked under its account's key
 * as a call checks it, then the same call-back question and outgoing call as a row's Call button.
 */
@Composable
private fun WhoToCall(center: com.flagshipserver.app.core.voici.VoiciCenter) {
    val context = LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var input by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    var resolving by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<Pair<VoiciCallTarget, Boolean>?>(null) }
    var pending by remember { mutableStateOf<Triple<VoiciCallTarget, Boolean, Boolean>?>(null) }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        pending?.let { (t, video, allow) -> VoiciOutgoingCalls.start(context, t, video, allowCallBack = allow) }
        pending = null
    }
    val invalid = stringResource(R.string.social_call_target_invalid)
    val call = { video: Boolean ->
        val host = com.flagshipserver.app.core.Endpoints.voiciOrigin.removePrefix("https://")
        val username = com.flagshipserver.app.calls.VoiciCallTargetInput.username(input, host)
        if (username == null) {
            problem = invalid
        } else if (!resolving) {
            resolving = true
            scope.launch {
                problem = try {
                    val keys = center.accountKeys(username)
                    val raw = if (keys != null) center.client.page(username) else null
                    val idx = if (keys != null && raw != null) {
                        com.flagshipserver.app.core.voici.VoiciPage.checkVoiciPageIndex(raw, username, keys.sensitiveKind, keys.sensitivePub).valueOrNull()
                    } else null
                    when {
                        idx == null -> com.flagshipserver.app.core.FSStrings.get(R.string.social_call_target_no_page, username)
                        !idx.body.takesCalls -> com.flagshipserver.app.core.FSStrings.get(R.string.social_call_target_no_calls, username)
                        else -> {
                            asking = VoiciCallTarget(username, idx.body.pageId) to video
                            null
                        }
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    com.flagshipserver.app.core.FSStrings.get(R.string.social_call_target_no_page, username)
                }
                resolving = false
            }
        }
    }
    FSCard(modifier = Modifier.testTag("calls-who")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            com.flagshipserver.app.ui.components.OutlinedTextField(
                value = input,
                onValueChange = { input = it.take(256); problem = null },
                label = { Text(stringResource(R.string.social_who_to_call)) },
                placeholder = { Text(stringResource(R.string.social_who_to_call_hint)) },
                singleLine = true,
                isError = problem != null,
                supportingText = if (problem != null) { { Text(problem.orEmpty(), modifier = Modifier.testTag("calls-target-problem")) } } else null,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri,
                    imeAction = androidx.compose.ui.text.input.ImeAction.Go,
                ),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { call(false) }),
                modifier = Modifier.fillMaxWidth().testTag("calls-target"),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                val ready = input.isNotBlank() && !resolving
                FSPrimaryButton(stringResource(R.string.voici_call_action), { call(false) }, enabled = ready, modifier = Modifier.weight(1f).testTag("calls-target-audio"))
                FSSecondaryButton(stringResource(R.string.voici_call_video_action), { call(true) }, enabled = ready, modifier = Modifier.weight(1f).testTag("calls-target-video"))
            }
        }
    }
    asking?.let { (target, video) ->
        CallBackPrompt(target, "calls-target", onDismiss = { asking = null }) { allow ->
            asking = null
            pending = Triple(target, video, allow)
            mic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

@Composable
private fun CallHistoryRow(
    r: VoiciCallRecord,
    nicknames: Map<String, String>,
    anonBlocked: Set<String>,
    onOpen: (() -> Unit)?,
    onCallBack: (() -> Unit)?,
    onBlockAnonymous: (String, Boolean) -> Unit,
) {
    // An anonymous caller (an "anyone" page) has no thread: its row offers Block / Unblock instead.
    val anonConv = r.conv?.takeIf { r.pseudonymPub != null && r.pseudonymPub.length != 64 }
    val time = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(r.at))
    FSRow(
        title = VoiciCopy.callPeer(r, nicknames),
        subtitle = SocialActivity.callLength(r.durationMs).takeIf { r.outcome == "answered" }
            ?.let { stringResource(R.string.voici_calls_history_line_length, stringResource(VoiciCopy.callOutcome(r)), time, it) }
            ?: stringResource(R.string.voici_calls_history_line, stringResource(VoiciCopy.callOutcome(r)), time),
        icon = when {
            r.outcome == "missed" -> Icons.Outlined.CallMissed
            r.direction == "out" -> Icons.Outlined.CallMade
            else -> Icons.Outlined.CallReceived
        },
        onClick = if (anonConv == null) onOpen else null,
        trailing = when {
            r.callable -> ({ VoiciCallButtons(VoiciCallTarget(r.peerUsername!!, r.peerPageId!!), "calls-row") })
            onCallBack != null -> ({ FSGhostButton(stringResource(R.string.voici_call_back), onCallBack, modifier = Modifier.testTag("calls-row-call-back")) })
            anonConv != null -> ({
                val blocked = anonConv in anonBlocked
                FSGhostButton(stringResource(if (blocked) R.string.voici_menu_unblock else R.string.voici_menu_block), { onBlockAnonymous(anonConv, !blocked) }, modifier = Modifier.testTag("calls-row-anon-block"))
            })
            else -> null
        },
        modifier = Modifier.fillMaxWidth().testTag("calls-row"),
    )
}
