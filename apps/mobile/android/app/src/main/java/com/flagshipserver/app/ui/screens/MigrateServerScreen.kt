// "Migrate to new machine / VM" Compose screen (docs/server-migration.md). Mirror
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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.MigrationMode
import com.flagshipserver.app.viewmodels.MigrationViewModel
import kotlinx.coroutines.launch

/** A tinted callout: the tone's icon and a line on its soft fill. */
@Composable
private fun MigrateCallout(text: String, color: Color) {
    val palette = FS.colors
    val icon = when (color) {
        palette.success -> Icons.Outlined.CheckCircle
        palette.danger -> Icons.Outlined.ErrorOutline
        palette.warning -> Icons.Outlined.Warning
        else -> Icons.Outlined.Info
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(color.copy(alpha = 0.12f))
            .padding(FS.space.s3),
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
        Text(text, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
    }
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

    // Shown in a full-screen sheet under the server page's "Migrate server"
    // bar (iOS's sheet with its navigation title).
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        when (val m = mode) {
            is MigrationMode.Loading -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(FS.space.s3))
                    Text(
                        "Checking for a migration in progress…",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
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
    val working by vm.working.collectAsState()
    val errorMessage by vm.errorMessage.collectAsState()
    val scope = rememberCoroutineScope()

    Text(
        "Migrate ${vm.serverFqdn}",
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.titleLarge,
    )
    if (vm.backupMissing) {
        MigrateCallout(
            "No backup is set up for this server. The migration moves data through backup, so turn backup on first.",
            FS.colors.warning,
        )
    } else {
        MigrateCallout(
            "Peer backup is on. The new server restores from it while this one keeps serving.",
            FS.colors.primary,
        )
    }

    if (vm.backupMissing) {
        Text(
            "This server has no backup yet, so it can't be migrated. Enable backup first, or use Backup/clone server and import the file onto the new server.",
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
        )
    }

    Text(
        "The old server is retired and wiped only after the new one has restored the data and taken over the name: from then on it can't unlock or connect, and it wipes itself as soon as it is reachable. If anything fails first, the old server keeps serving with all its data.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
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

// MARK: - Progress mode (the 8-step timeline)

@Composable
private fun ProgressMode(vm: MigrationViewModel) {
    val session by vm.session.collectAsState()
    val working by vm.working.collectAsState()
    val errorMessage by vm.errorMessage.collectAsState()
    val scope = rememberCoroutineScope()

    Text(
        "Migrating ${vm.serverFqdn}",
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.titleLarge,
    )

    if (session?.phase == "initiated") {
        MigrateCallout(
            "Next: add the NEW server with Add a server (any name: it becomes ${vm.serverFqdn} at take-over). It attaches here by itself once it's online.",
            FS.colors.primary,
        )
    }

    FSCard(padding = PaddingValues(vertical = FS.space.s2)) {
        for (step in vm.steps) {
            MigrateStepRow(step)
        }
    }

    val copy = vm.waitCopy
    if (copy.isNotEmpty()) {
        Text(
            copy,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { contentDescription = "migrate-wait-copy" },
        )
    }

    errorMessage?.let { MigrateCallout(it, FS.colors.danger) }

    when (session?.phase) {
        "pre-seeded" -> FSPrimaryButton(
            label = if (working) "Signing…" else "Hand off to the new server now",
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
            "Migration stopped. Your old server stays active with all its data.",
            FS.colors.warning,
        )
    } else if (session?.done == true) {
        MigrateCallout(
            "Migration complete. ${vm.serverFqdn} now runs on the new server.",
            FS.colors.success,
        )
    }

    if (vm.canAbort) {
        // Secondary, not danger — aborting is the SAFE exit (mirrors the
        // webapp): the old server stays active with all its data.
        FSSecondaryButton(
            label = if (working) "Working…" else "Stop the migration (the old server keeps all its data)",
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
        horizontalArrangement = Arrangement.spacedBy(FS.space.s4),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s1)
            .semantics { contentDescription = "migrate-step-${step.key}-$stateName" },
    ) {
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            when (step.state) {
                ServerMigrationTimeline.StepState.DONE ->
                    Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = FS.colors.success)
                ServerMigrationTimeline.StepState.ACTIVE ->
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
                ServerMigrationTimeline.StepState.PENDING ->
                    Icon(Icons.Outlined.RadioButtonUnchecked, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
            }
        }
        Text(
            step.label,
            color = if (step.state == ServerMigrationTimeline.StepState.PENDING)
                MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}
