// "Replace this server" Compose screen (Android). Mirror of iOS
// FlagshipUI/Screens/ReplaceServerScreen.swift
// (docs/server-replacement-graceful-decommission.md). Pre-flight backup gate →
// disposition picker → mint + sign + deposit → progress → completion that points
// at the existing create-server flow for the replacement.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.ReplaceServerFlow
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ReplaceServerPhase
import com.flagshipserver.app.viewmodels.ReplaceServerViewModel
import kotlinx.coroutines.launch

@Composable
private fun ReplaceCallout(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text,
        color = FS.colors.text,
        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.sm))
            .background(color.copy(alpha = 0.12f))
            .padding(FS.space.s3),
    )
}

@Composable
fun ReplaceServerScreen(vm: ReplaceServerViewModel, serverFqdn: String) {
    val phase by vm.phase.collectAsState()
    val scope = rememberCoroutineScope()
    var typed by remember { mutableStateOf("") }
    var disposition by remember { mutableStateOf(ReplaceServerFlow.Disposition.WipeAfterHandoff) }
    val confirmed = typed.lowercase() == serverFqdn.lowercase()
    val scroll = rememberScrollState()

    LaunchedEffect(Unit) { vm.preflight() }

    Column(
        Modifier.fillMaxSize().verticalScroll(scroll).padding(FS.space.s6),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        val working = phase is ReplaceServerPhase.Signing || phase is ReplaceServerPhase.Posting
        when (val p = phase) {
            is ReplaceServerPhase.CheckingBackup -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator()
                    Spacer(Modifier.width(FS.space.s3))
                    Text("Checking this server's backup…", color = FS.colors.textMuted)
                }
            }
            is ReplaceServerPhase.BackupGate ->
                BackupGate(serverFqdn, typed, { typed = it }, confirmed, working) {
                    scope.launch { vm.replace(ReplaceServerFlow.Disposition.WipeNow) }
                }
            is ReplaceServerPhase.Ready ->
                Picker(serverFqdn, disposition, { disposition = it }, typed, { typed = it }, confirmed, working) {
                    scope.launch { vm.replace(disposition) }
                }
            is ReplaceServerPhase.Signing, is ReplaceServerPhase.Posting -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator()
                    Spacer(Modifier.width(FS.space.s3))
                    Text("Replacing this server…", color = FS.colors.textMuted)
                }
            }
            is ReplaceServerPhase.Completed -> Completed(serverFqdn)
            is ReplaceServerPhase.Failed -> {
                ReplaceCallout(p.message, FS.colors.danger)
                if (vm.backupMissing) {
                    BackupGate(serverFqdn, typed, { typed = it }, confirmed, working) {
                        scope.launch { vm.replace(ReplaceServerFlow.Disposition.WipeNow) }
                    }
                } else {
                    Picker(serverFqdn, disposition, { disposition = it }, typed, { typed = it }, confirmed, working) {
                        scope.launch { vm.replace(disposition) }
                    }
                }
            }
        }
    }
}

// MARK: - Backup pre-flight gate (HARD)

@Composable
private fun BackupGate(
    serverFqdn: String,
    typed: String,
    onTyped: (String) -> Unit,
    confirmed: Boolean,
    working: Boolean,
    onWipeNow: () -> Unit,
) {
    Text("This server has no backup", color = FS.colors.text, style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Medium))
    ReplaceCallout(
        "Replacing $serverFqdn retires the box and powers it off. With no peer-backup enrolled, its data has nowhere to go — replacing it will LOSE everything on it.",
        FS.colors.warning,
    )
    Text(
        "Set up backup first (recommended), or — if you accept losing this server's data — replace it now with an immediate wipe.",
        color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    FSField(value = typed, onValueChange = onTyped, label = "To replace anyway, type the server's address to confirm", placeholder = serverFqdn, fieldTag = "replace-confirm-field")
    FSDangerButton(
        label = if (working) "Working…" else "Wipe now & replace (lose data)",
        onClick = { if (confirmed && !working) onWipeNow() },
        enabled = confirmed && !working,
        block = true,
        modifier = Modifier.semantics { contentDescription = "replace-wipe-now-accept-loss" },
    )
}

// MARK: - Disposition picker (backup present)

@Composable
private fun Picker(
    serverFqdn: String,
    disposition: ReplaceServerFlow.Disposition,
    onPick: (ReplaceServerFlow.Disposition) -> Unit,
    typed: String,
    onTyped: (String) -> Unit,
    confirmed: Boolean,
    working: Boolean,
    onReplace: () -> Unit,
) {
    Text("Replace this server", color = FS.colors.text, style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Medium))
    Text(
        "This retires $serverFqdn: it flushes a final backup, releases its address, and powers off — so a replacement box can take over the same name cleanly. Choose what happens to its disk.",
        color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    DispositionRow(disposition, onPick, ReplaceServerFlow.Disposition.WipeAfterHandoff,
        "Wipe after hand-off (recommended)",
        "Keeps the old disk as a safety net until the replacement proves a good restore, then scrubs it.")
    DispositionRow(disposition, onPick, ReplaceServerFlow.Disposition.Keep,
        "Keep the disk",
        "Powers off with data intact — a local fallback copy. The box could be powered on again (it self-retires if so).")
    DispositionRow(disposition, onPick, ReplaceServerFlow.Disposition.WipeNow,
        "Wipe now",
        "Flushes the backup, then wipes immediately. The backup becomes the only copy — irreversible.")
    if (disposition == ReplaceServerFlow.Disposition.WipeNow) {
        ReplaceCallout("Wipe now is irreversible: once it wipes, the backup is the sole copy. If that final flush fails, the data is gone.", FS.colors.danger)
    }
    FSField(value = typed, onValueChange = onTyped, label = "Type the server's address to confirm", placeholder = serverFqdn, fieldTag = "replace-confirm-field")
    FSDangerButton(
        label = if (working) "Working…" else "Replace this server",
        onClick = { if (confirmed && !working) onReplace() },
        enabled = confirmed && !working,
        block = true,
        modifier = Modifier.semantics { contentDescription = "replace-start" },
    )
}

@Composable
private fun DispositionRow(
    selected: ReplaceServerFlow.Disposition,
    onPick: (ReplaceServerFlow.Disposition) -> Unit,
    value: ReplaceServerFlow.Disposition,
    title: String,
    detail: String,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.sm))
            .background(FS.colors.surface)
            .selectable(selected = selected == value, onClick = { onPick(value) })
            .padding(FS.space.s3)
            .semantics { contentDescription = "replace-disposition-${value.wire}" },
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected = selected == value, onClick = { onPick(value) })
        Spacer(Modifier.width(FS.space.s2))
        Column {
            Text(title, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
            Text(detail, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
        }
    }
}

// MARK: - Completion

@Composable
private fun Completed(serverFqdn: String) {
    ReplaceCallout("$serverFqdn is being retired. It'll flush its final backup, release its address, and power off.", FS.colors.success)
    Text(
        "It's been removed from your fleet here, so it won't ask to unlock again. There may be a brief gap while the old box hands off and the new one takes over.",
        color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    )
    Text(
        "Next: create the replacement server (same name) from “Add a server” on Home — burn it, and it restores from the final backup.",
        color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    )
}
