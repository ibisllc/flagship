// "Migrate to new hardware" Compose screen (docs/server-migration.md). Mirror
// of iOS FlagshipUI/Screens/MigrateServerScreen.swift — one screen, two modes:
// no session yet → the admin-signed INITIATE ceremony; live session → the
// 8-step progress timeline with the phase-appropriate action (hand off /
// abort).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.ServerMigrationFlow
import com.flagshipserver.app.core.ServerMigrationTimeline
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.MigrationMode
import com.flagshipserver.app.viewmodels.MigrationViewModel
import kotlinx.coroutines.launch

@Composable
private fun MigrateCallout(text: String, color: Color) {
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
fun MigrateServerScreen(vm: MigrationViewModel) {
    val mode by vm.mode.collectAsState()
    val scroll = rememberScrollState()

    LaunchedEffect(Unit) { vm.load() }
    // Re-keyed on the mode so the poll starts when initiate → progress (after
    // start()), and Compose cancels it on dispose.
    LaunchedEffect(mode) {
        if (mode == MigrationMode.Progress) vm.pollLoop()
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(scroll).padding(FS.space.s6),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        when (val m = mode) {
            is MigrationMode.Loading -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator()
                    Spacer(Modifier.width(FS.space.s3))
                    Text("Checking for a migration in progress…", color = FS.colors.textMuted)
                }
            }
            is MigrationMode.Initiate -> InitiateMode(vm)
            is MigrationMode.Progress -> ProgressMode(vm)
            is MigrationMode.Failed -> MigrateCallout(m.message, FS.colors.danger)
        }
    }
}

// MARK: - Initiate mode

@Composable
private fun InitiateMode(vm: MigrationViewModel) {
    val disposition by vm.disposition.collectAsState()
    val working by vm.working.collectAsState()
    val errorMessage by vm.errorMessage.collectAsState()
    val scope = rememberCoroutineScope()

    Text(
        "Migrate ${vm.serverFqdn}",
        color = FS.colors.text,
        style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Medium),
    )
    if (vm.backupMissing) {
        MigrateCallout(
            "No backup is enrolled for this server. The migration moves data THROUGH backup — enable backup first, or choose to keep the old disk.",
            FS.colors.warning,
        )
    } else {
        MigrateCallout(
            "Peer-backup is enrolled — the new box restores from it while this one keeps serving.",
            FS.colors.primary,
        )
    }

    Text(
        "WHAT HAPPENS TO THE OLD BOX'S DISK?",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
    )
    MigrateDispositionRow(
        disposition, { vm.setDisposition(it) }, ServerMigrationFlow.Disposition.WipeAfterHandoff,
        "Wipe the old box after the new one takes over (recommended)",
        "Keeps the old disk as a safety net until the new box proves a good restore and takes over the name, then scrubs it.",
    )
    MigrateDispositionRow(
        disposition, { vm.setDisposition(it) }, ServerMigrationFlow.Disposition.Keep,
        "Keep the old disk (manual fallback copy)",
        "Powers off with data intact after the hand-off — a local fallback copy.",
    )

    if (disposition == ServerMigrationFlow.Disposition.WipeAfterHandoff && vm.backupMissing) {
        Text(
            "This server has no backup — enable backup first, or keep the old disk as the fallback.",
            color = FS.colors.danger,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        )
    }

    Text(
        "The old box is wiped only after the new one has restored the data and taken over the name. If anything fails, the old box keeps serving with all its data.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    )

    errorMessage?.let { MigrateCallout(it, FS.colors.danger) }

    FSPrimaryButton(
        label = if (working) "Signing…" else "Start migration",
        onClick = { if (!working && !vm.startBlocked) scope.launch { vm.start() } },
        enabled = !working && !vm.startBlocked,
        block = true,
        large = true,
        modifier = Modifier.semantics { contentDescription = "migrate-start" },
    )
}

@Composable
private fun MigrateDispositionRow(
    selected: ServerMigrationFlow.Disposition,
    onPick: (ServerMigrationFlow.Disposition) -> Unit,
    value: ServerMigrationFlow.Disposition,
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
            .semantics { contentDescription = "migrate-disposition-${value.wire}" },
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

// MARK: - Progress mode (the 8-step timeline)

@Composable
private fun ProgressMode(vm: MigrationViewModel) {
    val session by vm.session.collectAsState()
    val working by vm.working.collectAsState()
    val errorMessage by vm.errorMessage.collectAsState()
    val scope = rememberCoroutineScope()

    Text(
        "Migrating ${vm.serverFqdn}",
        color = FS.colors.text,
        style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Medium),
    )

    if (session?.phase == "initiated") {
        MigrateCallout(
            "Next: add the NEW box via Add a server (any name — it becomes ${vm.serverFqdn} at take-over). It attaches here automatically once online.",
            FS.colors.primary,
        )
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.sm))
            .background(FS.colors.surface)
            .padding(FS.space.s3),
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
    ) {
        for (step in vm.steps) {
            MigrateStepRow(step)
        }
    }

    val copy = vm.waitCopy
    if (copy.isNotEmpty()) {
        Text(
            copy,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            modifier = Modifier.semantics { contentDescription = "migrate-wait-copy" },
        )
    }

    errorMessage?.let { MigrateCallout(it, FS.colors.danger) }

    when (session?.phase) {
        "pre-seeded" -> FSPrimaryButton(
            label = if (working) "Signing…" else "Hand off to the new box now",
            onClick = { if (!working) scope.launch { vm.handOff() } },
            enabled = !working,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "migrate-hand-off" },
        )
        "ready" -> FSPrimaryButton(
            label = if (working) "Signing…" else "Freeze old server and hand off",
            onClick = { if (!working) scope.launch { vm.handOff() } },
            enabled = !working,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "migrate-freeze-retry" },
        )
    }

    if (session?.abortedAt != null) {
        MigrateCallout(
            "Migration aborted — your old server stays active with all its data.",
            FS.colors.warning,
        )
    } else if (session?.done == true) {
        MigrateCallout(
            "Migration complete — ${vm.serverFqdn} now runs on the new box.",
            FS.colors.success,
        )
    }

    if (vm.canAbort) {
        // Secondary, not danger — aborting is the SAFE exit (mirrors the
        // webapp): the old server stays active with all its data.
        FSSecondaryButton(
            label = if (working) "Working…" else "Abort migration — old server stays active with all data",
            onClick = { if (!working) scope.launch { vm.abort() } },
            enabled = !working,
            block = true,
            modifier = Modifier.semantics { contentDescription = "migrate-abort" },
        )
    }
}

@Composable
private fun MigrateStepRow(step: ServerMigrationTimeline.Step) {
    val stateName = when (step.state) {
        ServerMigrationTimeline.StepState.DONE -> "done"
        ServerMigrationTimeline.StepState.ACTIVE -> "active"
        ServerMigrationTimeline.StepState.PENDING -> "pending"
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.semantics { contentDescription = "migrate-step-${step.key}-$stateName" },
    ) {
        Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
            when (step.state) {
                ServerMigrationTimeline.StepState.DONE ->
                    Text("✓", color = FS.colors.success, style = TextStyle(fontWeight = FontWeight.Bold))
                ServerMigrationTimeline.StepState.ACTIVE ->
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = FS.colors.primary)
                ServerMigrationTimeline.StepState.PENDING ->
                    Text("○", color = FS.colors.textMuted)
            }
        }
        Text(
            step.label,
            color = if (step.state == ServerMigrationTimeline.StepState.PENDING)
                FS.colors.textMuted else FS.colors.text,
            style = TextStyle(fontSize = 15.sp),
        )
    }
}
