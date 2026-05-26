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
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.PeerBackupViewModel
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
fun PeerBackupScreen(@Suppress("UNUSED_PARAMETER") nav: NavController) {
    val client = LocalScreensClient.current
    val vm = remember { PeerBackupViewModel(client) }
    val state by vm.state.collectAsState()
    val togglePending by vm.togglePending.collectAsState()

    LaunchedEffect(Unit) { vm.load() }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Peer-backup",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Shard health across peers + the repair daemon's view.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        when (val s = state) {
            is LoadingState.Loaded -> Body(s.value, togglePending = togglePending, onToggle = { vm.toggle() })
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                Spacer(Modifier.height(FS.space.s2))
                ServerCardSkeleton()
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun Body(s: PeerBackupStatusResponse, togglePending: Boolean, onToggle: () -> Unit) {
    ParticipationCard(s, togglePending = togglePending, onToggle = onToggle)
    Spacer(Modifier.height(FS.space.s4))

    SectionHeader("Shard health")
    Spacer(Modifier.height(FS.space.s2))
    StatsCard(s.stats)

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("Peers backing you up")
    Spacer(Modifier.height(FS.space.s2))
    if (s.peersBackingYouUp.isEmpty()) {
        PlaceholderCard("No peers backing you up yet — repair daemon will recruit some next tick.")
    } else {
        s.peersBackingYouUp.forEach { p ->
            PeerHostingYouRow(p)
            Spacer(Modifier.height(FS.space.s2))
        }
    }

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("Peers you back up")
    Spacer(Modifier.height(FS.space.s2))
    if (s.peersYouBackUp.isEmpty()) {
        PlaceholderCard("Not hosting any peer shards yet — matchmaker hasn't paired you with anyone yet.")
    } else {
        s.peersYouBackUp.forEach { p ->
            PeerYouHostRow(p)
            Spacer(Modifier.height(FS.space.s2))
        }
    }

    if (s.shards.isNotEmpty()) {
        Spacer(Modifier.height(FS.space.s4))
        SectionHeader("Your shards")
        Spacer(Modifier.height(FS.space.s2))
        s.shards.take(20).forEach { sh ->
            ShardRow(sh)
            Spacer(Modifier.height(FS.space.s2))
        }
        if (s.shards.size > 20) {
            PlaceholderCard("+ ${s.shards.size - 20} more shards (not rendered)")
        }
    }

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("Repair status")
    Spacer(Modifier.height(FS.space.s2))
    RepairCard(s.repair)
}

@Composable
private fun ParticipationCard(s: PeerBackupStatusResponse, togglePending: Boolean, onToggle: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Peer-backup pool",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                Spacer(Modifier.width(FS.space.s2))
                FSPill(
                    label = if (s.participating) "participating" else "unenrolled",
                    kind = if (s.participating) FSPillKind.Online else FSPillKind.Idle,
                    modifier = Modifier.semantics { testTag = "peer-backup-participation-pill" },
                )
            }
            Text(
                if (s.participating)
                    "You host shards for peers and they host yours. Opt out to leave the pool."
                else
                    "You're not in the peer-backup pool — enable to get started.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { testTag = "peer-backup-toggle" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (s.participating) "Participating" else "Off",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp))
                Spacer(Modifier.weight(1f))
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
private fun StatsCard(stats: PeerBackupStats) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            LabelValueRow("total shards", stats.total.toString())
            LabelValueRow("durable", stats.durable.toString())
            LabelValueRow("at risk", stats.atRisk.toString())
            LabelValueRow("your bytes stored", fmtBytes(stats.yourBytesStored))
            LabelValueRow("peer bytes hosted", fmtBytes(stats.peerBytesHosted))
        }
    }
}

@Composable
private fun PeerHostingYouRow(p: PeerBackupPeerHostingYou) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(p.peerFqdn,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
                Text(
                    "${p.shardsHosted} shard${if (p.shardsHosted == 1) "" else "s"} · last seen ${fmtDate(p.lastSeenMs)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
            FSPill(
                label = if (p.online) "online" else "offline",
                kind = if (p.online) FSPillKind.Online else FSPillKind.Offline,
            )
        }
    }
}

@Composable
private fun PeerYouHostRow(p: PeerBackupPeerYouHost) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            Text(p.peerFqdn,
                color = FS.colors.text,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
            Text(
                "hosting ${p.shardsHosted} shard${if (p.shardsHosted == 1) "" else "s"} · ${fmtBytes(p.bytesHosted)} · last fetched ${fmtDate(p.lastFetchedMs)}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
}

@Composable
private fun ShardRow(s: PeerBackupShardSummary) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    s.shardId,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${s.replicas}/${s.minReplicas} replicas · ${fmtBytes(s.bytes)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
            FSPill(label = shardPillLabel(s), kind = shardPillKind(s))
        }
    }
}

@Composable
private fun RepairCard(repair: PeerBackupRepairStatus) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            LabelValueRow("state", repair.state)
            LabelValueRow("last tick", repair.lastTickMs?.let(::fmtDate) ?: "—")
            LabelValueRow("repairs queued", repair.queued.toString())
            LabelValueRow("repairs done (24h)", repair.completed24h.toString())
            val err = repair.lastError
            if (!err.isNullOrEmpty()) {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("last error", color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
                    Spacer(Modifier.weight(1f))
                    Text(err, color = FS.colors.danger, style = TextStyle(fontSize = 14.sp))
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(title, color = FS.colors.text, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
}

@Composable
private fun PlaceholderCard(text: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
    }
}

@Composable
private fun LabelValueRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
        Spacer(Modifier.weight(1f))
        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
    }
}

private fun shardPillLabel(s: PeerBackupShardSummary): String = when {
    s.replicas >= s.minReplicas * 2 -> "redundant"
    s.replicas >= s.minReplicas -> "durable"
    s.replicas > 0 -> "at risk"
    else -> "lost"
}

private fun shardPillKind(s: PeerBackupShardSummary): FSPillKind = when {
    s.replicas >= s.minReplicas -> FSPillKind.Online
    s.replicas > 0 -> FSPillKind.Renewing
    else -> FSPillKind.Offline
}

private fun fmtDate(ms: Long): String {
    if (ms <= 0L) return "—"
    val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.US)
    return fmt.format(Date(ms))
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
