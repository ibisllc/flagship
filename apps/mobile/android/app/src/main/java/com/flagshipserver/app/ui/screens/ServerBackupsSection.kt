// The server page's Backups section (docs/server-backup-and-clone.md, "Backup
// policy" and "Scheduled backups"): the policy and the space it lets the apps
// use, the saved backups and their schedule, Back up now into the list,
// downloading one, and this phone's own copy. The one-off Backup/clone and
// Migrate buttons stay below it. MIRRORS the iOS ServerBackupsSection.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.os.StatFs
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.SavedBackup
import com.flagshipserver.app.core.AdminOrderGate
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PhoneBackupCopies
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ServerBackupsViewModel
import kotlinx.coroutines.launch
import java.io.File

private val caption = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
private val body = TextStyle(fontSize = 14.sp, lineHeight = 20.sp)

internal fun phoneFreeBytes(context: Context): Long = runCatching { StatFs(context.filesDir.path).availableBytes }.getOrDefault(0L)

@Composable
internal fun ServerBackupsSection(serverDomain: String) {
    val context = LocalContext.current
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val screens = LocalScreensClient.current
    val isAdmin = AdminOrderGate.allows(app)
    val vm = remember(serverDomain, isAdmin) {
        val pod = app.pods.value.firstOrNull { it.fqdn.equals(serverDomain, ignoreCase = true) }
        ServerBackupsViewModel(
            serverFqdn = serverDomain,
            client = pod?.let { podClients.screens(it) } ?: screens,
            isAdmin = isAdmin,
            sign = { bytes -> Keystore.adminSigningKey("Approve backups for $serverDomain").sign(bytes) },
            mintKeys = { n -> Keystore.mintServerArchiveKeys(n, "Approve backups for $serverDomain") },
            signingNeedsPrompt = { Keystore.sensitiveSigningNeedsPrompt() },
            downloadDir = { File(context.cacheDir, "saved-backups") },
        )
    }
    LaunchedEffect(vm) { vm.load() }
    ServerBackupsContent(vm = vm, copies = remember { PhoneBackupCopies.from(context) }, phoneFreeBytes = remember { phoneFreeBytes(context) })
}

@Composable
internal fun ServerBackupsContent(vm: ServerBackupsViewModel, copies: PhoneBackupCopies?, phoneFreeBytes: Long) {
    val scope = rememberCoroutineScope()
    var editSchedule by remember { mutableStateOf(false) }
    var editPolicy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<SavedBackup?>(null) }
    var downloaded by remember { mutableStateOf<Map<String, File>>(emptyMap()) }
    var saving by remember { mutableStateOf(false) }
    var saveNote by remember { mutableStateOf<String?>(null) }
    var saveTarget by remember { mutableStateOf<File?>(null) }
    var keepCopy by remember { mutableStateOf(copies?.keepCopy(vm.serverFqdn) ?: true) }
    val saver = rememberSaveBackupLauncher(
        file = { saveTarget },
        onSaving = { saving = it },
        onResult = { ok -> saveNote = if (ok) "Saved." else "Couldn't save the backup there. Pick another place." },
    )

    Text("Backups", color = FS.colors.text, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("sd-backups")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            // ── Policy ──
            val p = vm.policy
            if (p != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        BackupsText.policyLine(p.policy),
                        color = FS.colors.text,
                        style = body,
                        modifier = Modifier.weight(1f).testTag("sd-backups-policy"),
                    )
                    TextButton(
                        onClick = { editPolicy = true },
                        enabled = vm.isAdmin,
                        modifier = Modifier.testTag("sd-backups-policy-change"),
                    ) { Text(if (p.policy.policy == "unset") "Choose" else "Change") }
                }
                BackupsText.usageLine(p.policy.policy, p.cap)?.let { line ->
                    Text(line, color = FS.colors.textMuted, style = caption, modifier = Modifier.testTag("sd-backups-usage"))
                    val used = p.cap.usedBytes ?: 0
                    p.cap.limitBytes?.takeIf { it > 0 }?.let { limit ->
                        LinearProgressIndicator(
                            progress = { (used.toDouble() / limit).coerceIn(0.0, 1.0).toFloat() },
                            color = if (p.cap.overLimit) FS.colors.danger else FS.colors.primary,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (p.cap.overLimit) {
                    p.cap.overReason?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-over")) }
                }
                if (p.policy.policy == "peer") {
                    p.peer?.let { peer ->
                        Column(Modifier.testTag("sd-backups-peer")) {
                            BackupsText.peerLines(peer).forEach { Text(it, color = FS.colors.textMuted, style = caption) }
                        }
                    }
                }
                vm.policyError?.takeIf { !editPolicy }?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-policy-error")) }
                HorizontalDivider(color = FS.colors.border)
            }

            vm.loadError?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-load-error")) }
            val v = vm.view
            if (v != null) {
                // ── Status ──
                Text(BackupsText.statusLine(v), color = FS.colors.text, style = body, modifier = Modifier.testTag("sd-backups-status"))
                v.running?.let { r ->
                    if (r.progress.total > 0) {
                        LinearProgressIndicator(progress = { r.progress.done.toFloat() / r.progress.total }, modifier = Modifier.fillMaxWidth())
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
                BackupsText.failedLine(v)?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-failed")) }

                // ── Next and the schedule (not while the policy is "No backups") ──
                if (v.scheduleActive) {
                    BackupsText.nextLine(v)?.let { Text(it, color = FS.colors.textMuted, style = caption, modifier = Modifier.testTag("sd-backups-next")) }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            BackupsText.scheduleLine(v.schedule),
                            color = FS.colors.textMuted,
                            style = caption,
                            modifier = Modifier.weight(1f).testTag("sd-backups-schedule"),
                        )
                        TextButton(
                            onClick = { editSchedule = true },
                            enabled = vm.isAdmin,
                            modifier = Modifier.testTag("sd-backups-schedule-change"),
                        ) { Text("Change") }
                    }
                }
                if (vm.isAdmin && (vm.needsApproval || (v.keysLeft == 0 && v.keysWanted > 0))) {
                    FSSecondaryButton(
                        label = if (vm.busy) "Approving…" else BackupsText.APPROVE,
                        onClick = { scope.launch { vm.deposit() } },
                        enabled = !vm.busy,
                        block = true,
                        modifier = Modifier.testTag("sd-backups-approve"),
                    )
                } else if (!vm.isAdmin && v.keysLeft == 0) {
                    v.waitingReason?.let { Text(it, color = FS.colors.warning, style = caption, modifier = Modifier.testTag("sd-backups-waiting")) }
                }

                FSPrimaryButton(
                    label = "Back up now",
                    onClick = { scope.launch { vm.backUpNow() } },
                    enabled = vm.isAdmin && v.running == null && !vm.busy,
                    block = true,
                    modifier = Modifier.testTag("sd-backups-run"),
                )
                if (!vm.isAdmin) Text(AdminOrderGate.SERVER, color = FS.colors.textMuted, style = caption, modifier = Modifier.testTag("sd-backups-admin-only"))
                vm.actionError?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-error")) }

                // ── The list ──
                v.backups.forEach { b ->
                    HorizontalDivider(color = FS.colors.border)
                    Column(Modifier.testTag("sd-backups-row-${b.archiveId}"), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        Text(BackupsText.rowLine(b), color = FS.colors.text, style = caption)
                        BackupsText.leftLine(b)?.let { Text(it, color = FS.colors.warning, style = caption) }
                        val progress = vm.downloading[b.archiveId]
                        if (progress != null) LinearProgressIndicator(progress = { progress.toFloat() }, modifier = Modifier.fillMaxWidth())
                        val file = downloaded[b.archiveId]
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            if (file == null) {
                                FSSecondaryButton(
                                    label = if (progress != null) "Downloading…" else "Download",
                                    onClick = {
                                        scope.launch {
                                            vm.download(b)?.let { f -> downloaded = downloaded + (b.archiveId to f) }
                                        }
                                    },
                                    enabled = progress == null,
                                    modifier = Modifier.testTag("sd-backups-download-${b.archiveId}"),
                                )
                            } else {
                                FSPrimaryButton(
                                    label = if (saving) "Saving…" else "Save…",
                                    onClick = {
                                        saveNote = null
                                        saveTarget = file
                                        saver.launch(file.name)
                                    },
                                    enabled = !saving,
                                    modifier = Modifier.testTag("sd-backups-save-${b.archiveId}"),
                                )
                            }
                            FSDangerButton(
                                label = "Delete",
                                onClick = { confirmDelete = b },
                                enabled = vm.isAdmin,
                                modifier = Modifier.testTag("sd-backups-delete-${b.archiveId}"),
                            )
                        }
                        if (file != null) Text("Downloaded ${file.name}.", color = FS.colors.success, style = caption, modifier = Modifier.testTag("sd-backups-downloaded-${b.archiveId}"))
                    }
                }
                saveNote?.let { Text(it, color = FS.colors.textMuted, style = caption) }
                Text(BackupsText.LIST_NOTE, color = FS.colors.textMuted, style = caption, modifier = Modifier.testTag("sd-backups-note"))

                // ── This phone's copy (phone-side backups) ──
                val kind = vm.policy?.policy?.policy ?: "unset"
                if (copies != null && (kind == "phone" || kind == "unset")) {
                    HorizontalDivider(color = FS.colors.border)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(BackupsText.KEEP_COPY, color = FS.colors.text, style = body)
                            Text(BackupsText.KEEP_COPY_NOTE, color = FS.colors.textMuted, style = caption)
                        }
                        Switch(
                            checked = keepCopy,
                            onCheckedChange = {
                                keepCopy = it
                                copies.setKeepCopy(vm.serverFqdn, it)
                            },
                            modifier = Modifier.testTag("sd-backups-keep-copy"),
                        )
                    }
                    copies.note(vm.serverFqdn)?.let { Text(it, color = FS.colors.warning, style = caption) }
                    copies.copies(vm.serverFqdn).firstOrNull()?.let { c ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "On this phone: ${BackupsText.whenText(c.meta.createdAt)} · ${BackupsText.size(c.meta)}",
                                color = FS.colors.textMuted,
                                style = caption,
                                modifier = Modifier.weight(1f).testTag("sd-backups-phone-copy"),
                            )
                            TextButton(
                                onClick = {
                                    saveNote = null
                                    saveTarget = c.file
                                    saver.launch(c.file.name)
                                },
                                modifier = Modifier.testTag("sd-backups-phone-save"),
                            ) { Text("Save…") }
                        }
                    }
                }
            }
        }
    }

    if (editSchedule) {
        vm.view?.let { v -> ScheduleEditor(vm, v.schedule, onDismiss = { editSchedule = false }) }
    }
    if (editPolicy) {
        vm.policy?.let { p -> PolicyEditor(vm, p.policy, phoneFreeBytes, onDismiss = { editPolicy = false }) }
    }
    confirmDelete?.let { b ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(BackupsText.DELETE_CONFIRM) },
            text = { Text(BackupsText.rowLine(b)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = null
                        scope.launch { vm.delete(b.archiveId) }
                    },
                    modifier = Modifier.testTag("sd-backups-delete-confirm"),
                ) { Text("Delete", color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ScheduleEditor(vm: ServerBackupsViewModel, current: com.flagshipserver.app.api.BackupSchedule, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val local = remember { BackupsText.toLocal(current) }
    var frequency by remember { mutableStateOf(current.frequency) }
    var weekday by remember { mutableIntStateOf(local.weekday) }
    var minute by remember { mutableIntStateOf(local.minuteOfDay) }
    var keepDaily by remember { mutableIntStateOf(current.keepDaily) }
    var keepWeekly by remember { mutableIntStateOf(current.keepWeekly) }
    var saving by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text("Backup schedule") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    listOf("daily" to "Daily", "weekly" to "Weekly", "off" to "Off").forEach { (k, label) ->
                        val on = frequency == k
                        TextButton(onClick = { frequency = k }, modifier = Modifier.testTag("sd-backups-freq-$k")) {
                            Text(label, color = if (on) FS.colors.primary else FS.colors.textMuted, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
                        }
                    }
                }
                if (frequency != "off") {
                    if (frequency == "weekly") {
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                            TextButton(onClick = { weekday = (weekday + 6) % 7 }, modifier = Modifier.testTag("sd-backups-weekday-prev")) { Text("‹") }
                            Text(BackupsText.weekdayName(weekday), color = FS.colors.text, modifier = Modifier.align(Alignment.CenterVertically).testTag("sd-backups-weekday"))
                            TextButton(onClick = { weekday = (weekday + 1) % 7 }, modifier = Modifier.testTag("sd-backups-weekday-next")) { Text("›") }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { minute = (minute + 1440 - 60) % 1440 }, modifier = Modifier.testTag("sd-backups-hour-down")) { Text("−1 h") }
                        TextButton(onClick = { minute = (minute + 1440 - 15) % 1440 }, modifier = Modifier.testTag("sd-backups-minute-down")) { Text("−15") }
                        Text(BackupsText.timeText(minute), color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.testTag("sd-backups-time"))
                        TextButton(onClick = { minute = (minute + 15) % 1440 }, modifier = Modifier.testTag("sd-backups-minute-up")) { Text("+15") }
                        TextButton(onClick = { minute = (minute + 60) % 1440 }, modifier = Modifier.testTag("sd-backups-hour-up")) { Text("+1 h") }
                    }
                    Text("In this phone's time zone.", color = FS.colors.textMuted, style = caption)
                }
                Stepper("Keep daily", keepDaily, 0..60, "sd-backups-keep-daily") { keepDaily = it }
                Stepper("Keep weekly", keepWeekly, 0..52, "sd-backups-keep-weekly") { keepWeekly = it }
                vm.actionError?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-schedule-error")) }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    scope.launch {
                        saving = true
                        val s = BackupsText.toUtc(frequency, BackupsText.LocalSlot(weekday, minute), keepDaily, keepWeekly)
                        // "Off" keeps the box's time, so turning it back on starts where it was.
                        val sent = if (frequency == "off") current.copy(frequency = "off", keepDaily = keepDaily, keepWeekly = keepWeekly) else s
                        val ok = vm.saveSchedule(sent)
                        saving = false
                        if (ok) onDismiss()
                    }
                },
                enabled = !saving,
                modifier = Modifier.testTag("sd-backups-schedule-save"),
            ) { Text(if (saving) "Saving…" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") } },
    )
}

@Composable
private fun Stepper(label: String, value: Int, range: IntRange, tag: String, onValue: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = FS.colors.text, style = body, modifier = Modifier.weight(1f))
        TextButton(onClick = { onValue(maxOf(range.first, value - 1)) }, enabled = value > range.first, modifier = Modifier.testTag("$tag-down")) { Text("−") }
        Text("$value", color = FS.colors.text, style = body, modifier = Modifier.testTag(tag))
        TextButton(onClick = { onValue(minOf(range.last, value + 1)) }, enabled = value < range.last, modifier = Modifier.testTag("$tag-up")) { Text("+") }
    }
}

@Composable
private fun PolicyEditor(vm: ServerBackupsViewModel, current: com.flagshipserver.app.api.BackupPolicyState, phoneFreeBytes: Long, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var policy by remember { mutableStateOf(current.policy.takeIf { it in setOf("phone", "peer", "none") } ?: "phone") }
    var reserveGb by remember {
        mutableIntStateOf(
            if (current.policy == "phone" && current.phoneReserveBytes > 0) maxOf(1, (current.phoneReserveBytes / BackupsText.GB).toInt())
            else BackupsText.defaultReserveGb(phoneFreeBytes),
        )
    }
    var saving by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text("Backup policy") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                BackupPolicyOptions(
                    policy = policy,
                    onPolicy = { policy = it },
                    reserveGb = reserveGb,
                    onReserveGb = { reserveGb = it },
                    phoneFreeBytes = phoneFreeBytes,
                    tagPrefix = "sd-backups-policy",
                )
                vm.policyError?.let { Text(it, color = FS.colors.danger, style = caption, modifier = Modifier.testTag("sd-backups-policy-error")) }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    scope.launch {
                        saving = true
                        val ok = vm.changePolicy(policy, reserveGb.toLong() * BackupsText.GB)
                        saving = false
                        if (ok) onDismiss()
                    }
                },
                enabled = !saving,
                modifier = Modifier.testTag("sd-backups-policy-save"),
            ) { Text(if (saving) "Saving…" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") } },
    )
}
