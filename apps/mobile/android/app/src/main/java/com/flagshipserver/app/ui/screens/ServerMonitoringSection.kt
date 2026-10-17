// The server page's Monitoring pane: one card, one borderless row per item
// (icon + name | value), each expanding in place to show its detail. Rows,
// order and values match iOS (MonitoringPane.swift) and the webapp: Health,
// CPU, Memory, Disk, Network, Certificate.

package com.flagshipserver.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeveloperBoard
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.BoxHealthWire
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.ServerHealthVerdict
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoadingState

/** What the Certificate row knows. */
internal data class MonitoringCert(
    val notAfter: Long?,
    val notBefore: Long? = null,
    val issuer: String? = null,
    val sans: List<String> = emptyList(),
)

internal enum class MonitoringKey(val title: String) {
    HEALTH("Health"), CPU("CPU"), MEMORY("Memory"), DISK("Disk"), NETWORK("Network"), CERTIFICATE("Certificate"),
}

internal enum class MonitoringTone { NORMAL, WARNING, DANGER }

/** One row's collapsed state: [value] null while it is still loading. */
internal data class MonitoringRow(
    val key: MonitoringKey,
    val value: String?,
    val tone: MonitoringTone = MonitoringTone.NORMAL,
)

internal object MonitoringRows {
    private const val STALE_AFTER_MS = ServerHealthVerdict.STALE_AFTER_MIN * 60_000L

    /** Rows in display order. [metrics] null leaves out the four metric rows
     *  (the box's detail never loaded); [cert] null leaves out Certificate;
     *  a [health] without a usable report leaves out Health. */
    fun build(
        health: BoxHealthWire?,
        metrics: LoadingState<ServerMetricsResponse>?,
        cert: MonitoringCert?,
        nowMs: Long,
    ): List<MonitoringRow> = buildList {
        ServerHealthVerdict.evaluate(health, nowMs)?.let { v ->
            val stale = nowMs - (health?.receivedAt ?: nowMs) >= STALE_AFTER_MS
            add(
                MonitoringRow(
                    MonitoringKey.HEALTH,
                    if (v.ok) "Healthy" else if (stale) "No report" else "Needs attention",
                    if (v.ok) MonitoringTone.NORMAL else MonitoringTone.WARNING,
                ),
            )
        }
        if (metrics != null) {
            val m = (metrics as? LoadingState.Loaded)?.value
            val failed = metrics is LoadingState.Failed
            fun value(f: (ServerMetricsResponse) -> String): String? = m?.let(f) ?: if (failed) "Unavailable" else null
            add(MonitoringRow(MonitoringKey.CPU, value { "%.0f%%".format(it.cpuPercent) }))
            add(MonitoringRow(MonitoringKey.MEMORY, value { "${formatBytes(it.memUsedBytes)} of ${formatBytes(it.memTotalBytes)}" }))
            val disk = m?.let { percent(it.diskUsedBytes, it.diskTotalBytes) } ?: 0.0
            add(
                MonitoringRow(
                    MonitoringKey.DISK,
                    value { "%.0f%% used".format(disk * 100) },
                    when {
                        disk > 0.9 -> MonitoringTone.DANGER
                        disk > 0.75 -> MonitoringTone.WARNING
                        else -> MonitoringTone.NORMAL
                    },
                ),
            )
            add(MonitoringRow(MonitoringKey.NETWORK, value { "↓ ${formatRate(it.netRxBytesPerSec)}  ↑ ${formatRate(it.netTxBytesPerSec)}" }))
        }
        if (cert != null) {
            val after = cert.notAfter
            add(
                when {
                    after == null -> MonitoringRow(MonitoringKey.CERTIFICATE, "Provisioning")
                    after <= nowMs -> MonitoringRow(MonitoringKey.CERTIFICATE, "Expired", MonitoringTone.DANGER)
                    else -> MonitoringRow(MonitoringKey.CERTIFICATE, "Valid until ${FlagshipDateFormat.format(after, nowMs = nowMs)}")
                },
            )
        }
    }

    fun percent(used: Long, total: Long): Double =
        if (total <= 0) 0.0 else (used.toDouble() / total).coerceIn(0.0, 1.0)

    fun formatBytes(bytes: Long): String {
        val kb = 1024.0
        val mb = kb * 1024
        val gb = mb * 1024
        val b = bytes.toDouble()
        return when {
            b >= gb -> "%.1f GB".format(b / gb)
            b >= mb -> "%.0f MB".format(b / mb)
            b >= kb -> "%.0f KB".format(b / kb)
            else -> "$bytes B"
        }
    }

    fun formatRate(bytesPerSec: Double): String {
        val kb = 1024.0
        val mb = kb * 1024
        return when {
            bytesPerSec >= mb -> "%.1f MB/s".format(bytesPerSec / mb)
            bytesPerSec >= kb -> "%.0f KB/s".format(bytesPerSec / kb)
            else -> "%.0f B/s".format(bytesPerSec)
        }
    }
}

/**
 * ONE grouped pane for everything the page monitors. Renders nothing when it
 * has no rows (no health report and no box detail).
 */
@Composable
internal fun MonitoringSection(
    health: BoxHealthWire?,
    metrics: LoadingState<ServerMetricsResponse>?,
    cert: MonitoringCert?,
    onRetryMetrics: (() -> Unit)? = null,
) {
    // Re-read every 30 s so a health report that stops arriving turns into
    // "No report".
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    val rows = MonitoringRows.build(health, metrics, cert, now)
    if (rows.isEmpty()) return
    // A box reporting a problem opens with that problem showing, as the old
    // standalone health card did.
    val healthProblemAtStart = remember { ServerHealthVerdict.evaluate(health, now)?.ok == false }

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
        FSSectionHeader("Monitoring", modifier = Modifier.semantics { heading() })
        FSCard(padding = PaddingValues(vertical = FS.space.s1), modifier = Modifier.testTag("monitoring-pane")) {
            rows.forEachIndexed { i, row ->
                if (i > 0) FSDivider(inset = FS.space.s4 + 22.dp + FS.space.s3)
                MonitorRow(row, startExpanded = row.key == MonitoringKey.HEALTH && healthProblemAtStart) {
                    when (row.key) {
                        MonitoringKey.HEALTH -> ServerHealthVerdict.evaluate(health, now)?.lines?.forEach { line ->
                            Text(line, color = MaterialTheme.colorScheme.onSurface, style = noteStyle)
                        }
                        MonitoringKey.CERTIFICATE -> CertDetail(cert, now)
                        else -> when (metrics) {
                            is LoadingState.Loaded -> MetricDetail(row.key, metrics.value)
                            is LoadingState.Failed -> {
                                Text(metrics.message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = noteStyle)
                                onRetryMetrics?.let { FSSecondaryButton(label = "Retry", onClick = it) }
                            }
                            else -> Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = noteStyle)
                        }
                    }
                }
            }
        }
    }
}

private val noteStyle: TextStyle
    @Composable get() = MaterialTheme.typography.bodyMedium
private val captionStyle: TextStyle
    @Composable get() = MaterialTheme.typography.bodySmall

@Composable
private fun toneColor(tone: MonitoringTone): Color = when (tone) {
    MonitoringTone.NORMAL -> MaterialTheme.colorScheme.onSurfaceVariant
    MonitoringTone.WARNING -> FS.colors.warning
    MonitoringTone.DANGER -> FS.colors.danger
}

private fun iconFor(row: MonitoringRow): ImageVector = when (row.key) {
    MonitoringKey.HEALTH -> if (row.tone == MonitoringTone.NORMAL) Icons.Outlined.MonitorHeart else Icons.Outlined.Warning
    MonitoringKey.CPU -> Icons.Outlined.DeveloperBoard
    MonitoringKey.MEMORY -> Icons.Outlined.Memory
    MonitoringKey.DISK -> Icons.Outlined.Storage
    MonitoringKey.NETWORK -> Icons.Outlined.SwapVert
    MonitoringKey.CERTIFICATE -> Icons.Outlined.Security
}

/** One row: icon + name on the left, the value on the right. A tap toggles the
 *  detail in place; screen readers hear name, value and expanded state. */
@Composable
private fun MonitorRow(row: MonitoringRow, startExpanded: Boolean, detail: @Composable () -> Unit) {
    val tag = row.key.name.lowercase()
    var expanded by rememberSaveable(tag) { mutableStateOf(startExpanded) }
    val color = toneColor(row.tone)
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(FS.radius.sm))
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide the details" else "Show the details") {
                    expanded = !expanded
                }
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                .heightIn(min = 48.dp)
                .padding(horizontal = FS.space.s4, vertical = FS.space.s3)
                .testTag("monitor-$tag"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Icon(
                iconFor(row),
                contentDescription = null,
                tint = if (row.tone == MonitoringTone.NORMAL) FS.colors.primary else color,
                modifier = Modifier.size(22.dp),
            )
            Text(
                row.key.title,
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
            if (row.value != null) {
                Text(
                    row.value,
                    color = color,
                    style = MaterialTheme.typography.bodyMedium.copy(textAlign = TextAlign.End, fontFeatureSettings = "tnum"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            } else {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp).semantics { stateDescription = "Loading" },
                    strokeWidth = 2.dp,
                )
            }
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = FS.space.s4 + 22.dp + FS.space.s3, end = FS.space.s4, bottom = FS.space.s4)
                    .testTag("monitor-$tag-detail"),
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
            ) { detail() }
        }
    }
}

@Composable
private fun MetricDetail(key: MonitoringKey, m: ServerMetricsResponse) {
    when (key) {
        MonitoringKey.CPU -> {
            MetricLineChart(m.cpuHistory.map { it.value })
            Text("Load %.2f · %.2f · %.2f".format(m.loadAvg1, m.loadAvg5, m.loadAvg15), color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
        }
        MonitoringKey.MEMORY -> {
            MetricLineChart(m.memHistory.map { it.value })
            Text(
                "%.0f%% in use".format(MonitoringRows.percent(m.memUsedBytes, m.memTotalBytes) * 100),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = captionStyle,
            )
        }
        MonitoringKey.DISK -> {
            val pct = MonitoringRows.percent(m.diskUsedBytes, m.diskTotalBytes)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                DiskRing(pct)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    InlinePair("Used", MonitoringRows.formatBytes(m.diskUsedBytes))
                    InlinePair("Free", MonitoringRows.formatBytes((m.diskTotalBytes - m.diskUsedBytes).coerceAtLeast(0)))
                    InlinePair("Total", MonitoringRows.formatBytes(m.diskTotalBytes))
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                Rate("Read", m.diskIOReadBytesPerSec, FS.colors.primary, Modifier.weight(1f))
                Rate("Write", m.diskIOWriteBytesPerSec, FS.colors.warning, Modifier.weight(1f))
            }
        }
        MonitoringKey.NETWORK -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                Rate("In", m.netRxBytesPerSec, FS.colors.success, Modifier.weight(1f))
                Rate("Out", m.netTxBytesPerSec, FS.colors.danger, Modifier.weight(1f))
            }
            MetricDualLineChart(a = m.netHistory.map { it.read }, b = m.netHistory.map { it.write })
        }
        MonitoringKey.HEALTH, MonitoringKey.CERTIFICATE -> Unit
    }
}

@Composable
private fun CertDetail(cert: MonitoringCert?, now: Long) {
    val after = cert?.notAfter
    if (after == null) {
        Text("No certificate yet. The server is getting one.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = noteStyle)
        return
    }
    Labeled("Renews", FlagshipDateFormat.format(after, nowMs = now))
    cert.notBefore?.let { Labeled("Issued", FlagshipDateFormat.format(it, nowMs = now)) }
    cert.issuer?.takeIf { it.isNotEmpty() }?.let { Labeled("Issuer", it) }
    if (cert.sans.isNotEmpty()) {
        Text("Names covered", color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle, modifier = Modifier.padding(top = FS.space.s1))
        cert.sans.forEach { san ->
            Text(san, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
        }
    }
}

@Composable
private fun Labeled(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle, modifier = Modifier.weight(1f))
        Text(value, color = MaterialTheme.colorScheme.onSurface, style = noteStyle, textAlign = TextAlign.End)
    }
}

@Composable
private fun InlinePair(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
        Text(value, color = MaterialTheme.colorScheme.onSurface, style = noteStyle)
    }
}

@Composable
private fun Rate(label: String, bytesPerSec: Double, color: Color, modifier: Modifier = Modifier) {
    Column(modifier.semantics(mergeDescendants = true) {}) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(color))
            Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
        }
        Text(
            MonitoringRows.formatRate(bytesPerSec),
            color = FS.colors.text,
            style = MaterialTheme.typography.titleSmall,
        )
    }
}

@Composable
private fun DiskRing(pct: Double) {
    val track = FS.colors.surfaceSunken
    val fill = when {
        pct > 0.9 -> FS.colors.danger
        pct > 0.75 -> FS.colors.warning
        else -> FS.colors.primary
    }
    Box(Modifier.size(72.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(72.dp)) {
            val stroke = 8.dp.toPx()
            val inset = stroke / 2
            val arcSize = Size(size.width - stroke, size.height - stroke)
            drawArc(track, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
            drawArc(fill, -90f, (pct * 360).toFloat(), false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
        }
        Text("%.0f%%".format(pct * 100), color = FS.colors.text, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun MetricLineChart(values: List<Double>) {
    if (values.isEmpty()) return
    val entries = values.mapIndexed { i, v ->
        com.patrykandpatrick.vico.core.entry.entryOf(i.toFloat(), v.toFloat())
    }
    val producer = remember(values) {
        com.patrykandpatrick.vico.core.entry.ChartEntryModelProducer(entries)
    }
    com.patrykandpatrick.vico.compose.chart.Chart(
        chart = com.patrykandpatrick.vico.compose.chart.line.lineChart(),
        chartModelProducer = producer,
        modifier = Modifier
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
    val producer = remember(a, b) {
        com.patrykandpatrick.vico.core.entry.ChartEntryModelProducer(entriesA, entriesB)
    }
    com.patrykandpatrick.vico.compose.chart.Chart(
        chart = com.patrykandpatrick.vico.compose.chart.line.lineChart(),
        chartModelProducer = producer,
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp),
    )
}
