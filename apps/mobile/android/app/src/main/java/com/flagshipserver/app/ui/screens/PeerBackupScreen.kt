// P9 — peer-backup management screen.
//
// Mirrors the canonical webapp `views/peer-backup.js` + iOS
// FlagshipUI/Screens/PeerBackupScreen.swift 1:1:
//
//   - participation toggle (Switch)
//   - peers backing you up list
//   - peers you back up list
//   - stats row (total / durable / at-risk / your bytes / peer bytes)
//   - repair status (state / last tick / queued / completed24h / lastError)

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.PeerBackupPeerHostingYou
import com.flagshipserver.app.api.PeerBackupPeerYouHost
import com.flagshipserver.app.api.PeerBackupRepairStatus
import com.flagshipserver.app.api.PeerBackupShardSummary
import com.flagshipserver.app.api.PeerBackupStats
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.plural
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.PeerBackupViewModel
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Locale

@Composable
fun PeerBackupScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val vm = remember { PeerBackupViewModel(client) }
    val state by vm.state.collectAsState()
    val togglePending by vm.togglePending.collectAsState()

    LaunchedEffect(Unit) { vm.load() }

    FSScreen(
        title = "Peer-backup",
        onBack = { nav.popBackStack() },
        subtitle = "Shard health across peers, and repair status.",
        onRefresh = { vm.load() },
    ) {
        when (val s = state) {
            is LoadingState.Loaded -> Body(s.value, togglePending = togglePending, onToggle = { vm.toggle() })
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                ServerCardSkeleton()
            }
        }
    }
}

@Composable
private fun Body(s: PeerBackupStatusResponse, togglePending: Boolean, onToggle: () -> Unit) {
    ParticipationCard(s, togglePending = togglePending, onToggle = onToggle)

    FSGroup(header = "Shard health") {
        StatsRows(s.stats)
    }

    if (s.peersBackingYouUp.isEmpty()) {
        PeerSection("Peers backing you up") {
            FSNote("No peers backing you up yet — your server will recruit some soon.")
        }
    } else {
        FSGroup(header = "Peers backing you up") {
            s.peersBackingYouUp.forEachIndexed { idx, p ->
                PeerHostingYouRow(p)
                if (idx < s.peersBackingYouUp.size - 1) FSDivider(inset = FS.space.s4)
            }
        }
    }

    if (s.peersYouBackUp.isEmpty()) {
        PeerSection("Peers you back up") {
            FSNote("Not hosting any peer shards yet — nobody has been paired with you yet.")
        }
    } else {
        FSGroup(header = "Peers you back up") {
            s.peersYouBackUp.forEachIndexed { idx, p ->
                PeerYouHostRow(p)
                if (idx < s.peersYouBackUp.size - 1) FSDivider(inset = FS.space.s4)
            }
        }
    }

    if (s.shards.isNotEmpty()) {
        PeerSection("Your shards") {
            val shown = s.shards.take(20)
            FSGroup {
                shown.forEachIndexed { idx, sh ->
                    ShardRow(sh)
                    if (idx < shown.size - 1) FSDivider(inset = FS.space.s4)
                }
            }
            if (s.shards.size > 20) {
                FSNote("${plural(s.shards.size - 20, "more shard", "more shards")} not shown")
            }
        }
    }

    FSGroup(header = "Repair status") {
        RepairRows(s.repair)
    }
}

@Composable
private fun PeerSection(header: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(header)
        content()
    }
}

@Composable
private fun ParticipationCard(s: PeerBackupStatusResponse, togglePending: Boolean, onToggle: () -> Unit) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text("Peer-backup pool", style = MaterialTheme.typography.titleMedium)
                FSPill(
                    label = if (s.participating) "Participating" else "Not enrolled",
                    kind = if (s.participating) FSPillKind.Online else FSPillKind.Idle,
                    modifier = Modifier.semantics { testTag = "peer-backup-participation-pill" },
                )
            }
            Text(
                if (s.participating)
                    "You host shards for peers and they host yours. Opt out to leave the pool."
                else
                    "You're not in the peer-backup pool — turn it on to get started.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .semantics { testTag = "peer-backup-toggle" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (s.participating) "Participating" else "Off",
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = s.participating,
                    enabled = !togglePending,
                    onCheckedChange = { onToggle() },
                )
            }
        }
    }
}

@Composable
private fun StatsRows(stats: PeerBackupStats) {
    LabelValueRow("Total shards", stats.total.toString())
    FSDivider(inset = FS.space.s4)
    LabelValueRow("Durable", stats.durable.toString())
    FSDivider(inset = FS.space.s4)
    LabelValueRow("At risk", stats.atRisk.toString())
    FSDivider(inset = FS.space.s4)
    LabelValueRow("Your bytes stored", fmtBytes(stats.yourBytesStored))
    FSDivider(inset = FS.space.s4)
    LabelValueRow("Peer bytes hosted", fmtBytes(stats.peerBytesHosted))
}

@Composable
private fun PeerHostingYouRow(p: PeerBackupPeerHostingYou) {
    FSRow(
        title = p.peerFqdn,
        subtitle = "${plural(p.shardsHosted, "shard")} · last seen ${fmtDate(p.lastSeenMs)}",
        trailing = {
            FSPill(
                label = if (p.online) "Online" else "Offline",
                kind = if (p.online) FSPillKind.Online else FSPillKind.Offline,
            )
        },
    )
}

@Composable
private fun PeerYouHostRow(p: PeerBackupPeerYouHost) {
    FSRow(
        title = p.peerFqdn,
        subtitle = "hosting ${plural(p.shardsHosted, "shard")} · ${fmtBytes(p.bytesHosted)} · last fetched ${fmtDate(p.lastFetchedMs)}",
    )
}

@Composable
private fun ShardRow(s: PeerBackupShardSummary) {
    ListItem(
        headlineContent = {
            Text(
                s.shardId,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        supportingContent = {
            Text(
                "${s.replicas}/${s.minReplicas} replicas · ${fmtBytes(s.bytes)}",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        },
        trailingContent = { FSPill(label = shardPillLabel(s), kind = shardPillKind(s)) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}

@Composable
private fun RepairRows(repair: PeerBackupRepairStatus) {
    LabelValueRow("State", repair.state)
    FSDivider(inset = FS.space.s4)
    LabelValueRow("Last tick", repair.lastTickMs?.let(::fmtDate) ?: "—")
    FSDivider(inset = FS.space.s4)
    LabelValueRow("Repairs queued", repair.queued.toString())
    FSDivider(inset = FS.space.s4)
    LabelValueRow("Repairs done (24h)", repair.completed24h.toString())
    val err = repair.lastError
    if (!err.isNullOrEmpty()) {
        FSDivider(inset = FS.space.s4)
        LabelValueRow("Last error", err, valueColor = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun LabelValueRow(label: String, value: String, valueColor: Color? = null) {
    FSRow(
        title = label,
        trailing = {
            Text(
                value,
                color = valueColor ?: MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        },
    )
}

private fun shardPillLabel(s: PeerBackupShardSummary): String = when {
    s.replicas >= s.minReplicas * 2 -> "Redundant"
    s.replicas >= s.minReplicas -> "Durable"
    s.replicas > 0 -> "At risk"
    else -> "Lost"
}

private fun shardPillKind(s: PeerBackupShardSummary): FSPillKind = when {
    s.replicas >= s.minReplicas -> FSPillKind.Online
    s.replicas > 0 -> FSPillKind.Renewing
    else -> FSPillKind.Offline
}

private fun fmtDate(ms: Long): String {
    if (ms <= 0L) return "—"
    return FlagshipDateFormat.format(ms, includeTime = true)
}

private fun fmtBytes(n: Long): String {
    if (n <= 0L) return "0 B"
    val d = n.toDouble()
    return when {
        d < 1024 -> "$n B"
        d < 1024.0 * 1024 -> String.format(Locale.US, "%.1f KiB", d / 1024)
        d < 1024.0 * 1024 * 1024 -> String.format(Locale.US, "%.1f MiB", d / 1024 / 1024)
        else -> String.format(Locale.US, "%.2f GiB", d / 1024 / 1024 / 1024)
    }
}
