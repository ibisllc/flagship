// Restore apps from a backup into this server (docs/restore-into-server.md §7): checking the backup,
// the per-app choices with the accepted defaults, progress, and the result with Undo. Each app opens
// its own sheet with only the actions the box allows, each with one line on what it does; the others
// greyed with the box's reason. MIRRORS the iOS RestoreMergeScreen.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.flagshipserver.app.R
import com.flagshipserver.app.api.RestoreMergeApp
import com.flagshipserver.app.api.RestoreMergeUndoPoint
import com.flagshipserver.app.core.RestoreMergeText
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.ui.components.RadioButton
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.RestoreMergeViewModel
import com.flagshipserver.app.viewmodels.RestoreMergeViewModel.Group
import com.flagshipserver.app.viewmodels.RestoreMergeViewModel.Phase
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

private val caption: TextStyle @Composable get() = MaterialTheme.typography.bodySmall
private val body: TextStyle @Composable get() = MaterialTheme.typography.bodyMedium

private fun dateTime(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))
private fun day(ms: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))

/** The whole flow in a full-screen dialog; starts on first show. */
@Composable
internal fun RestoreMergeDialog(vm: RestoreMergeViewModel, source: RestoreMergeViewModel.Source, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val close: () -> Unit = {
        scope.launch {
            vm.cancel()
            onClose()
        }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            SheetTopBar(title = stringResource(R.string.rm_title), onClose = close)
            RestoreMergeScreen(vm = vm, source = source)
        }
    }
}

@Composable
internal fun RestoreMergeScreen(vm: RestoreMergeViewModel, source: RestoreMergeViewModel.Source?) {
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<RestoreMergeApp?>(null) }
    LaunchedEffect(vm, source) { if (source != null && vm.phase == Phase.Idle) vm.start(source) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(FS.space.s4).testTag("rm-screen"),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        when (val p = vm.phase) {
            Phase.Idle, Phase.Opening -> Progress(stringResource(R.string.rm_opening))
            is Phase.Sending -> Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(fsString(R.string.rm_sending, vm.serverFqdn), color = FS.colors.text, style = body)
                LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
            }
            Phase.Checking -> Progress(fsString(R.string.rm_checking, vm.serverFqdn))
            Phase.Choosing -> Choosing(vm, onEdit = { editing = it }, onRestore = { scope.launch { vm.restore() } })
            Phase.Restoring, Phase.Done -> Result(vm)
            is Phase.Failed -> Text(p.message, color = FS.colors.danger, style = body, modifier = Modifier.testTag("rm-failed"))
        }
        vm.actionError?.let { Text(it, color = FS.colors.danger, style = body, modifier = Modifier.testTag("rm-error")) }
    }

    editing?.let { a -> AppSheet(vm, a, onDone = { editing = null }) }
}

@Composable
private fun Progress(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("rm-progress")) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp))
        Text(text, color = FS.colors.textMuted, style = body)
    }
}

@Composable
private fun Choosing(vm: RestoreMergeViewModel, onEdit: (RestoreMergeApp) -> Unit, onRestore: () -> Unit) {
    vm.preview?.backup?.createdAt?.let { Text(fsString(R.string.rm_backup_of, dateTime(it)), color = FS.colors.textMuted, style = caption) }
    AppGroup(stringResource(R.string.rm_group_new), vm.apps(Group.NEW), vm, onEdit, "new")
    AppGroup(stringResource(R.string.rm_group_already), vm.apps(Group.ALREADY), vm, onEdit, "already")
    AppGroup(stringResource(R.string.rm_group_different), vm.apps(Group.DIFFERENT), vm, onEdit, "different")
    FSPrimaryButton(
        label = stringResource(R.string.rm_restore),
        onClick = onRestore,
        enabled = vm.canRestore,
        block = true,
        modifier = Modifier.testTag("rm-restore"),
    )
    if (!vm.canRestore) Text(stringResource(R.string.rm_choose_one), color = FS.colors.textMuted, style = caption, modifier = Modifier.testTag("rm-hint"))
}

@Composable
private fun AppGroup(title: String, apps: List<RestoreMergeApp>, vm: RestoreMergeViewModel, onEdit: (RestoreMergeApp) -> Unit, tag: String) {
    if (apps.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("rm-group-$tag")) {
        FSSectionHeader(title)
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                apps.forEachIndexed { i, a ->
                    if (i > 0) HorizontalDivider(color = FS.colors.border)
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().clickable { onEdit(a) }.testTag("rm-app-${a.archivedServiceId}"),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(a.name, color = FS.colors.text, style = body)
                            Text(RestoreMergeText.comparison(a), color = FS.colors.textMuted, style = caption)
                        }
                        Text(
                            RestoreMergeText.actionName(vm.choices[a.archivedServiceId]?.action ?: a.recommended),
                            color = FS.colors.accentText,
                            style = caption,
                            modifier = Modifier.testTag("rm-chosen-${a.archivedServiceId}"),
                        )
                    }
                }
            }
        }
    }
}

/** One app's choices: only the actions the server allows, each with what it does; the others greyed with why. */
@Composable
private fun AppSheet(vm: RestoreMergeViewModel, app: RestoreMergeApp, onDone: () -> Unit) {
    val chosen = vm.choices[app.archivedServiceId]?.action ?: app.recommended
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(app.name) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(RestoreMergeText.comparison(app), color = FS.colors.textMuted, style = caption)
                RestoreMergeText.ACTION_ORDER.filter { it in app.allowed || app.disallowed.containsKey(it) }.forEach { action ->
                    val allowed = action in app.allowed
                    Row(
                        verticalAlignment = Alignment.Top,
                        modifier = Modifier.fillMaxWidth().clickable(enabled = allowed) { vm.choose(app, action) }.testTag("rm-action-$action"),
                    ) {
                        RadioButton(selected = chosen == action, onClick = if (allowed) ({ vm.choose(app, action) }) else null, enabled = allowed)
                        Column(Modifier.weight(1f)) {
                            Text(RestoreMergeText.actionName(action), color = if (allowed) FS.colors.text else FS.colors.textMuted, style = body)
                            Text(
                                if (allowed) RestoreMergeText.consequence(action, app) else RestoreMergeText.refusal(app.disallowed[action]),
                                color = FS.colors.textMuted,
                                style = caption,
                            )
                            if (action == app.recommended) Text(stringResource(R.string.rm_suggested), color = FS.colors.accentText, style = caption)
                        }
                    }
                }
                if (chosen == "copy") {
                    val name = vm.choices[app.archivedServiceId]?.copyName.orEmpty()
                    OutlinedTextField(
                        value = name,
                        onValueChange = { vm.setCopyName(app, it) },
                        label = { Text(stringResource(R.string.rm_copy_name)) },
                        singleLine = true,
                        isError = !RestoreMergeViewModel.validSlug(name),
                        modifier = Modifier.fillMaxWidth().testTag("rm-copy-name"),
                    )
                    if (!RestoreMergeViewModel.validSlug(name)) Text(stringResource(R.string.rm_slug_rule), color = FS.colors.danger, style = caption)
                }
                RestoreMergeText.notes(app, chosen).forEach { Text(it, color = FS.colors.textMuted, style = caption) }
            }
        },
        confirmButton = { TextButton(onClick = onDone, modifier = Modifier.testTag("rm-sheet-done")) { Text(stringResource(R.string.done)) } },
    )
}

@Composable
private fun Result(vm: RestoreMergeViewModel) {
    if (vm.phase == Phase.Restoring) Progress(stringResource(R.string.rm_restoring))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            vm.run?.apps.orEmpty().forEach { a ->
                Row(Modifier.fillMaxWidth().testTag("rm-run-${a.archivedServiceId}")) {
                    Text(vm.preview?.apps?.firstOrNull { it.archivedServiceId == a.archivedServiceId }?.name ?: a.targetServiceId, color = FS.colors.text, style = body, modifier = Modifier.weight(1f))
                    Text(RestoreMergeText.step(a.step), color = if (a.step == "failed" || a.step == "refused-changed") FS.colors.warning else FS.colors.textMuted, style = caption)
                }
            }
        }
    }
    RestoreUndoPointsList(vm)
}

/** The kept copies a restore left: each with its end date, Undo and Delete now (both signed and confirmed). */
@Composable
internal fun RestoreUndoPointsList(vm: RestoreMergeViewModel) {
    val scope = rememberCoroutineScope()
    var confirming by remember { mutableStateOf<Pair<RestoreMergeUndoPoint, Boolean>?>(null) }
    if (vm.undoPoints.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("rm-undo-list")) {
        Text(stringResource(R.string.rm_earlier_copies), color = FS.colors.text, style = body)
        vm.undoPoints.forEach { p ->
            Column(Modifier.testTag("rm-undo-row-${p.serviceId}")) {
                Text(p.name, color = FS.colors.text, style = body)
                Text(fsString(R.string.rm_kept_until, day(p.expiresAt)), color = FS.colors.textMuted, style = caption)
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    TextButton(
                        onClick = { confirming = p to false },
                        enabled = vm.isAdmin && vm.busyUndo != p.id,
                        modifier = Modifier.testTag("rm-undo-${p.serviceId}"),
                    ) { Text(stringResource(R.string.rm_undo)) }
                    TextButton(
                        onClick = { confirming = p to true },
                        enabled = vm.isAdmin && vm.busyUndo != p.id,
                        colors = androidx.compose.material3.ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.testTag("rm-discard-${p.serviceId}"),
                    ) { Text(stringResource(R.string.rm_delete_now)) }
                }
            }
        }
        if (!vm.isAdmin) Text(stringResource(R.string.rm_admin_only), color = FS.colors.textMuted, style = caption, modifier = Modifier.testTag("rm-undo-admin-only"))
    }
    confirming?.let { (p, discard) ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(if (discard) R.string.rm_delete_q else R.string.rm_undo_q)) },
            text = { Text(if (discard) fsString(R.string.rm_discard_msg, p.name) else fsString(R.string.rm_undo_msg, p.name, dateTime(p.keptAt))) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = null
                        scope.launch { vm.undo(p, discard) }
                    },
                    modifier = Modifier.testTag("rm-confirm"),
                ) { Text(stringResource(if (discard) R.string.delete_2 else R.string.rm_undo), color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
