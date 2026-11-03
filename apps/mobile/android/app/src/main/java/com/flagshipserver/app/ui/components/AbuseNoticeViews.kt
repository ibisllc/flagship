// Abuse notices and suspension on screen (docs/abuse-handling.md §4-§5):
// the Home banner an admin device shows for each notice (with "I've done this"
// and "Appeal"), the full-screen "This account was suspended" every device of a
// suspended account shows, and the banner left once the person continues to
// their data (backups and LAN rescue keep working while suspended).

package com.flagshipserver.app.ui.components

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import com.flagshipserver.app.R
import com.flagshipserver.app.core.AbuseDoneResult
import com.flagshipserver.app.core.AbuseNoticeBannerModel
import com.flagshipserver.app.core.AbuseNoticeCenter
import com.flagshipserver.app.core.AbuseNoticeModels
import com.flagshipserver.app.core.AbuseNotices
import com.flagshipserver.app.core.AbuseSuspendedModel
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

private fun openMail(ctx: android.content.Context, mailto: String) {
    runCatching { ctx.startActivity(Intent(Intent.ACTION_SENDTO, mailto.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Home: one banner per notice, on admin devices only. Refreshes when Home shows. */
@Composable
fun AbuseNoticeHomeBanners(center: AbuseNoticeCenter? = AbuseNoticeCenter.shared) {
    if (center == null) return
    LaunchedEffect(center) { center.refresh() }
    val state by center.state.collectAsState()
    val app = LocalAppState.current
    val banners = remember(state) { AbuseNoticeModels.banners(state, center.admin()) }
    for (b in banners) AbuseNoticeCard(b, center, app.currentUser.value)
}

@Composable
private fun AbuseNoticeCard(model: AbuseNoticeBannerModel, center: AbuseNoticeCenter, username: String?) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var asking by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Surface(
        color = FS.colors.dangerWash,
        contentColor = FS.colors.text,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().testTag("abuse-notice-${model.id}").semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(4.dp).fillMaxHeight().background(FS.colors.danger))
            Column(
                Modifier.weight(1f).padding(horizontal = FS.space.s4, vertical = FS.space.s3),
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) {
                Text(model.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() }.testTag("abuse-notice-title"))
                Text(model.about, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("abuse-notice-about"))
                Text(model.reason, style = MaterialTheme.typography.bodyMedium)
                Text(model.whatToDo, style = MaterialTheme.typography.bodyMedium)
                Text(model.deadline, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.testTag("abuse-notice-deadline"))
                model.detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = FS.colors.textMuted) }
                Text(model.warning, style = MaterialTheme.typography.bodySmall)
                val done = model.doneLine
                if (done != null) {
                    Text(done, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("abuse-notice-done"))
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                        FSPrimaryButton(
                            label = stringResource(R.string.abuse_ive_done_this),
                            onClick = { error = null; asking = true },
                            modifier = Modifier.heightIn(min = 48.dp).testTag("abuse-notice-mark-done"),
                        )
                        FSGhostButton(
                            label = stringResource(R.string.abuse_appeal),
                            onClick = { openMail(ctx, AbuseNotices.appealMailto(username)) },
                            modifier = Modifier.heightIn(min = 48.dp).testTag("abuse-notice-appeal"),
                        )
                    }
                }
                error?.let { Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("abuse-notice-error")) }
            }
        }
    }
    if (asking) {
        AlertDialog(
            onDismissRequest = { if (!sending) asking = false },
            title = { Text(stringResource(R.string.abuse_done_dialog_title)) },
            text = {
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it.take(AbuseNotices.NOTE_MAX) },
                    label = { Text(stringResource(R.string.abuse_done_note_label)) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth().testTag("abuse-notice-note"),
                )
            },
            confirmButton = {
                FSPrimaryButton(
                    label = stringResource(R.string.abuse_send),
                    enabled = !sending,
                    onClick = {
                        sending = true
                        scope.launch {
                            val r = center.markDone(model.id, note)
                            sending = false
                            asking = false
                            error = (r as? AbuseDoneResult.Failed)?.message
                        }
                    },
                    modifier = Modifier.testTag("abuse-notice-send"),
                )
            },
            dismissButton = {
                FSGhostButton(label = stringResource(R.string.cancel), onClick = { asking = false }, enabled = !sending)
            },
        )
    }
}

/** The root's banner once the person continued to their data: "This account is suspended." + Details. */
@Composable
fun AbuseSuspendedBanner(center: AbuseNoticeCenter? = AbuseNoticeCenter.shared) {
    if (center == null) return
    val state by center.state.collectAsState()
    val dismissed by center.suspendedDismissed.collectAsState()
    if (state?.suspension == null || !dismissed) return
    Surface(color = FS.colors.dangerWash, contentColor = FS.colors.text, modifier = Modifier.fillMaxWidth().testTag("abuse-suspended-banner")) {
        Row(
            Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.abuse_suspended_banner), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            FSGhostButton(
                label = stringResource(R.string.abuse_details),
                onClick = { center.showSuspended() },
                modifier = Modifier.heightIn(min = 48.dp).testTag("abuse-suspended-details"),
            )
        }
    }
}

/** Whether the full-screen suspended screen is up now. */
@Composable
fun abuseSuspendedShowing(center: AbuseNoticeCenter? = AbuseNoticeCenter.shared): Boolean {
    if (center == null) return false
    val state by center.state.collectAsState()
    val dismissed by center.suspendedDismissed.collectAsState()
    return state?.suspension != null && !dismissed
}

@Composable
fun AbuseSuspendedScreen(center: AbuseNoticeCenter? = AbuseNoticeCenter.shared) {
    if (center == null) return
    val state by center.state.collectAsState()
    val app = LocalAppState.current
    val model = remember(state) { AbuseNoticeModels.suspended(state?.suspension, app.currentUser.value) } ?: return
    SuspendedCard(model, onContinue = { center.dismissSuspended() })
}

@Composable
private fun SuspendedCard(model: AbuseSuspendedModel, onContinue: () -> Unit) {
    val ctx = LocalContext.current
    Box(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics { paneTitle = model.title }
            .testTag("abuse-suspended"),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .widthIn(max = 440.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = FS.space.s6, vertical = FS.space.s6),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Text(
                model.title,
                color = FS.colors.text,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.semantics { heading() }.testTag("abuse-suspended-title"),
            )
            Text(model.reason, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp), modifier = Modifier.testTag("abuse-suspended-reason"))
            if (model.operatorReason.isNotBlank()) {
                Text(model.operatorReason, color = FS.colors.textMuted, style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp))
            }
            Text(model.offline, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp))
            Text(model.dataStays, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp), modifier = Modifier.testTag("abuse-suspended-data"))
            Text(model.appealLine, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp))
            FSPrimaryButton(
                label = stringResource(R.string.abuse_appeal),
                onClick = { openMail(ctx, model.appealMailto) },
                block = true,
                large = true,
                modifier = Modifier.testTag("abuse-suspended-appeal"),
            )
            FSGhostButton(
                label = stringResource(R.string.abuse_continue_to_data),
                onClick = onContinue,
                block = true,
                modifier = Modifier.testTag("abuse-suspended-continue"),
            )
        }
    }
}
