// Drill-down view for one pod. Shows daemon version, cert expiry,
// recent install events, paired sessions, and a metrics charts strip.
// Lighter than iOS — Compose tooling for line charts is heavier, so we
// summarize the metrics as last-sample numbers + a status line until
// MPAndroidChart (or Vico) is wired up.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.SecretRequestCoordinator
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import com.flagshipserver.app.viewmodels.HomeViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.ServerMetricsViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun ServerDetailScreen(podId: String, onBack: () -> Unit) {
    val client = LocalScreensClient.current
    val detailVm = remember(podId) { HomeViewModel(client) }
    val metricsVm = remember(podId) { ServerMetricsViewModel(podId = podId, client = client) }
    val detail by detailVm.state.collectAsState()
    val metrics by metricsVm.state.collectAsState()

    LaunchedEffect(podId) {
        detailVm.load()
        metricsVm.load()
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = onBack)
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Server detail",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )

        Spacer(Modifier.height(FS.space.s6))

        when (val d = detail) {
            is LoadingState.Loaded -> ServerInfoCard(d.value)
            is LoadingState.Failed -> ErrorCard(d.message, onRetry = { detailVm.load() })
            else -> ServerCardSkeleton()
        }

        Spacer(Modifier.height(FS.space.s6))
        Text(
            "Live metrics",
            color = FS.colors.text,
            style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s2))
        when (val m = metrics) {
            is LoadingState.Loaded -> MetricsSection(m.value)
            is LoadingState.Failed -> ErrorCard(m.message, onRetry = { metricsVm.load() })
            else -> ServerCardSkeleton()
        }

        (detail as? LoadingState.Loaded)?.let { d ->
            Spacer(Modifier.height(FS.space.s6))
            BootUnlockCard(serverDomain = d.value.serverFqdn)
        }

        Spacer(Modifier.height(FS.space.s12))
    }
}

// Boot-unlock status + kill switch for one server. Reads the per-server choice
// + lease from ServerSettingsStore and, for an "auto" server with a deposited
// lease, offers the revoke (downgrade to phone-gated, not a brick). Mirror of
// iOS ServerDetailScreen.BootUnlockCard.
@Composable
private fun BootUnlockCard(serverDomain: String) {
    val mailbox = LocalSecretMailboxClient.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()
    val store = remember { ServerSettingsStore.from(context) }

    val mode = remember(serverDomain) { store.effectiveMode(serverDomain) }
    var leaseId by remember(serverDomain) { mutableStateOf(store.leaseId(serverDomain)) }
    var revoking by remember { mutableStateOf(false) }

    Text(
        "Boot unlock",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            when (mode) {
                ServerSettingsStore.Mode.AUTO -> {
                    Text(
                        "Reboots on its own",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                    )
                    if (leaseId != null) {
                        Text(
                            "This box self-unlocks its encrypted disk after a reboot — no phone needed. flagshipserver.com only ever holds a key it can't read.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        )
                        FSDangerButton(
                            label = if (revoking) "Disabling…" else "Require my phone each boot",
                            onClick = onClick@{
                                val id = leaseId ?: return@onClick
                                val user = username ?: return@onClick
                                revoking = true
                                scope.launch {
                                    try {
                                        val coord = SecretRequestCoordinator(
                                            mailbox = mailbox,
                                            username = user,
                                            irk = KeystoreIrkAccess(),
                                        )
                                        coord.revokeAutoUnlockLease(serverDomain, id)
                                        store.setLeaseId(serverDomain, null)
                                        leaseId = null
                                        toasts.success("Auto-unlock disabled. This box will ask your phone on its next reboot.")
                                    } catch (t: Throwable) {
                                        toasts.error("Couldn't disable auto-unlock: ${t.message}")
                                    } finally {
                                        revoking = false
                                    }
                                }
                            },
                            enabled = !revoking,
                            block = true,
                        )
                    } else {
                        Text(
                            "After you approve its first boot, this box will self-unlock on future reboots. Nothing to do until then.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        )
                    }
                }
                ServerSettingsStore.Mode.APPROVE -> {
                    Text(
                        "Authorize each boot",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                    )
                    Text(
                        "This box asks your phone for approval on every reboot — the most theft-resistant mode.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ServerInfoCard(detail: com.flagshipserver.app.api.ServerDetailResponse) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                detail.serverFqdn,
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPill("Daemon ${detail.daemonVersion}", kind = FSPillKind.Idle)
                FSPill("${detail.serviceCount} apps", kind = FSPillKind.Idle)
                FSPill("${detail.pairedSessionCount} devices", kind = FSPillKind.Idle)
            }
            val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
            val certText = detail.certNotAfter
                ?.let { "Cert valid until ${fmt.format(Date(it))}" }
                ?: "Cert details unavailable"
            Text(certText, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
        }
    }
}

@Composable
fun MetricsSection(metrics: ServerMetricsResponse) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        MetricCard(
            title = "CPU ${"%.1f".format(metrics.cpuPercent)}%",
            chart = { MetricLineChart(metrics.cpuHistory.map { it.value }) },
        )
        MetricCard(
            title = "Mem ${humanBytes(metrics.memUsedBytes)} / ${humanBytes(metrics.memTotalBytes)}",
            chart = { MetricLineChart(metrics.memHistory.map { it.value }) },
        )
        MetricCard(
            title = "Disk I/O ↓ ${humanBytes(metrics.diskIOReadBytesPerSec.toLong())}/s · ↑ ${humanBytes(metrics.diskIOWriteBytesPerSec.toLong())}/s",
            chart = {
                MetricDualLineChart(
                    a = metrics.ioHistory.map { it.read },
                    b = metrics.ioHistory.map { it.write },
                )
            },
        )
        MetricCard(
            title = "Net ↓ ${humanBytes(metrics.netRxBytesPerSec.toLong())}/s · ↑ ${humanBytes(metrics.netTxBytesPerSec.toLong())}/s",
            chart = {
                MetricDualLineChart(
                    a = metrics.netHistory.map { it.read },
                    b = metrics.netHistory.map { it.write },
                )
            },
        )
        Text(
            "Disk ${humanBytes(metrics.diskUsedBytes)} / ${humanBytes(metrics.diskTotalBytes)}",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
    }
}

@Composable
private fun MetricCard(title: String, chart: @Composable () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                title,
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
            )
            chart()
        }
    }
}

@Composable
private fun MetricLineChart(values: List<Double>) {
    if (values.isEmpty()) return
    val entries = values.mapIndexed { i, v ->
        com.patrykandpatrick.vico.core.entry.entryOf(i.toFloat(), v.toFloat())
    }
    val producer = androidx.compose.runtime.remember(values) {
        com.patrykandpatrick.vico.core.entry.ChartEntryModelProducer(entries)
    }
    com.patrykandpatrick.vico.compose.chart.Chart(
        chart = com.patrykandpatrick.vico.compose.chart.line.lineChart(),
        chartModelProducer = producer,
        modifier = androidx.compose.ui.Modifier
            .fillMaxWidth()
            .height(96.dp),
    )
}

@Composable
private fun MetricDualLineChart(a: List<Double>, b: List<Double>) {
    if (a.isEmpty() || b.isEmpty()) return
    val entriesA = a.mapIndexed { i, v ->
        com.patrykandpatrick.vico.core.entry.entryOf(i.toFloat(), v.toFloat())
    }
    val entriesB = b.mapIndexed { i, v ->
        com.patrykandpatrick.vico.core.entry.entryOf(i.toFloat(), v.toFloat())
    }
    val producer = androidx.compose.runtime.remember(a, b) {
        com.patrykandpatrick.vico.core.entry.ChartEntryModelProducer(entriesA, entriesB)
    }
    com.patrykandpatrick.vico.compose.chart.Chart(
        chart = com.patrykandpatrick.vico.compose.chart.line.lineChart(),
        chartModelProducer = producer,
        modifier = androidx.compose.ui.Modifier
            .fillMaxWidth()
            .height(96.dp),
    )
}

private fun humanBytes(bytes: Long): String {
    val k = 1024.0
    if (bytes < k) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = bytes / k
    var i = 0
    while (v >= k && i < units.lastIndex) { v /= k; i++ }
    return "%.1f %s".format(v, units[i])
}
