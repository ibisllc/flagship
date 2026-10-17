// Settings -> Peer backup: this server's peer backup (docs/peer-backup.md).
//
// Peer backup is a backup policy, chosen on the server's Backups page (Peer-
// distributed backups); this page only shows how it is going. Mirrors the
// webapp's views/peer-backup.js and lib/peerBackup.js word for word:
//   - the state (protected, at risk, looking for servers...) and the newest backup's pieces
//   - the servers holding the pieces, as "Server 1..n" (never named) with their last proof
//   - what this server keeps for others
//
//   GET /api/screens/peer-backup/status -> the v2 screen (box: peerNet/engine.ts)

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PeerBackup
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.PeerBackupViewModel

@Composable
fun PeerBackupScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val vm = remember { PeerBackupViewModel(client) }
    val state by vm.state.collectAsState()

    LaunchedEffect(Unit) { vm.load() }

    FSScreen(
        title = "Peer-backup",
        subtitle = "How this server's backup is kept on other servers.",
        onBack = { nav.popBackStack() },
        onRefresh = { vm.load() },
        refreshing = state is LoadingState.Loading,
        modifier = Modifier.semantics { testTag = "peer-backup" },
    ) {
        when (val s = state) {
            is LoadingState.Loaded -> Body(s.value)
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                ServerCardSkeleton()
            }
        }
        FSGhostButton(label = "Refresh", onClick = { vm.load() })
    }
}

@Composable
private fun Body(s: PeerBackupStatusResponse) {
    if (s.v != 2) {
        PlaceholderCard(PeerBackup.OLDER_ENGINE)
        return
    }
    val state = s.state.orEmpty()
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.semantics { testTag = "peer-backup-state-$state" }) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    PeerBackup.stateTitle(state),
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.semantics { testTag = "peer-backup-state-title" },
                )
                Spacer(Modifier.width(FS.space.s2))
                FSPill(label = state, kind = pillKind(state))
            }
            Text(PeerBackup.stateNote(state), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            s.reason?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            val total = s.totalBricks ?: 0
            if (total > 0) LabelValueRow("pieces safe", "${s.healthyBricks ?: 0} of $total")
            s.lastPlacedAt?.takeIf { it > 0 }?.let { LabelValueRow("last placed", fmtDate(it)) }
            PeerBackup.restoreByLine(s.keepUntil).takeIf { it.isNotEmpty() }?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { testTag = "peer-backup-restore-by" })
            }
        }
    }

    FSSectionHeader("Servers holding your pieces")
    val rows = PeerBackup.holderRows(s)
    if (rows.isEmpty()) {
        PlaceholderCard("None yet. Pieces are placed once your newest backup is ready and enough other servers can hold it.")
    } else {
        rows.forEach { r ->
            FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.semantics { testTag = "peer-backup-holder" }) {
                Column {
                    Text(r.label, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                    Text(r.line, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    val host = PeerBackup.hostingLines(s)
    if (host.isNotEmpty()) {
        FSSectionHeader("Kept for other servers")
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.semantics { testTag = "peer-backup-hosting" }) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                host.forEach { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
                s.hosting?.reliability?.let {
                    Text("Reliability score: $it of 100", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

private fun pillKind(state: String): FSPillKind = when (state) {
    "protected" -> FSPillKind.Online
    "at-risk" -> FSPillKind.Offline
    "waiting-for-peers", "filling", "placing", "leaving" -> FSPillKind.Renewing
    else -> FSPillKind.Idle
}

@Composable
private fun PlaceholderCard(text: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun LabelValueRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.weight(1f))
        Text(value, color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
    }
}

private fun fmtDate(ms: Long): String = if (ms <= 0L) "—" else FlagshipDateFormat.format(ms, includeTime = true)
