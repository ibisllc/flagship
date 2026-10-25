// Offline control (docs/data-sovereignty.md): reach your own server on this Wi-Fi when Flagship
// can't be reached, check it by its own key, and see its status, start, stop or restart its apps,
// restart or shut it down, and save its data. Reached from Settings (always), from a server's page
// while it can't be reached, and from "This account was removed". MIRRORS the iOS
// OfflineControlScreen.swift.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.Rescue
import com.flagshipserver.app.core.RescueServerApp
import com.flagshipserver.app.core.RescueServerStatus
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.OfflineControlViewModel
import com.flagshipserver.app.viewmodels.offlineControlEnvironment
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun OfflineControlScreen(username: String, focus: String? = null, onBack: (() -> Unit)? = null) {
    val context = LocalContext.current
    val vm = remember(username, focus) { OfflineControlViewModel(offlineControlEnvironment(context, username), focus) }
    DisposableEffect(vm) {
        vm.start()
        onDispose { vm.stop() }
    }
    val phase by vm.phase.collectAsState()
    FSScreen(title = stringResource(R.string.offline_control), onBack = onBack, titleTag = "offline-control") {
        when (phase) {
            OfflineControlViewModel.Phase.Connected -> Connected(vm)
            else -> Finding(vm, phase)
        }
    }
}

@Composable
private fun Finding(vm: OfflineControlViewModel, phase: OfflineControlViewModel.Phase) {
    val scope = rememberCoroutineScope()
    val servers by vm.servers.collectAsState()
    val connecting = phase is OfflineControlViewModel.Phase.Connecting
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Text(stringResource(R.string.offline_heading), style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold), color = FS.colors.text)
        Text(stringResource(R.string.offline_intro), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (phase is OfflineControlViewModel.Phase.Connecting) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("offline-connecting")) {
                CircularProgressIndicator(Modifier.size(20.dp))
                Spacer(Modifier.width(FS.space.s2))
                Text(fsString(R.string.offline_checking, phase.domain), color = FS.colors.text)
            }
        }
        if (phase is OfflineControlViewModel.Phase.Failed) {
            Text(phase.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("offline-error"))
        }
        vm.notice?.let { Text(it, color = FS.colors.text, modifier = Modifier.testTag("offline-notice")) }
        FSSectionHeader(stringResource(R.string.offline_your_servers))
        if (servers.isEmpty()) {
            Text(stringResource(R.string.offline_no_servers), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("offline-no-servers"))
        }
        for (s in servers) {
            FSCard(modifier = Modifier.testTag("offline-server-${s.label}")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(s.label, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), color = FS.colors.text)
                    Text(s.domain, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("offline-domain-${s.label}"))
                    val found = s.found
                    if (found != null) {
                        Text(fsString(R.string.offline_found_at, found.display), color = FS.colors.success, modifier = Modifier.testTag("offline-found-${s.label}"))
                    } else if (vm.searching) {
                        Text(stringResource(R.string.offline_looking), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("offline-searching-${s.label}"))
                    }
                    if (!s.pinned) Text(stringResource(R.string.offline_unpinned), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FSPrimaryButton(
                        label = stringResource(R.string.offline_connect),
                        onClick = { scope.launch { vm.connect(s.domain) } },
                        enabled = s.pinned && !connecting,
                        block = true,
                        modifier = Modifier.testTag("offline-connect-${s.label}"),
                    )
                }
            }
        }
        FSSectionHeader(stringResource(R.string.offline_manual_heading))
        Text(stringResource(R.string.offline_manual_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FSField(value = vm.manualName, onValueChange = { vm.manualName = it }, label = stringResource(R.string.offline_manual_name), fieldTag = "offline-manual-name")
        FSField(value = vm.manualAddress, onValueChange = { vm.manualAddress = it }, label = stringResource(R.string.offline_manual_address), fieldTag = "offline-manual-address")
        FSSecondaryButton(
            label = stringResource(R.string.offline_manual_connect),
            onClick = { scope.launch { vm.connectManually() } },
            enabled = vm.canConnectManually && !connecting,
            block = true,
            modifier = Modifier.testTag("offline-manual-connect"),
        )
    }
}

private data class Pending(val action: Rescue.Action, val serviceId: String?, val name: String)

@Composable
private fun Connected(vm: OfflineControlViewModel) {
    val scope = rememberCoroutineScope()
    val snapshot by vm.snapshot.collectAsState()
    var confirm by remember { mutableStateOf<Pending?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Text(
            fsString(R.string.offline_connected_to, vm.serverDomain.orEmpty()),
            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
            color = FS.colors.text,
            modifier = Modifier.testTag("offline-connected-title"),
        )
        Text(stringResource(R.string.offline_checked_by_key), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        vm.certificateNote?.let { Text(it, color = FS.colors.text, modifier = Modifier.testTag("offline-cert-note")) }
        vm.notice?.let { Text(it, color = FS.colors.text, modifier = Modifier.testTag("offline-notice")) }
        vm.actionError?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("offline-action-error")) }
        snapshot?.status?.let { StatusCard(it) }
        FSSectionHeader(stringResource(R.string.offline_apps))
        val apps = snapshot?.apps.orEmpty()
        if (apps.isEmpty()) Text(stringResource(R.string.offline_no_apps), color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (a in apps) AppRow(vm, a) { confirm = it }
        if (vm.offersControls) {
            FSSectionHeader(stringResource(R.string.offline_server))
            Text(stringResource(R.string.offline_restart_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSSecondaryButton(
                    label = stringResource(R.string.offline_restart),
                    onClick = { confirm = Pending(Rescue.Action.SERVER_RESTART, null, vm.serverDomain.orEmpty()) },
                    enabled = vm.busy == null,
                    modifier = Modifier.testTag("offline-server-restart"),
                )
                FSDangerButton(
                    label = stringResource(R.string.offline_shut_down),
                    onClick = { confirm = Pending(Rescue.Action.SERVER_SHUTDOWN, null, vm.serverDomain.orEmpty()) },
                    enabled = vm.busy == null,
                    modifier = Modifier.testTag("offline-server-shutdown"),
                )
            }
        }
        FSSectionHeader(stringResource(R.string.offline_rescue_heading))
        BackupSection(vm)
        TextButton(onClick = { vm.disconnect() }, modifier = Modifier.testTag("offline-disconnect")) { Text(stringResource(R.string.offline_disconnect)) }
    }
    confirm?.let { p ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(confirmTitle(p)) },
            text = { Text(confirmBody(p)) },
            confirmButton = {
                TextButton(onClick = { confirm = null; scope.launch { vm.perform(p.action, p.serviceId) } }, modifier = Modifier.testTag("offline-confirm")) {
                    Text(confirmButton(p.action))
                }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun StatusCard(st: RescueServerStatus) {
    FSCard(modifier = Modifier.testTag("offline-status")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            st.version?.let { Text(fsString(R.string.offline_software, it), color = FS.colors.text) }
            st.startedAt?.takeIf { it > 0 }?.let {
                Text(fsString(R.string.offline_running_since, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it))), color = FS.colors.text)
            }
            if (st.diskUsedBytes != null && (st.diskTotalBytes ?: 0) > 0) {
                Text(fsString(R.string.offline_disk, ServerArchive.formatBytes(st.diskUsedBytes), ServerArchive.formatBytes(st.diskTotalBytes!!)), color = FS.colors.text)
            }
            st.certValidUntil?.takeIf { it > 0 }?.let {
                val d = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it))
                Text(if (it < System.currentTimeMillis()) fsString(R.string.offline_cert_expired, d) else fsString(R.string.offline_cert_valid, d), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun AppRow(vm: OfflineControlViewModel, a: RescueServerApp, ask: (Pending) -> Unit) {
    val scope = rememberCoroutineScope()
    FSCard(modifier = Modifier.testTag("offline-app-${a.serviceId}")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(a.name, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), color = FS.colors.text, modifier = Modifier.weight(1f))
                Text(
                    stateLabel(a.state),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (a.state == "running") FS.colors.success else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("offline-app-state-${a.serviceId}"),
                )
            }
            if (vm.offersControls) {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                    if (a.state == "stopped") {
                        FSSecondaryButton(
                            label = stringResource(R.string.offline_start),
                            onClick = { scope.launch { vm.perform(Rescue.Action.APP_START, a.serviceId) } },
                            enabled = vm.busy == null,
                            modifier = Modifier.testTag("offline-app-start-${a.serviceId}"),
                        )
                    } else {
                        FSSecondaryButton(
                            label = stringResource(R.string.offline_restart),
                            onClick = { ask(Pending(Rescue.Action.APP_RESTART, a.serviceId, a.name)) },
                            enabled = vm.busy == null,
                            modifier = Modifier.testTag("offline-app-restart-${a.serviceId}"),
                        )
                        FSSecondaryButton(
                            label = stringResource(R.string.offline_stop),
                            onClick = { ask(Pending(Rescue.Action.APP_STOP, a.serviceId, a.name)) },
                            enabled = vm.busy == null,
                            modifier = Modifier.testTag("offline-app-stop-${a.serviceId}"),
                        )
                    }
                    if (vm.busy?.startsWith(a.serviceId + "|") == true) CircularProgressIndicator(Modifier.size(20.dp))
                }
            }
        }
    }
}

@Composable
private fun BackupSection(vm: OfflineControlViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val backup by vm.backup.collectAsState()
    var copied by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var saveNote by remember { mutableStateOf<String?>(null) }
    val saver = rememberSaveBackupLauncher(
        file = { (vm.backup.value as? OfflineControlViewModel.Backup.Saved)?.file },
        onSaving = { saving = it },
        onResult = { ok -> saveNote = if (ok) FSStrings.get(R.string.saved) else FSStrings.get(R.string.couldnt_save_the_backup_there_pick) },
    )
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        when (val b = backup) {
            OfflineControlViewModel.Backup.Idle -> {
                Text(stringResource(R.string.offline_rescue_intro), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FSPrimaryButton(label = stringResource(R.string.offline_rescue), onClick = { vm.askPasscode() }, block = true, modifier = Modifier.testTag("offline-rescue"))
            }
            OfflineControlViewModel.Backup.Passcode -> {
                Text(stringResource(R.string.set_the_backups_passcode), style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), color = FS.colors.text)
                Text(BackupsText.PASSCODE_WHY, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
                Text(ServerArchive.PASSCODE_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                if (vm.useOwnPasscode) {
                    FSField(value = vm.ownPasscode, onValueChange = { vm.ownPasscode = it }, label = stringResource(R.string.your_passcode), visualTransformation = PasswordVisualTransformation(), fieldTag = "offline-own-passcode")
                    FSField(value = vm.ownPasscodeAgain, onValueChange = { vm.ownPasscodeAgain = it }, label = stringResource(R.string.type_it_again), visualTransformation = PasswordVisualTransformation(), fieldTag = "offline-own-passcode-again")
                    vm.ownPasscodeHint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    TextButton(onClick = { vm.useOwnPasscode = false }) { Text(stringResource(R.string.use_the_suggested_passcode)) }
                } else {
                    FSCard {
                        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text(stringResource(R.string.suggested_passcode), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            SelectionContainer {
                                Text(
                                    vm.suggestedPasscode,
                                    style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace),
                                    color = FS.colors.text,
                                    modifier = Modifier.testTag("offline-backup-passcode"),
                                )
                            }
                            TextButton(onClick = {
                                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                cm.setPrimaryClip(ClipData.newPlainText(FSStrings.get(R.string.backup_passcode), vm.suggestedPasscode))
                                copied = true
                            }) { Text(if (copied) stringResource(R.string.copied_2) else stringResource(R.string.copy)) }
                        }
                    }
                    TextButton(onClick = { vm.useOwnPasscode = true }) { Text(stringResource(R.string.use_my_own_passcode_instead)) }
                }
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.ive_saved_the_passcode_somewhere_safe), color = FS.colors.text, modifier = Modifier.weight(1f))
                    Switch(checked = vm.passcodeSaved, onCheckedChange = { vm.passcodeSaved = it }, modifier = Modifier.testTag("offline-backup-passcode-saved"))
                }
                FSPrimaryButton(
                    label = stringResource(R.string.offline_make_and_download),
                    onClick = { scope.launch { vm.startBackup() } },
                    enabled = vm.canStartBackup,
                    block = true,
                    modifier = Modifier.testTag("offline-backup-start"),
                )
            }
            is OfflineControlViewModel.Backup.Building -> Column(Modifier.testTag("offline-backup-progress"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(b.label, color = FS.colors.text)
                LinearProgressIndicator(progress = { b.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
            }
            is OfflineControlViewModel.Backup.Downloading -> Column(Modifier.testTag("offline-backup-downloading"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(fsString(R.string.offline_downloading, (b.fraction * 100).toInt()), color = FS.colors.text)
                LinearProgressIndicator(progress = { b.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
            }
            is OfflineControlViewModel.Backup.Interrupted -> {
                Text(b.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("offline-backup-interrupted"))
                FSPrimaryButton(label = stringResource(R.string.offline_resume), onClick = { scope.launch { vm.download() } }, block = true, modifier = Modifier.testTag("offline-backup-resume"))
            }
            is OfflineControlViewModel.Backup.Saved -> {
                Text(stringResource(R.string.offline_saved_note), color = FS.colors.text, modifier = Modifier.testTag("offline-backup-saved"))
                Text(b.file.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                saveNote?.let { Text(it, color = FS.colors.success) }
                FSPrimaryButton(
                    label = if (saving) stringResource(R.string.saving) else stringResource(R.string.save_the_backup),
                    onClick = { saver.launch(b.file.name) },
                    enabled = !saving,
                    block = true,
                    modifier = Modifier.testTag("offline-backup-share"),
                )
            }
            is OfflineControlViewModel.Backup.Failed -> {
                Text(b.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("offline-backup-error"))
                FSSecondaryButton(label = stringResource(R.string.try_again), onClick = { vm.askPasscode() }, block = true)
            }
        }
    }
}

@Composable
private fun stateLabel(s: String): String = when (s) {
    "running" -> stringResource(R.string.offline_state_running)
    "starting" -> stringResource(R.string.offline_state_starting)
    "stopped" -> stringResource(R.string.offline_state_stopped)
    else -> stringResource(R.string.offline_state_unknown)
}

@Composable
private fun confirmTitle(p: Pending): String = when (p.action) {
    Rescue.Action.APP_STOP -> fsString(R.string.offline_confirm_stop, p.name)
    Rescue.Action.APP_RESTART -> fsString(R.string.offline_confirm_restart, p.name)
    Rescue.Action.APP_START -> fsString(R.string.offline_confirm_start, p.name)
    Rescue.Action.SERVER_RESTART -> stringResource(R.string.offline_confirm_restart_server)
    Rescue.Action.SERVER_SHUTDOWN -> stringResource(R.string.offline_confirm_shutdown_server)
}

@Composable
private fun confirmBody(p: Pending): String = when (p.action) {
    Rescue.Action.APP_STOP -> stringResource(R.string.offline_confirm_stop_body)
    Rescue.Action.APP_RESTART, Rescue.Action.APP_START -> stringResource(R.string.offline_confirm_app_body)
    Rescue.Action.SERVER_RESTART -> stringResource(R.string.offline_confirm_restart_server_body)
    Rescue.Action.SERVER_SHUTDOWN -> stringResource(R.string.offline_confirm_shutdown_body)
}

@Composable
private fun confirmButton(a: Rescue.Action): String = when (a) {
    Rescue.Action.APP_STOP -> stringResource(R.string.offline_stop)
    Rescue.Action.APP_RESTART, Rescue.Action.SERVER_RESTART -> stringResource(R.string.offline_restart)
    Rescue.Action.APP_START -> stringResource(R.string.offline_start)
    Rescue.Action.SERVER_SHUTDOWN -> stringResource(R.string.offline_shut_down)
}
