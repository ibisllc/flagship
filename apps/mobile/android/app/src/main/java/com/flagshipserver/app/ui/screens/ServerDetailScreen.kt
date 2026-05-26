// Drill-down view for one pod. Shows daemon version, cert expiry,
// recent install events, paired sessions, and a metrics charts strip.
// Lighter than iOS — Compose tooling for line charts is heavier, so we
// summarize the metrics as last-sample numbers + a status line until
// MPAndroidChart (or Vico) is wired up.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.RadioButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
import com.flagshipserver.app.core.LocalFlagshipServerClient
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
import com.flagshipserver.app.viewmodels.RevokeServerPhase
import com.flagshipserver.app.viewmodels.RevokeServerReason
import com.flagshipserver.app.viewmodels.RevokeServerViewModel
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
            Spacer(Modifier.height(FS.space.s6))
            DangerZoneCard(serverDomain = d.value.serverFqdn)
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

// P13 — per-server danger zone. Exposes a single "Revoke this server"
// button that opens a ModalBottomSheet with a reason picker + a
// hold-to-confirm primary. The signing+POST lives in
// RevokeServerViewModel. Mirror of iOS DangerZoneCard.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DangerZoneCard(serverDomain: String) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val username by app.currentUser.collectAsState()
    var showSheet by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    Text(
        "Danger zone",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Revoke this server when the box is lost, stolen, or being decommissioned. The box will refuse to boot — this cannot be undone.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
            FSDangerButton(
                label = "Revoke this server",
                onClick = { showSheet = true },
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-revoke-server" },
            )
        }
    }

    if (showSheet) {
        ModalBottomSheet(
            onDismissRequest = { showSheet = false },
            sheetState = sheetState,
        ) {
            RevokeServerSheetBody(
                serverDomain = serverDomain,
                username = { username },
                server = server,
                onCompleted = {
                    toasts.success("Server revoked. It will refuse to boot next time.")
                    showSheet = false
                },
                onFailed = { msg ->
                    toasts.error("Revoke failed: $msg")
                },
                onCancel = { showSheet = false },
            )
        }
    }
}

@Composable
private fun RevokeServerSheetBody(
    serverDomain: String,
    username: () -> String?,
    server: com.flagshipserver.app.api.FlagshipServerClient,
    onCompleted: () -> Unit,
    onFailed: (String) -> Unit,
    onCancel: () -> Unit,
) {
    var reason by remember { mutableStateOf(RevokeServerReason.STOLEN) }
    val scope = rememberCoroutineScope()
    val vm = remember(serverDomain) {
        RevokeServerViewModel(
            server = server,
            serverDomain = serverDomain,
            username = username,
        )
    }
    val phase by vm.phase.collectAsState()
    var holding by remember { mutableStateOf(false) }

    Column(
        Modifier.padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Text(
            "Revoke this server?",
            color = FS.colors.text,
            style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
        )
        Text(
            "Bricks the box on next boot — this cannot be undone. $serverDomain will refuse to start. Other servers on your account stay running.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        )

        Text(
            "Reason",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
        )
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            for (r in RevokeServerReason.entries) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = reason == r,
                            onClick = { reason = r },
                            enabled = !isBusy(phase),
                        )
                        .semantics {
                            contentDescription = "revoke-reason-${r.wire}"
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = reason == r, onClick = { reason = r })
                    Text(
                        r.label,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp),
                    )
                }
            }
        }

        (phase as? RevokeServerPhase.Failed)?.let { f ->
            Text(f.message, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
        }

        // Primary: hold-to-confirm. 1.5s long-press fires the run.
        // Pinned to docs/revocation-ui.md (must match iOS). A short
        // tap does nothing destructive.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(FS.radius.md))
                .pointerInput(reason, phase) {
                    detectTapGestures(
                        onPress = {
                            if (isBusy(phase)) return@detectTapGestures
                            holding = true
                            var fired = false
                            try {
                                kotlinx.coroutines.withTimeout(REVOKE_HOLD_MS) {
                                    tryAwaitRelease()
                                }
                                // Released before timeout → no-op (short tap).
                            } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
                                // Held 1.5s → fire the run.
                                fired = true
                            }
                            holding = false
                            if (fired) {
                                scope.launch {
                                    vm.run(reason)
                                    when (val p = vm.phase.value) {
                                        is RevokeServerPhase.Completed -> onCompleted()
                                        is RevokeServerPhase.Failed -> onFailed(p.message)
                                        else -> {}
                                    }
                                }
                            }
                        },
                    )
                }
                .semantics { contentDescription = "revoke-confirm-hold" },
            contentAlignment = Alignment.Center,
        ) {
            FSDangerButton(
                label = buttonLabel(phase, holding),
                onClick = { /* hold-to-confirm — onClick is a no-op */ },
                block = true,
                enabled = !isBusy(phase),
            )
        }

        FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
        Spacer(Modifier.height(FS.space.s2))
    }
}

// P13 — hold-to-confirm duration. Pinned to docs/revocation-ui.md
// (must match iOS RevokeServerSheet.holdSeconds).
private const val REVOKE_HOLD_MS = 1500L

private fun isBusy(p: RevokeServerPhase): Boolean = when (p) {
    is RevokeServerPhase.Signing, is RevokeServerPhase.Posting -> true
    else -> false
}

private fun buttonLabel(p: RevokeServerPhase, holding: Boolean): String = when {
    p is RevokeServerPhase.Signing || p is RevokeServerPhase.Posting -> "Revoking…"
    holding -> "Hold to confirm…"
    else -> "Hold to revoke"
}
