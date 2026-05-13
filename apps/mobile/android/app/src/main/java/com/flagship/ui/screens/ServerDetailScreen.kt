// Drill-down view for one pod. Shows daemon version, cert expiry,
// recent install events, paired sessions, and a metrics charts strip.
// Lighter than iOS — Compose tooling for line charts is heavier, so we
// summarize the metrics as last-sample numbers + a status line until
// MPAndroidChart (or Vico) is wired up.

package com.flagship.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagship.api.ServerMetricsResponse
import com.flagship.core.LocalScreensClient
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.theme.FS
import com.flagship.viewmodels.HomeViewModel
import com.flagship.viewmodels.LoadingState
import com.flagship.viewmodels.ServerMetricsViewModel
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

        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ServerInfoCard(detail: com.flagship.api.ServerDetailResponse) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                detail.serverFqdn,
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSPill("Daemon ${detail.daemonVersion}", kind = FSPillKind.Idle)
                FSPill("${detail.appCount} apps", kind = FSPillKind.Idle)
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
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "CPU ${"%.1f".format(metrics.cpuPercent)}%",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "Mem ${humanBytes(metrics.memUsedBytes)} / ${humanBytes(metrics.memTotalBytes)}",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp),
            )
            Text(
                "Disk ${humanBytes(metrics.diskUsedBytes)} / ${humanBytes(metrics.diskTotalBytes)}",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp),
            )
            Text(
                "Net ↓ ${humanBytes(metrics.netRxBytesPerSec.toLong())}/s · ↑ ${humanBytes(metrics.netTxBytesPerSec.toLong())}/s",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
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
