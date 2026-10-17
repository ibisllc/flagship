// Share this server (docs/share-a-server.md §8): the owner's "Shared with"
// and Activity cards with the share sheet, and the other account's accept
// screen, "Shared with me" section and restricted server page.

package com.flagshipserver.app.ui.screens

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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
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
import androidx.compose.ui.window.Dialog
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
    ctx.startActivity(Intent.createChooser(send, "Share server link").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
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
        onConfirm = { s -> scope.launch { if (vm.confirm(s)) toasts.success("${s.label} can now use this server.") } },
        onNoMatch = { s -> removing = s.shareId to s.label },
        onLevel = { s, level -> scope.launch { vm.change(s, level = level) } },
        onUnlock = { s, on -> scope.launch { vm.change(s, unlockAtBoot = on) } },
        onData = { s, on -> scope.launch { vm.change(s, seeAppData = on) } },
        onRemove = { s -> removing = s.shareId to s.label },
        onCopy = { p ->
            clipboard.setText(AnnotatedString(p.link))
            toasts.success("Link copied.")
        },
        onCancelOffer = { p -> scope.launch { if (vm.cancel(p)) toasts.success("Link cancelled.") } },
    )
    if (ui.activity.isNotEmpty()) {
        ShareActivityCard(ui.activity)
    }
    }

    removing?.let { (id, label) ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Stop sharing with $label?") },
            text = { Text("$label loses access to $serverName at once. To share again you'd send a new link.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        removing = null
                        scope.launch { if (vm.remove(id, label)) toasts.success("$label no longer has access.") }
                    },
                    modifier = Modifier.testTag("share-remove-confirm"),
                ) { Text("Stop sharing", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Keep") } },
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
    SectionTitle("Shared with", Modifier.testTag("share-card-title"))
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("share-server-card")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
            val shares = ui.shares
            when {
                ui.loading && shares == null -> Muted("Checking who has access…")
                shares == null -> Text(ui.error ?: "Couldn't load who has access.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                else -> {
                    if (shares.active.isEmpty() && shares.pending.isEmpty() && shares.accepted.isEmpty()) {
                        Muted("Only you can use this server. Share it to let someone else see it, or help run it.")
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
                    shares.boxProblem?.let { Muted("$it Changes to who has access wait until it's back.") }
                }
            }
            if (readOnly) {
                Muted(com.flagshipserver.app.core.AdminOrderGate.SHARE, modifier = Modifier.testTag("share-admin-only"))
            }
            FSPrimaryButton(
                label = "Share this server",
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
            Text("${s.label}'s acceptance doesn't check out", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
            Muted("Someone other than ${s.label} may have used the link. Remove it and share again.")
            FSDangerButton(label = "Remove", onClick = onNoMatch, enabled = !busy, block = true)
            return@Column
        }
        Text("${s.label} accepted", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
        Muted("Does their phone show this code?")
        SasText(sas, Modifier.testTag("share-sas-${s.shareId}"))
        Muted("${ShareCopy.level(s.options.level)}${if (s.options.unlockAtBoot) " · can approve start-up" else ""}${if (s.options.seeAppData) " · can see app data" else ""}")
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
            FSPrimaryButton(
                label = if (busy) "Confirming…" else "It matches",
                onClick = onConfirm,
                enabled = !busy,
                modifier = Modifier.weight(1f).testTag("share-confirm"),
            )
            FSSecondaryButton(label = "It doesn't", onClick = onNoMatch, enabled = !busy, modifier = Modifier.weight(1f))
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
        Muted(s.lastSeenAt?.let { "Last signed in ${FlagshipDateFormat.format(it)}" } ?: "Hasn't signed in yet")
        LevelChoice(level = s.level, onChange = { if (it != s.level) onLevel(it) }, enabled = !busy)
        OptionSwitch(ShareCopy.UNLOCK_TITLE, ShareCopy.UNLOCK_LINE, s.unlockAtBoot, !busy, onUnlock, "share-unlock-${s.shareId}")
        Muted(ShareCopy.HOUSE_KEY_LINE, size = 12, modifier = Modifier.testTag("share-house-key-${s.shareId}"))
        OptionSwitch(ShareCopy.DATA_TITLE, ShareCopy.DATA_LINE, s.seeAppData, !busy, onData, "share-data-${s.shareId}")
        FSDangerButton(label = "Remove", onClick = onRemove, enabled = !busy, block = true, modifier = Modifier.testTag("share-remove-${s.shareId}"))
    }
}

@Composable
private fun PendingRow(p: PendingShare, busy: Boolean, onCopy: () -> Unit, onCancel: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("share-row-${p.shareId}")) {
        Text("Waiting for ${p.label} to open the link", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
        Muted("${ShareCopy.level(p.level)} · the link works until ${FlagshipDateFormat.format(p.expiresAt)}")
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
            FSSecondaryButton(label = "Copy link", onClick = onCopy, modifier = Modifier.weight(1f))
            FSDangerButton(label = "Cancel", onClick = onCancel, enabled = !busy, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
fun ShareActivityCard(entries: List<ActivityEntry>) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
    SectionTitle("Activity")
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
        Text("Share $serverName", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineSmall)
        when (step) {
            ShareSheetStep.Label -> {
                Muted("Who are you sharing it with? They'll need their own Flagship account.", size = 14)
                FSField(
                    value = label,
                    onValueChange = onLabel,
                    label = "Their name",
                    placeholder = "Sam",
                    helper = "Only you and this server see this name.",
                    error = if (label.isNotEmpty() && name == null) "Use up to 64 characters, without |." else null,
                    fieldTag = "share-label",
                )
                FSPrimaryButton(label = "Next", onClick = { onStep(ShareSheetStep.Level) }, enabled = name != null, block = true, modifier = Modifier.testTag("share-next"))
                FSGhostButton(label = "Cancel", onClick = onClose, block = true)
            }
            ShareSheetStep.Level -> {
                Muted("What can ${name ?: "they"} do?", size = 14)
                LevelChoice(level = level, onChange = onLevel)
                Muted(ShareCopy.NEVER_LINE, size = 12)
                FSPrimaryButton(label = "Next", onClick = { onStep(ShareSheetStep.Options) }, block = true, modifier = Modifier.testTag("share-next"))
                FSGhostButton(label = "Back", onClick = { onStep(ShareSheetStep.Label) }, block = true)
            }
            ShareSheetStep.Options -> {
                Muted("Both are off unless you turn them on. You can change them later.", size = 14)
                OptionSwitch(ShareCopy.UNLOCK_TITLE, ShareCopy.UNLOCK_LINE, unlockAtBoot, !busy, onUnlock, "share-opt-unlock")
                Muted(ShareCopy.HOUSE_KEY_LINE, size = 12, modifier = Modifier.testTag("share-house-key"))
                OptionSwitch(ShareCopy.DATA_TITLE, ShareCopy.DATA_LINE, seeAppData, !busy, onData, "share-opt-data")
                FSPrimaryButton(
                    label = if (busy) "Creating link…" else "Create link",
                    onClick = onCreate,
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.testTag("share-create"),
                )
                FSGhostButton(label = "Back", onClick = { onStep(ShareSheetStep.Level) }, enabled = !busy, block = true)
            }
            ShareSheetStep.Link -> {
                val l = link.orEmpty()
                Muted("Send this link to ${name ?: "them"}. It works once, for 7 days. When they accept, their phone shows a code: check it here before they get access.", size = 14)
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    QrImage(payload = l, size = 200.dp, contentDescription = "Share link QR code", modifier = Modifier.testTag("share-qr"))
                }
                Text(l, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("share-link"))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
                    FSPrimaryButton(label = "Share", onClick = { shareText(ctx, l) }, modifier = Modifier.weight(1f))
                    FSSecondaryButton(label = "Copy link", onClick = { clipboard.setText(AnnotatedString(l)) }, modifier = Modifier.weight(1f))
                }
                FSGhostButton(label = "Done", onClick = onClose, block = true)
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
        SectionTitle("Shared with me")
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
        FSScreen(title = "Shared server", onBack = onDone) {
            FSNote("Sharing needs a live account on this phone.")
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
    FSScreen(title = "Shared server", onBack = onDone, modifier = Modifier.testTag("share-accept")) {
            when (phase) {
                ShareAcceptViewModel.Phase.Input -> LinkInput(onOpen = onOpen, onCancel = onDone)
                ShareAcceptViewModel.Phase.Opening -> Busy("Opening the link…")
                is ShareAcceptViewModel.Phase.Offer -> OfferView(phase.opened.offer, busy = false, onAccept = onAccept, onCancel = onDone)
                is ShareAcceptViewModel.Phase.Accepting -> OfferView(phase.opened.offer, busy = true, onAccept = {}, onCancel = {})
                is ShareAcceptViewModel.Phase.Code -> {
                    Text(phase.entry.serverName, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineMedium)
                    if (phase.signedIn) {
                        Text("You're in", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                        Muted("The owner confirmed the code. ${phase.entry.serverName} is now under Shared with me.", size = 15)
                        FSPrimaryButton(label = "Open ${phase.entry.serverName}", onClick = onOpenServer, block = true, modifier = Modifier.testTag("share-accept-open"))
                        FSSecondaryButton(label = "Done", onClick = onDone, block = true)
                    } else {
                        FSCard(padding = PaddingValues(FS.space.s5), modifier = Modifier.fillMaxWidth()) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                                Muted("Read this code to the owner", size = 15)
                                Spacer(Modifier.height(FS.space.s2))
                                SasText(phase.sas, Modifier.testTag("share-accept-sas"))
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(FS.space.s2))
                            Muted("Waiting for the owner to confirm", size = 14)
                        }
                        Muted("If the code on their phone is different, someone else may have the link: tell them not to confirm.", size = 13)
                        FSSecondaryButton(label = "Close", onClick = onDone, block = true)
                    }
                }
                is ShareAcceptViewModel.Phase.Failed -> {
                    FSEmptyState(
                        title = "Can't open this share",
                        message = phase.message,
                        icon = Icons.Outlined.ErrorOutline,
                        iconTint = MaterialTheme.colorScheme.error,
                    )
                    FSPrimaryButton(label = "Try another link", onClick = onRetry, block = true)
                    FSSecondaryButton(label = "Close", onClick = onDone, block = true)
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
    Text("Open a share link", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineSmall)
    Muted("Paste the link the owner sent you, or scan the code on their phone.", size = 15)
    if (scanning) {
        QRScanner(onScanned = { scanned ->
            scanning = false
            onOpen(scanned)
        })
        FSSecondaryButton(label = "Stop scanning", onClick = { scanning = false }, block = true)
    } else {
        FSField(value = text, onValueChange = { text = it }, label = "Share link", placeholder = "https://flagshipserver.com/share#…", fieldTag = "share-link-input")
        FSPrimaryButton(label = "Open", onClick = { onOpen(text) }, enabled = text.isNotBlank(), block = true, modifier = Modifier.testTag("share-link-open"))
        FSSecondaryButton(
            label = "Scan a code",
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
    Muted("A server was shared with you", size = 15)
    Text(offer.serverName.ifBlank { offer.serverDomain.substringBefore('.') }, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineMedium)
    Muted(offer.serverDomain)
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSPill(ShareCopy.level(offer.level), kind = FSPillKind.Idle)
            Muted(if (offer.level == ServerShare.LEVEL_MANAGE) "You can see it and help run it: ${ShareCopy.MANAGE_LINE.replaceFirstChar { it.lowercase() }}" else "You can ${ShareCopy.VIEW_LINE.replaceFirstChar { it.lowercase() }}", size = 14)
            if (offer.unlockAtBoot) Muted("You can approve its start-up.", size = 14)
            if (offer.seeAppData) Muted("You can see its apps' data.", size = 14)
        }
    }
    Muted("Accepting shows a code to read to the owner. They confirm it before you get access.", size = 13)
    FSPrimaryButton(label = if (busy) "Accepting…" else "Accept", onClick = onAccept, enabled = !busy, block = true, large = true, modifier = Modifier.testTag("share-accept-button"))
    FSSecondaryButton(label = "Not now", onClick = onCancel, enabled = !busy, block = true)
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
        FSScreen(title = "Shared server", onBack = onBack) {
            if (shared.loaded) FSNote("This server isn't shared with you any more.") else ServerCardSkeleton()
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
        onApprove = { s -> scope.launch { if (vm.approve(s)) toasts.success("Unlocked. ${entry.serverName} is starting.") } },
        onAnswer = { r, allow -> scope.launch { vm.answer(r, allow) } },
        onLeave = { scope.launch { if (vm.leave()) toasts.success("You left ${entry.serverName}.") } },
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
            Muted("Shared with you", size = 14, modifier = Modifier.padding(start = FS.space.s1))
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
                    title = "Waiting for the owner to confirm",
                    message = "Once they check the code you read them, this page fills in.",
                    icon = Icons.Outlined.HourglassEmpty,
                )
            }
            SharedServerUi.Phase.Unreachable -> {
                ErrorCard(
                    if (ui.canUnlock) "$serverName isn't answering. If it's starting, you can approve it above when it asks." else "$serverName isn't answering right now.",
                    onRetry = onRetry,
                )
            }
            SharedServerUi.Phase.Ended, SharedServerUi.Phase.Left -> {
                FSNote("The owner stopped sharing this server.")
            }
            SharedServerUi.Phase.Ready -> ReadySections(serverDomain, ui, onAnswer, onUpdate = { confirmUpdate = true }, onOpenApp = onOpenApp)
        }

        if (ui.phase != SharedServerUi.Phase.Ended && ui.phase != SharedServerUi.Phase.Left) {
            FSDangerButton(label = "Leave this server", onClick = { confirmLeave = true }, enabled = !ui.busy, block = true, modifier = Modifier.testTag("shared-leave"))
        }
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave $serverName?") },
            text = { Text("You lose access at once. The owner would have to share it with you again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    onLeave()
                }, modifier = Modifier.testTag("shared-leave-confirm")) { Text("Leave", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("Stay") } },
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
                }, modifier = Modifier.testTag("shared-update-confirm")) { Text("Update") }
            },
            dismissButton = { TextButton(onClick = { confirmUpdate = false }) { Text("Not now") } },
        )
    }
}

@Composable
private fun StartupCard(serverName: String, s: ShareStartup, busy: Boolean, onApprove: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-startup")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Lock, contentDescription = null, tint = FS.colors.warning)
                Text("$serverName is starting", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
            }
            Muted("It's waiting for its disk to be unlocked. Approve only if you expected it to start${if (s.pending.postedAt > 0) " (asked ${FlagshipDateFormat.format(s.pending.postedAt)})" else ""}.")
            FSPrimaryButton(label = if (busy) "Unlocking…" else "Unlock it", onClick = onApprove, enabled = !busy, block = true, modifier = Modifier.testTag("shared-approve-startup"))
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
        SectionTitle("Status")
        SharedStatusCard(serverDomain, ui.detail)
    }
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        SectionTitle("Monitoring")
        ui.metrics?.let { SharedMetricsCard(it) } ?: FSNote("No readings yet.")
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
            SectionTitle("Internet requests")
            FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-access")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    if (ui.accessRequests.isEmpty()) Muted("No app is asking to reach the internet.")
                    ui.accessRequests.forEachIndexed { idx, r ->
                        if (idx > 0) FSCardDivider()
                        val app = r.appName ?: r.serviceId
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text("$app wants to reach ${r.host}", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
                                FSPrimaryButton(label = "Allow", onClick = { onAnswer(r, true) }, enabled = !ui.busy, modifier = Modifier.weight(1f))
                                FSSecondaryButton(label = "Deny", onClick = { onAnswer(r, false) }, enabled = !ui.busy, modifier = Modifier.weight(1f))
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
            current?.let { Muted("Running $it") }
            val latest = catalog?.latest
            when {
                catalog == null -> Muted("Couldn't list the releases right now.")
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
                Muted("Status unavailable.")
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill("Online", kind = FSPillKind.Online)
                    FSPill("Server ${detail.daemonVersion}", kind = FSPillKind.Idle)
                    FSPill(plural(detail.serviceCount, "app"), kind = FSPillKind.Idle)
                }
                Muted("Up for ${uptime(detail.uptimeMs)}")
            }
        }
    }
}

private fun uptime(ms: Long): String {
    val m = ms / 60_000
    return when {
        m < 60 -> "$m min"
        m < 48 * 60 -> "${m / 60} h ${m % 60} min"
        else -> "${m / (24 * 60)} days"
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
            Meter("Processor", "%.0f%%".format(m.cpuPercent), (m.cpuPercent / 100).toFloat())
            Meter("Memory", "${bytes(m.memUsedBytes)} of ${bytes(m.memTotalBytes)}", if (m.memTotalBytes > 0) m.memUsedBytes.toFloat() / m.memTotalBytes else 0f)
            Meter("Disk", "${bytes(m.diskUsedBytes)} of ${bytes(m.diskTotalBytes)}", if (m.diskTotalBytes > 0) m.diskUsedBytes.toFloat() / m.diskTotalBytes else 0f)
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
