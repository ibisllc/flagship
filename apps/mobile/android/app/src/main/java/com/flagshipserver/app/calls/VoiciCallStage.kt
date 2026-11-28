// The in-call screen (docs/voici-calls.md "Call screen"), the Android port of iOS VoiciCallStage.swift: the other
// person large on a dark background with the status, then the timer; one row of round controls (audio route, mute,
// camera, flip) above a red end button; in video their picture fills the screen and ours floats in a corner (drag it
// to another corner), a tap hides or shows the controls; the screen sleeps against the ear in an audio-only call on
// the earpiece. One stage for calls answered here (VoiciCallActivity) and calls placed from the app
// (VoiciOutgoingCallPanel); the ringing screen (VoiciRingingStage) has the same look.

package com.flagshipserver.app.calls

import android.content.Context
import android.os.PowerManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BluetoothAudio
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Headset
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.flagshipserver.app.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.roundToInt

/** What one in-call screen shows, from either side of the call (answered here, or placed from the app). */
data class CallStageState(
    val name: String,
    val status: String,
    /** When the call connected (ms since the epoch): the timer runs from it. */
    val connectedAt: Long?,
    val muted: Boolean,
    val cameraOn: Boolean,
    val cameraFront: Boolean,
    val remoteCameraOn: Boolean,
    val remoteCameraPaused: Boolean,
    /** The call negotiated video, so the camera can be turned on. */
    val offersVideo: Boolean,
    val over: Boolean,
    val media: CallMediaEngine?,
    /** A line over the stage (the camera was refused), tapped away. */
    val notice: String? = null,
)

class CallStageActions(
    val toggleMute: () -> Unit,
    val toggleCamera: () -> Unit,
    val flipCamera: () -> Unit,
    val hangUp: () -> Unit,
    val close: () -> Unit,
    val dismissNotice: () -> Unit = {},
)

/** The pure parts of the call screen, so the unit tests can pin them. */
object CallStageModel {
    /** m:ss, or h:mm:ss after an hour, with the locale's digits. */
    fun elapsed(ms: Long, locale: Locale = Locale.getDefault()): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return if (s >= 3600) String.format(locale, "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
        else String.format(locale, "%d:%02d", s / 60, s % 60)
    }

    /** The first letter of the name, for the large circle; "?" when there is none. */
    fun initial(name: String): String = name.trim().firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "?"

    /** The screen sleeps against the ear: a connected audio-only call on the earpiece. */
    fun proximity(videoMode: Boolean, over: Boolean, connected: Boolean, route: CallAudioRoute): Boolean =
        !videoMode && !over && connected && route == CallAudioRoute.Earpiece

    enum class Corner { TopStart, TopEnd, BottomStart, BottomEnd }

    /** The corner nearest to where a drag of the corner tile ended (its centre at [x], [y] in a [w] × [h] stage). */
    fun nearestCorner(x: Float, y: Float, w: Float, h: Float): Corner {
        val left = x < w / 2
        val top = y < h / 2
        return if (top) (if (left) Corner.TopStart else Corner.TopEnd) else (if (left) Corner.BottomStart else Corner.BottomEnd)
    }
}

// The design system's warm near-black and cream ink (as iOS CallStageColors and voi.ci), not a navy gradient.
internal val CallCanvas = Color(0xFF0F0E0C)
internal val CallInk = Color(0xFFECE7D6)
private val CallAvatar = Color(0xFF2E2B24)
private val CallRed = Color(0xFFE5393A)
private val CallGreen = Color(0xFF2FB457)

@Composable
fun VoiciCallStage(state: CallStageState, actions: CallStageActions, tag: String) {
    val context = LocalContext.current
    val routes by CallAudioRouter.routes.collectAsState()
    var controlsHidden by remember { mutableStateOf(false) }
    val showsRemoteVideo = state.remoteCameraOn && state.media?.hasRemoteVideo == true
    val videoMode = showsRemoteVideo || state.cameraOn
    LaunchedEffect(videoMode) {
        if (!videoMode) controlsHidden = false else CallAudioRouter.preferSpeakerForVideo(context)
    }
    LaunchedEffect(state.over) { if (state.over) controlsHidden = false }
    ProximityLock(CallStageModel.proximity(videoMode, state.over, state.connectedAt != null, routes.current))

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(CallCanvas)
            // Only a video call's stage taps to hide the controls. A disabled clickable would still merge every
            // label under it into one disabled node (TalkBack read the whole stage as one; tests found no status).
            .then(
                if (videoMode && !state.over) {
                    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                        controlsHidden = !controlsHidden
                    }
                } else {
                    Modifier
                },
            )
            .testTag(tag),
    ) {
        val stageW = maxWidth
        val stageH = maxHeight
        if (showsRemoteVideo) VideoPicture(state.media, local = false, mirror = false, Modifier.fillMaxSize(), stringResource(R.string.voici_call_their_camera))
        AnimatedVisibility(visible = !(controlsHidden && videoMode), enter = fadeIn(), exit = fadeOut()) {
            Box(Modifier.fillMaxSize()) {
                if (videoMode) {
                    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent, Color.Transparent, Color.Black.copy(alpha = 0.6f)))))
                }
                Column(
                    Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.height(if (showsRemoteVideo) 8.dp else stageH * 0.1f))
                    Header(state, compact = showsRemoteVideo, tag = tag)
                    Spacer(Modifier.weight(1f).height(16.dp))
                    Controls(state, actions, routes, tag)
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
        if (state.cameraOn) LocalTile(state, stageW.value, stageH.value, compact = showsRemoteVideo)
        state.notice?.let { n ->
            Text(
                n,
                color = CallInk,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .safeDrawingPadding()
                    .padding(16.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(CallInk.copy(alpha = 0.16f))
                    .clickable { actions.dismissNotice() }
                    .padding(12.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@Composable
private fun Header(state: CallStageState, compact: Boolean, tag: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(if (compact) 4.dp else 12.dp)) {
        if (!compact) Avatar(state.name, 112)
        Text(
            state.name,
            color = CallInk,
            style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { heading() },
        )
        StatusLine(state, compact, tag)
        if (!compact) E2eLine(Modifier.padding(top = 4.dp))
        if (state.remoteCameraPaused) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Filled.VideocamOff, contentDescription = null, tint = CallInk.copy(alpha = 0.75f), modifier = Modifier.size(16.dp))
                Text(stringResource(R.string.voici_call_camera_paused), color = CallInk.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun E2eLine(modifier: Modifier = Modifier) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = modifier) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = CallInk.copy(alpha = 0.55f), modifier = Modifier.size(14.dp))
        Text(stringResource(R.string.voici_call_e2e), color = CallInk.copy(alpha = 0.55f), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
}

@Composable
private fun StatusLine(state: CallStageState, compact: Boolean, tag: String) {
    val style = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.titleMedium
    val since = state.connectedAt
    val text = if (since != null && !state.over) {
        var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
        LaunchedEffect(since) {
            while (true) {
                now = System.currentTimeMillis()
                delay(1000 - (now - since) % 1000)
            }
        }
        CallStageModel.elapsed(now - since)
    } else state.status
    Text(
        text,
        color = CallInk.copy(alpha = 0.75f),
        style = style,
        textAlign = TextAlign.Center,
        modifier = Modifier.testTag("$tag-status").let { if (since == null || state.over) it.semantics { liveRegion = LiveRegionMode.Polite } else it },
    )
}

@Composable
private fun Avatar(name: String, sizeDp: Int) {
    Box(
        Modifier.size(sizeDp.dp).clip(CircleShape).background(CallAvatar).border(1.dp, CallInk.copy(alpha = 0.12f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(CallStageModel.initial(name), color = CallInk, fontSize = MaterialTheme.typography.displayMedium.fontSize, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun Controls(state: CallStageState, actions: CallStageActions, routes: CallAudioRoutes, tag: String) {
    if (state.over) {
        CallRoundButton(Icons.Filled.Close, stringResource(R.string.voici_call_close), CallButtonStyle.Plain, actions.close, Modifier.testTag("$tag-close"))
        return
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(28.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            AudioRouteButton(routes, Modifier.weight(1f).testTag("$tag-audio-route"))
            CallRoundButton(
                if (state.muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                stringResource(if (state.muted) R.string.voici_call_unmute else R.string.voici_call_mute),
                if (state.muted) CallButtonStyle.Selected else CallButtonStyle.Plain,
                actions.toggleMute,
                Modifier.weight(1f).testTag("$tag-mute"),
            )
            if (state.offersVideo) {
                CallRoundButton(
                    if (state.cameraOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                    stringResource(if (state.cameraOn) R.string.voici_call_camera_off else R.string.voici_call_camera),
                    if (state.cameraOn) CallButtonStyle.Selected else CallButtonStyle.Plain,
                    actions.toggleCamera,
                    Modifier.weight(1f).testTag("$tag-camera"),
                )
            }
            if (state.cameraOn) {
                CallRoundButton(Icons.Filled.Cameraswitch, stringResource(R.string.voici_call_flip), CallButtonStyle.Plain, actions.flipCamera, Modifier.weight(1f).testTag("$tag-flip"))
            }
        }
        CallRoundButton(Icons.Filled.CallEnd, stringResource(R.string.voici_call_end), CallButtonStyle.End, actions.hangUp, Modifier.testTag("$tag-end"))
    }
}

enum class CallButtonStyle { Plain, Selected, End, Answer }

/** One round control with its label under it. */
@Composable
fun CallRoundButton(icon: ImageVector, label: String, style: CallButtonStyle, onClick: () -> Unit, modifier: Modifier = Modifier, state: String? = null) {
    val fill = when (style) {
        CallButtonStyle.Plain -> CallInk.copy(alpha = 0.16f)
        CallButtonStyle.Selected -> CallInk
        CallButtonStyle.End -> CallRed
        CallButtonStyle.Answer -> CallGreen
    }
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                if (state != null) stateDescription = state
            }
            .padding(4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(68.dp).clip(CircleShape).background(fill), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = if (style == CallButtonStyle.Selected) CallCanvas else CallInk, modifier = Modifier.size(28.dp))
        }
        Text(label, color = CallInk, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }
}

@Composable
private fun routeName(r: CallAudioRoute): String = stringResource(
    when (r) {
        CallAudioRoute.Earpiece -> R.string.voici_call_route_phone
        CallAudioRoute.Speaker -> R.string.voici_call_route_speaker
        CallAudioRoute.Bluetooth -> R.string.voici_call_route_bluetooth
        CallAudioRoute.Wired -> R.string.voici_call_route_wired
    },
)

private fun routeIcon(r: CallAudioRoute): ImageVector = when (r) {
    CallAudioRoute.Earpiece -> Icons.Filled.PhoneInTalk
    CallAudioRoute.Speaker -> Icons.AutoMirrored.Filled.VolumeUp
    CallAudioRoute.Bluetooth -> Icons.Filled.BluetoothAudio
    CallAudioRoute.Wired -> Icons.Filled.Headset
}

/** Audio (earpiece, speaker, Bluetooth, headphones): a switch between the two built-in ones, or a menu with headsets. */
@Composable
private fun AudioRouteButton(routes: CallAudioRoutes, modifier: Modifier) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { CallAudioRouter.refresh(context) }
    Box(modifier, contentAlignment = Alignment.TopCenter) {
        CallRoundButton(
            if (routes.current == CallAudioRoute.Earpiece) Icons.AutoMirrored.Filled.VolumeUp else routeIcon(routes.current),
            stringResource(R.string.voici_call_audio),
            if (routes.current == CallAudioRoute.Speaker && !routes.needsMenu) CallButtonStyle.Selected else CallButtonStyle.Plain,
            { if (routes.needsMenu) menu = true else CallAudioRouter.select(context, routes.toggled) },
            state = routeName(routes.current),
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            routes.available.forEach { r ->
                DropdownMenuItem(
                    text = { Text(routeName(r)) },
                    leadingIcon = { Icon(routeIcon(r), contentDescription = null) },
                    trailingIcon = if (r == routes.current) ({ Icon(Icons.Filled.Check, contentDescription = null) }) else null,
                    onClick = {
                        menu = false
                        CallAudioRouter.select(context, r)
                    },
                )
            }
        }
    }
}

/** A camera picture from the media engine (theirs full screen, ours in the tile); nothing without video. */
@Composable
private fun VideoPicture(media: CallMediaEngine?, local: Boolean, mirror: Boolean, modifier: Modifier, description: String) {
    val context = LocalContext.current
    val v = remember(media, local) { media?.videoView(context, local) }
    DisposableEffect(v) { onDispose { v?.release() } }
    if (v == null) {
        Box(modifier.background(Color.Black).semantics { contentDescription = description })
        return
    }
    AndroidView(factory = { v.view }, modifier = modifier.semantics { contentDescription = description }, update = { v.setMirror(mirror) })
}

/** Our camera in a rounded corner tile: drag it, and it snaps to the nearest corner. */
@Composable
private fun LocalTile(state: CallStageState, stageW: Float, stageH: Float, compact: Boolean) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    // Low on the right while only our camera runs (clear of the name and status), top right over their video;
    // each layout keeps the corner it was last dragged to (as iOS and voi.ci).
    var selfCorner by remember { mutableStateOf(CallStageModel.Corner.BottomEnd) }
    var videoCorner by remember { mutableStateOf(CallStageModel.Corner.TopEnd) }
    val corner = if (compact) videoCorner else selfCorner
    fun moveTo(c: CallStageModel.Corner) { if (compact) videoCorner = c else selfCorner = c }
    val w = 104f
    val h = w * 16f / 9f
    val pad = 16f
    fun origin(c: CallStageModel.Corner): Pair<Float, Float> {
        val left = c == CallStageModel.Corner.TopStart || c == CallStageModel.Corner.BottomStart
        val top = c == CallStageModel.Corner.TopStart || c == CallStageModel.Corner.TopEnd
        val x = if (left) pad else stageW - pad - w
        val y = if (top) (if (compact) 96f else pad + 40f) else stageH - 252f - h
        return x to y.coerceAtLeast(pad)
    }
    val x = remember { Animatable(origin(corner).first) }
    val y = remember { Animatable(origin(corner).second) }
    LaunchedEffect(corner, stageW, stageH, compact) {
        val (tx, ty) = origin(corner)
        launch { x.animateTo(tx, spring(dampingRatio = 0.8f, stiffness = Spring.StiffnessMediumLow)) }
        launch { y.animateTo(ty, spring(dampingRatio = 0.8f, stiffness = Spring.StiffnessMediumLow)) }
    }
    val description = stringResource(R.string.voici_call_your_camera)
    Box(
        Modifier
            .offset { with(density) { IntOffset(x.value.dp.roundToPx(), y.value.dp.roundToPx()) } }
            .width(w.dp)
            .height(h.dp)
            .shadow(8.dp, RoundedCornerShape(14.dp))
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, CallInk.copy(alpha = 0.25f), RoundedCornerShape(14.dp))
            .pointerInput(stageW, stageH, compact) {
                detectDragGestures(
                    onDragEnd = { moveTo(CallStageModel.nearestCorner(x.value + w / 2, y.value + h / 2, stageW, stageH)) },
                    onDragCancel = { moveTo(CallStageModel.nearestCorner(x.value + w / 2, y.value + h / 2, stageW, stageH)) },
                ) { change, drag ->
                    change.consume()
                    scope.launch {
                        x.snapTo(x.value + drag.x / density.density)
                        y.snapTo(y.value + drag.y / density.density)
                    }
                }
            }
            .testTag("voici-call-local-video"),
    ) {
        VideoPicture(state.media, local = true, mirror = state.cameraFront, Modifier.fillMaxSize(), description)
    }
}

/** Keeps the screen dark while the phone is against the ear, for as long as [on]. */
@Composable
private fun ProximityLock(on: Boolean) {
    val context = LocalContext.current
    DisposableEffect(on) {
        val lock = if (on) proximityLock(context) else null
        lock?.acquire(70 * 60 * 1000L)
        onDispose { lock?.takeIf { it.isHeld }?.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
    }
}

private fun proximityLock(context: Context): PowerManager.WakeLock? {
    val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return null
    if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return null
    return pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "flagship:voici-call")
}

/**
 * The ringing screen (and the "unlock to answer" one) in the same look: the caller's initial and name, the status,
 * a red Decline and a green Answer (or Open Flagship while the account is locked).
 */
@Composable
fun VoiciRingingStage(name: String, status: String, onDecline: () -> Unit, onAnswer: (() -> Unit)?, onOpenApp: (() -> Unit)?) {
    Box(Modifier.fillMaxSize().background(CallCanvas)) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(80.dp))
            Avatar(name, 112)
            Spacer(Modifier.height(12.dp))
            Text(name, color = CallInk, style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(12.dp))
            Text(status, color = CallInk.copy(alpha = 0.75f), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, modifier = Modifier.testTag("voici-call-status").semantics { liveRegion = LiveRegionMode.Polite })
            Spacer(Modifier.height(16.dp))
            E2eLine()
            Spacer(Modifier.weight(1f))
            Row(Modifier.fillMaxWidth().padding(bottom = 32.dp), verticalAlignment = Alignment.Top) {
                CallRoundButton(Icons.Filled.CallEnd, stringResource(R.string.voici_call_decline), CallButtonStyle.End, onDecline, Modifier.weight(1f).testTag("voici-call-decline"))
                if (onOpenApp != null) {
                    CallRoundButton(Icons.Filled.LockOpen, stringResource(R.string.voici_call_open_app), CallButtonStyle.Plain, onOpenApp, Modifier.weight(1f).testTag("voici-call-open-app"))
                }
                if (onAnswer != null) {
                    CallRoundButton(Icons.Filled.Call, stringResource(R.string.voici_call_answer), CallButtonStyle.Answer, onAnswer, Modifier.weight(1f).testTag("voici-call-answer"))
                }
            }
        }
    }
}
