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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.RadioButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
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
import com.flagshipserver.app.core.DeadManReminders
import com.flagshipserver.app.core.PowerMode
import com.flagshipserver.app.core.SecretRequestCoordinator
import com.flagshipserver.app.core.ServerSettingsStore
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.push.DeadManReminderScheduler
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import com.flagshipserver.app.viewmodels.DeadManPhase
import com.flagshipserver.app.viewmodels.DeadManViewModel
import com.flagshipserver.app.viewmodels.FrontPagePhase
import com.flagshipserver.app.viewmodels.FrontPageViewModel
import com.flagshipserver.app.viewmodels.DeadManWindow
import com.flagshipserver.app.viewmodels.HomeViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.PowerOffPhase
import com.flagshipserver.app.viewmodels.PowerOffViewModel
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
        // Retry until the box answers its BFF — an online box whose daemon
        // raced readiness no longer sticks on the skeleton until manual refresh.
        detailVm.loadUntilLoaded()
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
            FrontPageCard(serverDomain = d.value.serverFqdn)
            Spacer(Modifier.height(FS.space.s6))
            PowerCard(serverDomain = d.value.serverFqdn)
            Spacer(Modifier.height(FS.space.s6))
            DeadManCard(serverDomain = d.value.serverFqdn)
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

// "Front page" picker: choose which installed app the box's root domain
// redirects to (a visible 302 to the app's tier-1 canonical), or keep the
// default Flagship page. Save signs a `set-front-page` order with the owner
// IRK (biometric inside the signer) and POSTs it pod-direct. Mirror of iOS
// FrontPageCard.
@Composable
private fun FrontPageCard(serverDomain: String) {
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    val vm = remember(serverDomain) {
        FrontPageViewModel(
            serverDomain = serverDomain,
            signer = { reason -> Keystore.deriveIRK(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    val current by vm.current.collectAsState()
    val options by vm.options.collectAsState()
    var selection by remember { mutableStateOf("") }

    LaunchedEffect(serverDomain) {
        vm.load()
        selection = vm.current.value ?: ""
    }

    val busy = phase is FrontPagePhase.Signing || phase is FrontPagePhase.Posting

    Text(
        "Front page",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "What visitors see at $serverDomain. Point it at one of your apps, or keep the default Flagship page.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            when (phase) {
                is FrontPagePhase.Idle, is FrontPagePhase.Loading -> {
                    Text("Loading…", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                }
                is FrontPagePhase.Failed -> {
                    Text(
                        (phase as FrontPagePhase.Failed).message,
                        color = FS.colors.danger,
                        style = TextStyle(fontSize = 13.sp),
                    )
                    FSSecondaryButton(
                        label = "Retry",
                        onClick = {
                            scope.launch {
                                vm.load()
                                selection = vm.current.value ?: ""
                            }
                        },
                        block = true,
                    )
                }
                else -> {
                    // "" = the default page; then one row per installed app.
                    // An assigned-but-uninstalled label still shows (marked)
                    // so the owner can see and clear a stale assignment.
                    val rows = buildList {
                        add("" to "Default Flagship page")
                        for (o in options) add(o.urlLabel to "${o.name ?: o.urlLabel} — ${o.urlLabel}")
                        current?.let { cur ->
                            if (options.none { it.urlLabel == cur }) add(cur to "$cur (no longer installed)")
                        }
                    }
                    for ((value, labelText) in rows) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .selectable(selected = selection == value, enabled = !busy) {
                                    selection = value
                                },
                        ) {
                            RadioButton(
                                selected = selection == value,
                                onClick = { if (!busy) selection = value },
                            )
                            Text(labelText, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
                        }
                    }
                    FSSecondaryButton(
                        label = if (busy) "Saving…" else "Save",
                        onClick = {
                            if (!busy && selection != (current ?: "")) {
                                scope.launch {
                                    vm.save(selection)
                                    val p = vm.phase.value
                                    if (p is FrontPagePhase.Failed) {
                                        toasts.error(p.message)
                                        selection = vm.current.value ?: ""
                                    } else {
                                        toasts.success(
                                            if (selection.isEmpty()) "Front page reset to default"
                                            else "Front page set to $selection",
                                        )
                                    }
                                }
                            }
                        },
                        enabled = !busy && selection != (current ?: ""),
                        block = true,
                        modifier = Modifier.semantics { contentDescription = "sd-front-page-save" },
                    )
                }
            }
        }
    }
}

// Manual lock-&-power buttons. "Lock and turn off" / "Lock and restart"
// drop "Lock and " when the box is non-LUKS. Confirm dialog → owner-IRK-signed
// `power-off` order (the deriveIRK signer fires the biometric) → POST to the
// box's /api/power. Mirror of iOS PowerCard.
//
// LUKS LABEL: ServerDetailResponse carries no diskEncryption flag (set at
// create-time on the InstallBlob, never surfaced on the detail model), so we
// default to LUKS labeling. Tracked as a gap — when the detail model gains the
// flag, pass it here to flip to plain "Turn off"/"Restart" for non-LUKS boxes.
@Composable
private fun PowerCard(serverDomain: String, isLuks: Boolean = true) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()

    val vm = remember(serverDomain) {
        PowerOffViewModel(
            serverDomain = serverDomain,
            // deriveIRK runs the biometric gate, then signs with the owner IRK
            // — the SAME key the daemon's /api/power pins. Never silent.
            signer = { reason -> Keystore.deriveIRK(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    var pending by remember { mutableStateOf<PowerMode?>(null) }
    val busy = phase is PowerOffPhase.Signing || phase is PowerOffPhase.Posting

    val prefix = if (isLuks) "Lock and " else ""
    val offLabel = "${prefix}turn off".replaceFirstChar { it.uppercase() }
    val restartLabel = "${prefix}restart".replaceFirstChar { it.uppercase() }

    Text(
        "Power",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            (phase as? PowerOffPhase.Failed)?.let { f ->
                Text(f.message, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
            }
            (phase as? PowerOffPhase.Completed)?.let { c ->
                val verb = if (c.mode == PowerMode.RESTART) "restarting" else "powering off"
                Text("This box is $verb — it will go offline.", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
            FSDangerButton(
                label = if (busy) "Working…" else offLabel,
                onClick = { if (!busy) pending = PowerMode.OFF },
                enabled = !busy,
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-power-off" },
            )
            FSDangerButton(
                label = if (busy) "Working…" else restartLabel,
                onClick = { if (!busy) pending = PowerMode.RESTART },
                enabled = !busy,
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-power-restart" },
            )
        }
    }

    pending?.let { mode ->
        val confirmLabel = if (mode == PowerMode.RESTART) restartLabel else offLabel
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("$confirmLabel?") },
            text = { Text("$serverDomain will go offline.") },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    scope.launch {
                        // The deriveIRK signer fires the biometric prompt inside
                        // vm.run — no separate gate needed (matches DeadManCard).
                        vm.run(mode)
                        when (val p = vm.phase.value) {
                            is PowerOffPhase.Completed ->
                                toasts.success("Command sent to the box.")
                            is PowerOffPhase.Failed ->
                                toasts.error(p.message)
                            else -> {}
                        }
                    }
                }) { Text(confirmLabel) }
            },
            dismissButton = {
                TextButton(onClick = { pending = null }) { Text("Cancel") }
            },
        )
    }
}

// Dead-man heartbeat-lock opt-in + the manual affirmation loop. Toggle arms
// the IRK-signed SetDeadManPolicy; a window picker (24h default, down to
// minutes) + a one-tap "tighten now" + a lockout-action choice (off default /
// restart). "Affirm now" sends an IRK-signed DeadManAffirmation and reschedules
// the T-6h/T-1h/T-15m reminders. Mirror of iOS DeadManCard.
@Composable
private fun DeadManCard(serverDomain: String) {
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val username by app.currentUser.collectAsState()

    val vm = remember(serverDomain) {
        DeadManViewModel(
            serverDomain = serverDomain,
            username = { username },
            // deriveIRK runs the biometric gate — never a silent renew.
            signer = { reason -> Keystore.deriveIRK(reason) },
        )
    }
    val phase by vm.phase.collectAsState()
    val busy = phase is DeadManPhase.Signing || phase is DeadManPhase.Posting

    var enabled by remember(serverDomain) { mutableStateOf(false) }
    var window by remember(serverDomain) { mutableStateOf(DeadManWindow.DEFAULT) }
    var lockout by remember(serverDomain) { mutableStateOf(PowerMode.OFF) }
    var leaseExpiry by remember(serverDomain) { mutableStateOf<Long?>(null) }

    fun applyPolicy(targetEnabled: Boolean, targetWindow: DeadManWindow, targetLockout: PowerMode) {
        scope.launch {
            val ok = vm.setPolicy(targetEnabled, targetWindow, targetLockout)
            if (ok) {
                enabled = targetEnabled
                window = targetWindow
                lockout = targetLockout
                if (!targetEnabled) {
                    leaseExpiry = null
                    DeadManReminderScheduler.cancel(context, serverDomain)
                    toasts.success("Dead-man lock disarmed.")
                } else {
                    toasts.success("Dead-man lock armed.")
                }
            } else {
                (vm.phase.value as? DeadManPhase.Failed)?.let { toasts.error(it.message) }
            }
        }
    }

    Text(
        "Dead-man lock",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Auto-lock if I go quiet", color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium))
                    Text(
                        "If you don't affirm within the window, this box powers off (or restarts) and needs your phone to come back.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                    )
                }
                Switch(
                    checked = enabled,
                    enabled = !busy,
                    onCheckedChange = { applyPolicy(it, window, lockout) },
                    modifier = Modifier.semantics { contentDescription = "sd-deadman-toggle" },
                )
            }

            if (enabled) {
                Text("Window", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold))
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    for (w in DeadManWindow.entries) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .selectable(selected = window == w, enabled = !busy, onClick = { applyPolicy(true, w, lockout) })
                                .semantics { contentDescription = "deadman-window-${w.windowMs}" },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = window == w, onClick = { applyPolicy(true, w, lockout) })
                            Text(w.label, color = FS.colors.text, style = TextStyle(fontSize = 15.sp))
                        }
                    }
                }

                Text("On lapse", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                    for (m in listOf(PowerMode.OFF to "Turn off", PowerMode.RESTART to "Restart")) {
                        Row(
                            Modifier
                                .selectable(selected = lockout == m.first, enabled = !busy, onClick = { applyPolicy(true, window, m.first) })
                                .semantics { contentDescription = "deadman-lockout-${m.first.wire}" },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = lockout == m.first, onClick = { applyPolicy(true, window, m.first) })
                            Text(m.second, color = FS.colors.text, style = TextStyle(fontSize = 15.sp))
                        }
                    }
                }

                leaseExpiry?.let { exp ->
                    Text(
                        DeadManReminders.remainingLabel(exp, System.currentTimeMillis()),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                    )
                }

                FSGhostButton(
                    label = "Tighten now (5 min)",
                    onClick = { applyPolicy(true, DeadManWindow.TIGHTEN, lockout) },
                    block = true,
                )
                FSPrimaryButton(
                    label = if (busy) "Working…" else "Affirm now",
                    onClick = {
                        scope.launch {
                            val exp = vm.affirm()
                            if (exp != null) {
                                leaseExpiry = exp
                                DeadManReminderScheduler.schedule(context, serverDomain, exp)
                                toasts.success("Stay confirmed.")
                            } else {
                                (vm.phase.value as? DeadManPhase.Failed)?.let { toasts.error(it.message) }
                            }
                        }
                    },
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.semantics { contentDescription = "sd-deadman-affirm" },
                )
            }
        }
    }
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
