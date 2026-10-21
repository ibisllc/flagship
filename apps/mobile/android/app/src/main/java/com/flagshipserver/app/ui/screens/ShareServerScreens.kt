// Share this server (docs/share-a-server.md §8): the owner's "Shared with"
// and Activity cards with the share sheet, and the other account's accept
// screen, "Shared with me" section and restricted server page.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import android.Manifest
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import com.flagshipserver.app.ui.components.RadioButton
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.components.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import com.flagshipserver.app.api.AccessRequest
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.core.AcceptedShare
import com.flagshipserver.app.core.ActiveShare
import com.flagshipserver.app.core.ActivityEntry
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.PendingShare
import com.flagshipserver.app.core.QrImage
import com.flagshipserver.app.core.ServerShare
import com.flagshipserver.app.core.ShareOptions
import com.flagshipserver.app.core.ShareCoInviteCopy
import com.flagshipserver.app.core.ShareStartup
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.plural
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSListLeading
import com.flagshipserver.app.ui.components.FSListRow
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.LocalServerShares
import com.flagshipserver.app.viewmodels.OwnerShareUi
import com.flagshipserver.app.viewmodels.OwnerShareViewModel
import com.flagshipserver.app.viewmodels.ServerAppsViewModel
import com.flagshipserver.app.viewmodels.ShareAcceptViewModel
import com.flagshipserver.app.viewmodels.ShareCopy
import com.flagshipserver.app.viewmodels.SharedItem
import com.flagshipserver.app.viewmodels.SharedServerUi
import com.flagshipserver.app.viewmodels.SharedServerViewModel
import com.flagshipserver.app.viewmodels.SharedWithMeUi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ── Shared bits ────────────────────────────────────────────────────────────

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    FSSectionHeader(text, modifier = modifier)
}

@Composable
private fun Muted(text: String, modifier: Modifier = Modifier, size: Int = 13) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = when {
            size >= 15 -> MaterialTheme.typography.bodyLarge
            size >= 13 -> MaterialTheme.typography.bodyMedium
            else -> MaterialTheme.typography.bodySmall
        },
        modifier = modifier,
    )
}

@Composable
private fun SasText(sas: String, modifier: Modifier = Modifier) {
    Text(
        ShareCopy.sas(sas),
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.displaySmall.copy(fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp),
        modifier = modifier,
    )
}

@Composable
private fun OptionSwitch(title: String, line: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit, tag: String) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
            Muted(line, size = 12)
        }
        Spacer(Modifier.width(FS.space.s3))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled, modifier = Modifier.testTag(tag))
    }
}

@Composable
private fun LevelChoice(level: String, onChange: (String) -> Unit, enabled: Boolean = true) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        listOf(
            Triple(ServerShare.LEVEL_VIEW, ShareCopy.CAN_VIEW, ShareCopy.VIEW_LINE),
            Triple(ServerShare.LEVEL_MANAGE, ShareCopy.CAN_MANAGE, ShareCopy.MANAGE_LINE),
        ).forEach { (value, title, line) ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = enabled) { onChange(value) }
                    .testTag("share-level-$value"),
            ) {
                RadioButton(selected = level == value, onClick = { onChange(value) }, enabled = enabled)
                Column(Modifier.weight(1f)) {
                    Text(title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                    Muted(line, size = 12)
                }
            }
        }
    }
}

private fun shareText(ctx: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    ctx.startActivity(Intent.createChooser(send, FSStrings.get(R.string.share_server_link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

// ── Owner: "Shared with" + Activity on the server's page ──────────────────

/** The owner's cards on a server's page; renders nothing without the live share runtime. */
@Composable
fun ShareServerCard(serverDomain: String, podId: String) {
    val runtime = LocalServerShares.current ?: return
    val app = LocalAppState.current
    val sessions = LocalSessionStore.current
    val toasts = LocalToastCenter.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val pods by app.pods.collectAsState()
    val username by app.currentUser.collectAsState()
    val pod = pods.firstOrNull { it.podId == podId } ?: return
    val user = username?.takeIf { it.isNotEmpty() } ?: return
    val serverName = pod.name.ifBlank { serverDomain.substringBefore('.') }
    val vm = remember(serverDomain, user, pod.identityPubKeyHex) {
        OwnerShareViewModel(
            client = runtime.client,
            username = user,
            serverDomain = serverDomain,
            serverName = serverName,
            stkPubHex = pod.identityPubKeyHex,
            ownerSession = {
                sessions.sessionToken(forPodId = podId)
                    ?: sessions.sessionToken.value.takeIf { app.currentPod?.podId == podId }
                    ?: runtime.ownerSession(podId)
            },
        )
    }
    val ui by vm.ui.collectAsState()
    val message by vm.message.collectAsState()
    var sheetOpen by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<Pair<String, String>?>(null) }
    LaunchedEffect(vm) { vm.load() }
    LaunchedEffect(message) {
        message?.let {
            toasts.warning(it)
            vm.clearMessage()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s6)) {
    ShareServerCardContent(
        ui = ui,
        readOnly = LocalServerReadOnly.current,
        onShare = { sheetOpen = true },
        onConfirm = { s -> scope.launch { if (vm.confirm(s)) toasts.success(FSStrings.get(R.string.can_now_use_this_server, s.label)) } },
        onNoMatch = { s -> removing = s.shareId to s.label },
        onLevel = { s, level -> scope.launch { vm.change(s, level = level) } },
        onUnlock = { s, on -> scope.launch { vm.change(s, unlockAtBoot = on) } },
        onData = { s, on -> scope.launch { vm.change(s, seeAppData = on) } },
        onRemove = { s -> removing = s.shareId to s.label },
        onCopy = { p ->
            clipboard.setText(AnnotatedString(p.link))
            toasts.success(FSStrings.get(R.string.link_copied_2))
        },
        onCancelOffer = { p -> scope.launch { if (vm.cancel(p)) toasts.success(FSStrings.get(R.string.link_cancelled)) } },
    )
    if (ui.activity.isNotEmpty()) {
        ShareActivityCard(ui.activity)
    }
    }

    removing?.let { (id, label) ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(fsString(R.string.stop_sharing_with, label)) },
            text = { Text(fsString(R.string.loses_access_to_at_once_to, label, serverName)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        removing = null
                        scope.launch { if (vm.remove(id, label)) toasts.success(FSStrings.get(R.string.no_longer_has_access, label)) }
                    },
                    modifier = Modifier.testTag("share-remove-confirm"),
                ) { Text(stringResource(R.string.stop_sharing), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.keep)) } },
        )
    }

    if (sheetOpen) {
        ShareServerSheet(
            serverName = serverName,
            onCreate = { options -> vm.create(options)?.link },
            onClose = { sheetOpen = false },
        )
    }
}

@Composable
fun ShareServerCardContent(
    ui: OwnerShareUi,
    /** A device without the admin root: every share order would be refused. */
    readOnly: Boolean = false,
    onShare: () -> Unit,
    onConfirm: (AcceptedShare) -> Unit,
    onNoMatch: (AcceptedShare) -> Unit,
    onLevel: (ActiveShare, String) -> Unit,
    onUnlock: (ActiveShare, Boolean) -> Unit,
    onData: (ActiveShare, Boolean) -> Unit,
    onRemove: (ActiveShare) -> Unit,
    onCopy: (PendingShare) -> Unit,
    onCancelOffer: (PendingShare) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
    SectionTitle(stringResource(R.string.shared_with), Modifier.testTag("share-card-title"))
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("share-server-card")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
            val shares = ui.shares
            when {
                ui.loading && shares == null -> Muted(stringResource(R.string.checking_who_has_access))
                shares == null -> Text(ui.error ?: stringResource(R.string.couldnt_load_who_has_access), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                else -> {
                    if (shares.active.isEmpty() && shares.pending.isEmpty() && shares.accepted.isEmpty()) {
                        Muted(stringResource(R.string.only_you_can_use_this_server))
                    }
                    var first = true
                    val divider: @Composable () -> Unit = {
                        if (!first) FSCardDivider()
                        first = false
                    }
                    shares.accepted.forEach { s ->
                        divider()
                        AcceptedRow(s, busy = s.shareId in ui.busy || readOnly, onConfirm = { onConfirm(s) }, onNoMatch = { onNoMatch(s) })
                    }
                    shares.active.forEach { s ->
                        divider()
                        ActiveRow(
                            s,
                            busy = s.shareId in ui.busy || readOnly,
                            onLevel = { onLevel(s, it) },
                            onUnlock = { onUnlock(s, it) },
                            onData = { onData(s, it) },
                            onRemove = { onRemove(s) },
                        )
                    }
                    shares.pending.forEach { p ->
                        divider()
                        PendingRow(p, busy = p.shareId in ui.busy || readOnly, onCopy = { onCopy(p) }, onCancel = { onCancelOffer(p) })
                    }
                    shares.boxProblem?.let { Muted(fsString(R.string.changes_to_who_has_access_wait, it)) }
                }
            }
            if (readOnly) {
                Muted(com.flagshipserver.app.core.AdminOrderGate.SHARE, modifier = Modifier.testTag("share-admin-only"))
            }
            FSPrimaryButton(
                label = stringResource(R.string.share_this_server),
                onClick = onShare,
                block = true,
                enabled = !readOnly,
                modifier = Modifier.testTag("share-server-open"),
            )
        }
    }
    }
}

@Composable
private fun AcceptedRow(s: AcceptedShare, busy: Boolean, onConfirm: () -> Unit, onNoMatch: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("share-row-${s.shareId}")) {
        val sas = s.sas
        if (sas == null) {
            Text(fsString(R.string.s_acceptance_doesnt_check_out, s.label), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
            Muted(fsString(R.string.someone_other_than_may_have_used, s.label))
            FSDangerButton(label = stringResource(R.string.remove_3), onClick = onNoMatch, enabled = !busy, block = true)
            return@Column
        }
        Text(fsString(R.string.accepted, s.label), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
        Muted(stringResource(R.string.does_their_phone_show_this_code))
        SasText(sas, Modifier.testTag("share-sas-${s.shareId}"))
        Muted("${ShareCopy.level(s.options.level)}${if (s.options.unlockAtBoot) " · can approve start-up" else ""}${if (s.options.seeAppData) " · can see app data" else ""}")
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
            FSPrimaryButton(
                label = if (busy) stringResource(R.string.confirming) else stringResource(R.string.it_matches),
                onClick = onConfirm,
                enabled = !busy,
                modifier = Modifier.weight(1f).testTag("share-confirm"),
            )
            FSSecondaryButton(label = stringResource(R.string.it_doesnt), onClick = onNoMatch, enabled = !busy, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun ActiveRow(
    s: ActiveShare,
    busy: Boolean,
    onLevel: (String) -> Unit,
    onUnlock: (Boolean) -> Unit,
    onData: (Boolean) -> Unit,
    onRemove: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("share-row-${s.shareId}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.label, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            FSPill(ShareCopy.level(s.level), kind = if (s.level == ServerShare.LEVEL_MANAGE) FSPillKind.Provisioning else FSPillKind.Idle)
        }
        Muted(s.lastSeenAt?.let { fsString(R.string.last_signed_in, FlagshipDateFormat.format(it)) } ?: stringResource(R.string.hasnt_signed_in_yet))
        LevelChoice(level = s.level, onChange = { if (it != s.level) onLevel(it) }, enabled = !busy)
        OptionSwitch(ShareCopy.UNLOCK_TITLE, ShareCopy.UNLOCK_LINE, s.unlockAtBoot, !busy, onUnlock, "share-unlock-${s.shareId}")
        Muted(ShareCopy.HOUSE_KEY_LINE, size = 12, modifier = Modifier.testTag("share-house-key-${s.shareId}"))
        OptionSwitch(ShareCopy.DATA_TITLE, ShareCopy.DATA_LINE, s.seeAppData, !busy, onData, "share-data-${s.shareId}")
        FSDangerButton(label = stringResource(R.string.remove_3), onClick = onRemove, enabled = !busy, block = true, modifier = Modifier.testTag("share-remove-${s.shareId}"))
    }
}

@Composable
private fun PendingRow(p: PendingShare, busy: Boolean, onCopy: () -> Unit, onCancel: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("share-row-${p.shareId}")) {
        Text(fsString(R.string.waiting_for_to_open_the_link, p.label), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
        Muted(fsString(R.string.the_link_works_until, ShareCopy.level(p.level), FlagshipDateFormat.format(p.expiresAt)))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
            FSSecondaryButton(label = stringResource(R.string.copy_link), onClick = onCopy, modifier = Modifier.weight(1f))
            FSDangerButton(label = stringResource(R.string.cancel), onClick = onCancel, enabled = !busy, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
fun ShareActivityCard(entries: List<ActivityEntry>) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
    SectionTitle(stringResource(R.string.activity))
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("share-activity")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            entries.sortedByDescending { it.ts }.take(50).forEach { e ->
                Row(verticalAlignment = Alignment.Top) {
                    Text(
                        ShareCopy.activityLine(e),
                        color = if (e.ok) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(FS.space.s2))
                    Muted(FlagshipDateFormat.format(e.ts), size = 12)
                }
            }
        }
    }
    }
}

// ── Owner: the share sheet ─────────────────────────────────────────────────

enum class ShareSheetStep { Label, Level, Options, Link }

@Composable
fun ShareServerSheet(serverName: String, onCreate: suspend (ShareOptions) -> String?, onClose: () -> Unit) {
    var step by remember { mutableStateOf(ShareSheetStep.Label) }
    var label by remember { mutableStateOf("") }
    var level by remember { mutableStateOf(ServerShare.LEVEL_VIEW) }
    var unlock by remember { mutableStateOf(false) }
    var data by remember { mutableStateOf(false) }
    var link by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Dialog(onDismissRequest = { if (!busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().padding(FS.space.s4), contentAlignment = Alignment.Center) {
            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth(),
            ) {
              Box(Modifier.padding(FS.space.s6)) {
                ShareSheetContent(
                    serverName = serverName,
                    step = step,
                    label = label,
                    level = level,
                    unlockAtBoot = unlock,
                    seeAppData = data,
                    link = link,
                    busy = busy,
                    onLabel = { label = it },
                    onLevel = { level = it },
                    onUnlock = { unlock = it },
                    onData = { data = it },
                    onStep = { step = it },
                    onCreate = {
                        busy = true
                        scope.launch {
                            val l = ServerShare.normalizeShareLabel(label) ?: label
                            link = onCreate(ShareOptions(l, level, unlock, data))
                            if (link != null) step = ShareSheetStep.Link
                            busy = false
                        }
                    },
                    onClose = onClose,
                )
              }
            }
        }
    }
}

@Composable
fun ShareSheetContent(
    serverName: String,
    step: ShareSheetStep,
    label: String,
    level: String,
    unlockAtBoot: Boolean,
    seeAppData: Boolean,
    link: String?,
    busy: Boolean,
    onLabel: (String) -> Unit,
    onLevel: (String) -> Unit,
    onUnlock: (Boolean) -> Unit,
    onData: (Boolean) -> Unit,
    onStep: (ShareSheetStep) -> Unit,
    onCreate: () -> Unit,
    onClose: () -> Unit,
) {
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val name = ServerShare.normalizeShareLabel(label)
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
        modifier = Modifier.verticalScroll(rememberScrollState()).testTag("share-sheet"),
    ) {
        Text(fsString(R.string.share, serverName), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineSmall)
        when (step) {
            ShareSheetStep.Label -> {
                Muted(stringResource(R.string.who_are_you_sharing_it_with), size = 14)
                FSField(
                    value = label,
                    onValueChange = onLabel,
                    label = stringResource(R.string.their_name),
                    placeholder = stringResource(R.string.sam),
                    helper = stringResource(R.string.only_you_and_this_server_see),
                    error = if (label.isNotEmpty() && name == null) stringResource(R.string.use_up_to_64_characters_without) else null,
                    fieldTag = "share-label",
                )
                FSPrimaryButton(label = stringResource(R.string.next), onClick = { onStep(ShareSheetStep.Level) }, enabled = name != null, block = true, modifier = Modifier.testTag("share-next"))
                FSGhostButton(label = stringResource(R.string.cancel), onClick = onClose, block = true)
            }
            ShareSheetStep.Level -> {
                Muted(fsString(R.string.what_can_do, name ?: "they"), size = 14)
                LevelChoice(level = level, onChange = onLevel)
                Muted(ShareCopy.NEVER_LINE, size = 12)
                FSPrimaryButton(label = stringResource(R.string.next), onClick = { onStep(ShareSheetStep.Options) }, block = true, modifier = Modifier.testTag("share-next"))
                FSGhostButton(label = stringResource(R.string.back), onClick = { onStep(ShareSheetStep.Label) }, block = true)
            }
            ShareSheetStep.Options -> {
                Muted(stringResource(R.string.both_are_off_unless_you_turn), size = 14)
                OptionSwitch(ShareCopy.UNLOCK_TITLE, ShareCopy.UNLOCK_LINE, unlockAtBoot, !busy, onUnlock, "share-opt-unlock")
                Muted(ShareCopy.HOUSE_KEY_LINE, size = 12, modifier = Modifier.testTag("share-house-key"))
                OptionSwitch(ShareCopy.DATA_TITLE, ShareCopy.DATA_LINE, seeAppData, !busy, onData, "share-opt-data")
                FSPrimaryButton(
                    label = if (busy) stringResource(R.string.creating_link) else stringResource(R.string.create_link),
                    onClick = onCreate,
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.testTag("share-create"),
                )
                FSGhostButton(label = stringResource(R.string.back), onClick = { onStep(ShareSheetStep.Level) }, enabled = !busy, block = true)
            }
            ShareSheetStep.Link -> {
                val l = link.orEmpty()
                Muted(fsString(R.string.send_this_link_to_it_works, name ?: "them"), size = 14)
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    QrImage(payload = l, size = 200.dp, contentDescription = stringResource(R.string.share_link_qr_code), modifier = Modifier.testTag("share-qr"))
                }
                Text(l, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("share-link"))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
                    FSPrimaryButton(label = stringResource(R.string.share_3), onClick = { shareText(ctx, l) }, modifier = Modifier.weight(1f))
                    FSSecondaryButton(label = stringResource(R.string.copy_link), onClick = { clipboard.setText(AnnotatedString(l)) }, modifier = Modifier.weight(1f))
                }
                FSGhostButton(label = stringResource(R.string.done), onClick = onClose, block = true)
            }
        }
    }
}

// ── The other account: "Shared with me" on Home ───────────────────────────

@Composable
fun SharedWithMeSection(onOpen: (String) -> Unit) {
    val runtime = LocalServerShares.current ?: return
    val model = runtime.sharedWithMe
    val ui by model.ui.collectAsState()
    LaunchedEffect(model) { model.refresh() }
    SharedWithMeContent(ui = ui, onOpen = onOpen)
}

@Composable
fun SharedWithMeContent(ui: SharedWithMeUi, onOpen: (String) -> Unit) {
    // Nothing shared with this account: no section at all. Accepting a link
    // starts from the create-server screen or a scanned link.
    if (ui.items.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("home-shared-with-me")) {
        SectionTitle(stringResource(R.string.shared_with_me))
        ui.items.forEach { item ->
            val (status, kind) = when (val s = item.status) {
                is SharedItem.Status.Active -> ShareCopy.level(s.level) to FSPillKind.Online
                SharedItem.Status.Waiting -> "Waiting for the owner" to FSPillKind.Pending
                SharedItem.Status.Starting -> "Waiting to start" to FSPillKind.Pending
                SharedItem.Status.Unreachable -> "Can't reach it now" to FSPillKind.Offline
            }
            FSListRow(
                leading = FSListLeading.Icon(icon = Icons.Outlined.Dns, color = FS.colors.primary),
                title = item.entry.serverName.ifBlank { item.entry.serverDomain.substringBefore('.') },
                subtitle = item.entry.serverDomain,
                onClick = { onOpen(item.entry.shareId) },
                below = { FSPill(status, kind = kind) },
                modifier = Modifier.testTag("home-shared-${item.entry.shareId}"),
            )
        }
    }
}

// ── The other account: accept a link ─────────────────────────────────────

@Composable
fun ShareAcceptScreen(initialLink: String?, onOpenServer: (String) -> Unit, onDone: () -> Unit) {
    val runtime = LocalServerShares.current
    if (runtime == null) {
        FSScreen(title = stringResource(R.string.shared_server), onBack = onDone) {
            FSNote(stringResource(R.string.sharing_needs_a_live_account_on))
        }
        return
    }
    val vm = remember(runtime) { ShareAcceptViewModel(runtime.client, runtime.sharedWithMe) }
    val phase by vm.phase.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(initialLink) { if (initialLink != null) vm.open(initialLink) }
    val waiting = (phase as? ShareAcceptViewModel.Phase.Code)?.let { !it.signedIn } == true
    LaunchedEffect(waiting) {
        while (waiting) {
            if (vm.checkConfirmed()) break
            delay(5_000)
        }
    }
    ShareAcceptContent(
        phase = phase,
        onOpen = { text -> scope.launch { vm.open(text) } },
        onAccept = { scope.launch { vm.accept() } },
        onRetry = { vm.reset() },
        onOpenServer = { (phase as? ShareAcceptViewModel.Phase.Code)?.let { onOpenServer(it.entry.shareId) } },
        onDone = onDone,
    )
}

@Composable
fun ShareAcceptContent(
    phase: ShareAcceptViewModel.Phase,
    onOpen: (String) -> Unit,
    onAccept: () -> Unit,
    onRetry: () -> Unit,
    onOpenServer: () -> Unit,
    onDone: () -> Unit,
) {
    FSScreen(title = stringResource(R.string.shared_server), onBack = onDone, modifier = Modifier.testTag("share-accept")) {
            when (phase) {
                ShareAcceptViewModel.Phase.Input -> LinkInput(onOpen = onOpen, onCancel = onDone)
                ShareAcceptViewModel.Phase.Opening -> Busy(stringResource(R.string.opening_the_link))
                is ShareAcceptViewModel.Phase.Offer -> OfferView(phase.opened.offer, busy = false, onAccept = onAccept, onCancel = onDone)
                is ShareAcceptViewModel.Phase.Accepting -> OfferView(phase.opened.offer, busy = true, onAccept = {}, onCancel = {})
                is ShareAcceptViewModel.Phase.Code -> {
                    Text(phase.entry.serverName, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineMedium)
                    if (phase.signedIn) {
                        Text(stringResource(R.string.youre_in), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                        Muted(fsString(R.string.the_owner_confirmed_the_code_is, phase.entry.serverName), size = 15)
                        FSPrimaryButton(label = fsString(R.string.open, phase.entry.serverName), onClick = onOpenServer, block = true, modifier = Modifier.testTag("share-accept-open"))
                        FSSecondaryButton(label = stringResource(R.string.done), onClick = onDone, block = true)
                    } else {
                        FSCard(padding = PaddingValues(FS.space.s5), modifier = Modifier.fillMaxWidth()) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                                Muted(stringResource(R.string.read_this_code_to_the_owner), size = 15)
                                Spacer(Modifier.height(FS.space.s2))
                                SasText(phase.sas, Modifier.testTag("share-accept-sas"))
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(FS.space.s2))
                            Muted(stringResource(R.string.waiting_for_the_owner_to_confirm), size = 14)
                        }
                        Muted(stringResource(R.string.if_the_code_on_their_phone), size = 13)
                        FSSecondaryButton(label = stringResource(R.string.close), onClick = onDone, block = true)
                    }
                }
                is ShareAcceptViewModel.Phase.Failed -> {
                    FSEmptyState(
                        title = stringResource(R.string.cant_open_this_share),
                        message = phase.message,
                        icon = Icons.Outlined.ErrorOutline,
                        iconTint = MaterialTheme.colorScheme.error,
                    )
                    FSPrimaryButton(label = stringResource(R.string.try_another_link), onClick = onRetry, block = true)
                    FSSecondaryButton(label = stringResource(R.string.close), onClick = onDone, block = true)
                }
            }
    }
}

@Composable
private fun Busy(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(FS.space.s2))
        Muted(text, size = 15)
    }
}

@Composable
private fun LinkInput(onOpen: (String) -> Unit, onCancel: () -> Unit) {
    val ctx = LocalContext.current
    var text by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        scanning = granted
    }
    Text(stringResource(R.string.open_a_share_link), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineSmall)
    Muted(stringResource(R.string.paste_the_link_the_owner_sent), size = 15)
    if (scanning) {
        QRScanner(onScanned = { scanned ->
            scanning = false
            onOpen(scanned)
        })
        FSSecondaryButton(label = stringResource(R.string.stop_scanning), onClick = { scanning = false }, block = true)
    } else {
        FSField(value = text, onValueChange = { text = it }, label = stringResource(R.string.share_link), placeholder = "https://flagshipserver.com/share#…", fieldTag = "share-link-input")
        FSPrimaryButton(label = stringResource(R.string.open_2), onClick = { onOpen(text) }, enabled = text.isNotBlank(), block = true, modifier = Modifier.testTag("share-link-open"))
        FSSecondaryButton(
            label = stringResource(R.string.scan_a_code),
            onClick = {
                val granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED
                if (granted) scanning = true else permission.launch(Manifest.permission.CAMERA)
            },
            block = true,
        )
    }
}

@Composable
private fun OfferView(offer: ServerShare.OfferPayload, busy: Boolean, onAccept: () -> Unit, onCancel: () -> Unit) {
    Muted(stringResource(R.string.a_server_was_shared_with_you), size = 15)
    Text(offer.serverName.ifBlank { offer.serverDomain.substringBefore('.') }, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineMedium)
    Muted(offer.serverDomain)
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSPill(ShareCopy.level(offer.level), kind = FSPillKind.Idle)
            Muted(if (offer.level == ServerShare.LEVEL_MANAGE) fsString(R.string.you_can_see_it_and_help, ShareCopy.MANAGE_LINE.replaceFirstChar { it.lowercase() }) else fsString(R.string.you_can, ShareCopy.VIEW_LINE.replaceFirstChar { it.lowercase() }), size = 14)
            if (offer.unlockAtBoot) Muted(stringResource(R.string.you_can_approve_its_start_up), size = 14)
            if (offer.seeAppData) Muted(stringResource(R.string.you_can_see_its_apps_data), size = 14)
        }
    }
    Muted(stringResource(R.string.accepting_shows_a_code_to_read), size = 13)
    FSPrimaryButton(label = if (busy) stringResource(R.string.accepting) else "Accept", onClick = onAccept, enabled = !busy, block = true, large = true, modifier = Modifier.testTag("share-accept-button"))
    FSSecondaryButton(label = stringResource(R.string.not_now), onClick = onCancel, enabled = !busy, block = true)
}

// ── The other account: the shared server's page ───────────────────────────

@Composable
fun SharedServerScreen(shareId: String, onBack: () -> Unit, onOpenApp: (String) -> Unit = {}) {
    val runtime = LocalServerShares.current ?: return
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val shared by runtime.sharedWithMe.ui.collectAsState()
    val entry = shared.items.firstOrNull { it.entry.shareId == shareId }?.entry
    LaunchedEffect(entry == null) { if (entry == null) runtime.sharedWithMe.refresh(interactive = true) }
    if (entry == null) {
        FSScreen(title = stringResource(R.string.shared_server), onBack = onBack) {
            if (shared.loaded) FSNote(stringResource(R.string.this_server_isnt_shared_with_you_3)) else ServerCardSkeleton()
        }
        return
    }
    val vm = remember(entry.shareId) { SharedServerViewModel(runtime, entry) }
    val ui by vm.ui.collectAsState()
    LaunchedEffect(vm) {
        vm.load()
        while (true) {
            delay(10_000)
            if (vm.ui.value.phase == SharedServerUi.Phase.Waiting || vm.ui.value.phase == SharedServerUi.Phase.Unreachable) vm.load() else vm.refreshStartups()
        }
    }
    LaunchedEffect(ui.message) {
        ui.message?.let {
            toasts.warning(it)
            vm.clearMessage()
        }
    }
    LaunchedEffect(ui.phase) { if (ui.phase == SharedServerUi.Phase.Left) onBack() }
    SharedServerContent(
        serverName = entry.serverName.ifBlank { entry.serverDomain.substringBefore('.') },
        serverDomain = entry.serverDomain,
        ui = ui,
        onBack = onBack,
        onApprove = { s -> scope.launch { if (vm.approve(s)) toasts.success(FSStrings.get(R.string.unlocked_is_starting, entry.serverName)) } },
        onAnswer = { r, allow -> scope.launch { vm.answer(r, allow) } },
        onLeave = { scope.launch { if (vm.leave()) toasts.success(FSStrings.get(R.string.you_left, entry.serverName)) } },
        onRetry = { scope.launch { vm.load() } },
        onNotices = { on -> scope.launch { vm.setNotices(on) } },
        onUpdate = {
            scope.launch {
                if (vm.update()) toasts.success(ShareCopy.updating(entry.serverName.ifBlank { entry.serverDomain.substringBefore('.') }))
            }
        },
        onOpenApp = onOpenApp,
    )
}

@Composable
fun SharedServerContent(
    serverName: String,
    serverDomain: String,
    ui: SharedServerUi,
    onBack: () -> Unit,
    onApprove: (ShareStartup) -> Unit,
    onAnswer: (AccessRequest, Boolean) -> Unit,
    onLeave: () -> Unit,
    onRetry: () -> Unit,
    onNotices: (Boolean) -> Unit = {},
    onUpdate: () -> Unit = {},
    onOpenApp: (String) -> Unit = {},
) {
    var confirmLeave by remember { mutableStateOf(false) }
    var confirmUpdate by remember { mutableStateOf(false) }
    FSScreen(title = serverName, onBack = onBack, modifier = Modifier.testTag("shared-server"), spacing = FS.space.s6) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Muted(stringResource(R.string.shared_with_you), size = 14, modifier = Modifier.padding(start = FS.space.s1))
            ui.level?.let { FSPill(ShareCopy.level(it), kind = FSPillKind.Idle) }
        }

        ui.startups.firstOrNull()?.let { s ->
            StartupCard(serverName, s, ui.busy) { onApprove(s) }
        }

        if (ui.canUnlock && ui.phase != SharedServerUi.Phase.Ended && ui.phase != SharedServerUi.Phase.Left) {
            FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-notices")) {
                OptionSwitch(ShareCopy.NOTICES_TITLE, ShareCopy.NOTICES_LINE, ui.notices, !ui.busy, onNotices, "shared-notices-switch")
            }
        }

        when (ui.phase) {
            SharedServerUi.Phase.Loading -> ServerCardSkeleton()
            SharedServerUi.Phase.Waiting -> {
                FSEmptyState(
                    title = stringResource(R.string.waiting_for_the_owner_to_confirm),
                    message = stringResource(R.string.once_they_check_the_code_you),
                    icon = Icons.Outlined.HourglassEmpty,
                )
            }
            SharedServerUi.Phase.Unreachable -> {
                ErrorCard(
                    if (ui.canUnlock) fsString(R.string.isnt_answering_if_its_starting_you, serverName) else fsString(R.string.isnt_answering_right_now, serverName),
                    onRetry = onRetry,
                )
            }
            SharedServerUi.Phase.Ended, SharedServerUi.Phase.Left -> {
                FSNote(stringResource(R.string.the_owner_stopped_sharing_this_server))
            }
            SharedServerUi.Phase.Ready -> ReadySections(serverDomain, ui, onAnswer, onUpdate = { confirmUpdate = true }, onOpenApp = onOpenApp)
        }

        if (ui.phase != SharedServerUi.Phase.Ended && ui.phase != SharedServerUi.Phase.Left) {
            FSDangerButton(label = stringResource(R.string.leave_this_server), onClick = { confirmLeave = true }, enabled = !ui.busy, block = true, modifier = Modifier.testTag("shared-leave"))
        }
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text(fsString(R.string.leave_2, serverName)) },
            text = { Text(stringResource(R.string.you_lose_access_at_once_the)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    onLeave()
                }, modifier = Modifier.testTag("shared-leave-confirm")) { Text(stringResource(R.string.leave_3), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text(stringResource(R.string.stay)) } },
        )
    }
    val latest = ui.releases?.latest
    if (confirmUpdate && latest != null) {
        AlertDialog(
            onDismissRequest = { confirmUpdate = false },
            title = { Text(ShareCopy.updateButton(latest.tag, latest.commit) + "?") },
            text = { Text(ShareCopy.updateConfirm(serverName)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmUpdate = false
                    onUpdate()
                }, modifier = Modifier.testTag("shared-update-confirm")) { Text(stringResource(R.string.update_2)) }
            },
            dismissButton = { TextButton(onClick = { confirmUpdate = false }) { Text(stringResource(R.string.not_now)) } },
        )
    }
}

@Composable
private fun StartupCard(serverName: String, s: ShareStartup, busy: Boolean, onApprove: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-startup")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Lock, contentDescription = null, tint = FS.colors.warning)
                Text(fsString(R.string.is_starting, serverName), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
            }
            Muted(fsString(R.string.its_waiting_for_its_disk_to, if (s.pending.postedAt > 0) " (asked ${FlagshipDateFormat.format(s.pending.postedAt)})" else ""))
            FSPrimaryButton(label = if (busy) stringResource(R.string.unlocking) else stringResource(R.string.unlock_it), onClick = onApprove, enabled = !busy, block = true, modifier = Modifier.testTag("shared-approve-startup"))
        }
    }
}

@Composable
private fun ReadySections(
    serverDomain: String,
    ui: SharedServerUi,
    onAnswer: (AccessRequest, Boolean) -> Unit,
    onUpdate: () -> Unit,
    onOpenApp: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        SectionTitle(stringResource(R.string.status))
        SharedStatusCard(serverDomain, ui.detail)
    }
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        SectionTitle(stringResource(R.string.monitoring))
        ui.metrics?.let { SharedMetricsCard(it) } ?: FSNote(stringResource(R.string.no_readings_yet))
    }
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        SectionTitle(ServerAppsViewModel.TITLE)
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("shared-apps")) {
            val apps = ui.apps
            when {
                apps == null -> ServerCardSkeleton()
                apps.isEmpty() -> FSNote(ServerAppsViewModel.EMPTY)
                else -> {
                if (!ui.manage) Muted(ShareCoInviteCopy.VIEW_ONLY, size = 13, modifier = Modifier.testTag("co-invite-view-only"))
                apps.forEach { row ->
                    FSListRow(
                        leading = FSListLeading.Icon(icon = Icons.Outlined.Apps, color = FS.colors.primary),
                        title = row.name,
                        subtitle = row.status,
                        detail = row.address.ifEmpty { null },
                        onClick = if (row.opens) { { onOpenApp(row.serviceId) } } else null,
                        modifier = Modifier.testTag("shared-app-row-${row.serviceId}"),
                        below = if (row.membersOnly) {
                            { Muted(ShareCopy.MEMBERS_ONLY_HINT, size = 12, modifier = Modifier.testTag("shared-members-only-${row.serviceId}")) }
                        } else {
                            null
                        },
                    )
                }
                }
            }
        }
    }
    if (ui.manage && ui.canUpdate) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            SectionTitle(ShareCopy.UPDATE_TITLE)
            SharedUpdateCard(ui, onUpdate)
        }
    }
    if (ui.manage) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            SectionTitle(stringResource(R.string.internet_requests))
            FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-access")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    if (ui.accessRequests.isEmpty()) Muted(stringResource(R.string.no_app_is_asking_to_reach))
                    ui.accessRequests.forEachIndexed { idx, r ->
                        if (idx > 0) FSCardDivider()
                        val app = r.appName ?: r.serviceId
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text(fsString(R.string.wants_to_reach, app, r.host), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
                                FSPrimaryButton(label = stringResource(R.string.allow), onClick = { onAnswer(r, true) }, enabled = !ui.busy, modifier = Modifier.weight(1f))
                                FSSecondaryButton(label = stringResource(R.string.deny), onClick = { onAnswer(r, false) }, enabled = !ui.busy, modifier = Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SharedUpdateCard(ui: SharedServerUi, onUpdate: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-update")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            val catalog = ui.releases
            val current = catalog?.currentTag ?: (ui.detail?.currentCommit ?: catalog?.currentCommit)?.take(8)
            current?.let { Muted(fsString(R.string.running_3, it)) }
            val latest = catalog?.latest
            when {
                catalog == null -> Muted(stringResource(R.string.couldnt_list_the_releases_right_now))
                latest == null -> Muted(ShareCopy.UPDATE_CURRENT)
                else -> FSPrimaryButton(
                    label = ShareCopy.updateButton(latest.tag, latest.commit),
                    onClick = onUpdate,
                    enabled = !ui.busy,
                    block = true,
                    modifier = Modifier.testTag("shared-update-button"),
                )
            }
            ui.detail?.lastUpdate?.summary?.let { Muted(it, size = 12) }
        }
    }
}

@Composable
private fun SharedStatusCard(serverDomain: String, detail: ServerDetailResponse?) {
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-status")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(serverDomain, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
            if (detail == null) {
                Muted(stringResource(R.string.status_unavailable))
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill(stringResource(R.string.online), kind = FSPillKind.Online)
                    FSPill(fsString(R.string.server_3, detail.daemonVersion), kind = FSPillKind.Idle)
                    FSPill(FSStrings.plural(R.plurals.apps_count, detail.serviceCount, detail.serviceCount), kind = FSPillKind.Idle)
                }
                Muted(fsString(R.string.up_for, uptime(detail.uptimeMs)))
            }
        }
    }
}

private fun uptime(ms: Long): String {
    val m = ms / 60_000
    return when {
        m < 60 -> FSStrings.get(R.string.min, m)
        m < 48 * 60 -> FSStrings.get(R.string.h_min, m / 60, m % 60)
        else -> FSStrings.get(R.string.days, m / (24 * 60))
    }
}

private fun bytes(b: Long): String {
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var v = b.toDouble()
    var i = 0
    while (v >= 1024 && i < units.size - 1) {
        v /= 1024
        i++
    }
    return if (i == 0) "$b B" else "%.1f %s".format(v, units[i])
}

@Composable
private fun SharedMetricsCard(m: ServerMetricsResponse) {
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-metrics")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Meter(stringResource(R.string.processor), "%.0f%%".format(m.cpuPercent), (m.cpuPercent / 100).toFloat())
            Meter(stringResource(R.string.memory), fsString(R.string.of, bytes(m.memUsedBytes), bytes(m.memTotalBytes)), if (m.memTotalBytes > 0) m.memUsedBytes.toFloat() / m.memTotalBytes else 0f)
            Meter(stringResource(R.string.disk), fsString(R.string.of, bytes(m.diskUsedBytes), bytes(m.diskTotalBytes)), if (m.diskTotalBytes > 0) m.diskUsedBytes.toFloat() / m.diskTotalBytes else 0f)
            Muted("Network: ${bytes(m.netRxBytesPerSec.toLong())}/s in · ${bytes(m.netTxBytesPerSec.toLong())}/s out")
        }
    }
}

@Composable
private fun Meter(title: String, value: String, fraction: Float) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        Row {
            Text(title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End)
        }
        LinearProgressIndicator(
            progress = { fraction.coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().height(6.dp),
            color = FS.colors.accentText,
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        )
    }
}
