// P14 — Settings → Remote.
//
// Phone-side browser-remote surface. remote.<apex> shows a QR naming only a
// relay session and the browser's key; this phone scans it, both screens show
// the same code, the owner picks a server and approves with biometrics, and
// the browser gets a 4-hour keyless session on that server. The browsers
// connected to the picked server are listed below, each with a disconnect.
//
// Mirrors FlagshipUI/Screens/CompanionDockScreen.swift + the canonical
// webapp `views/companion-dock.js`.

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.CompanionSummary
import com.flagshipserver.app.core.CreationPlacement
import com.flagshipserver.app.core.LiveQrRelayClient
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalQrRelayClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.MockQrRelayClient
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CompanionDockViewModel
import com.flagshipserver.app.viewmodels.RemoteServer
import com.flagshipserver.app.viewmodels.LoadingState
import kotlinx.coroutines.delay
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Locale

@Composable
fun CompanionDockScreen(nav: NavController, initialLink: String = "") {
    val client = LocalScreensClient.current
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val sharedRelay = LocalQrRelayClient.current
    val toasts = LocalToastCenter.current
    val pods by app.pods.collectAsState()
    val user by app.currentUser.collectAsState()
    val latestPods by rememberUpdatedState(pods)
    val latestUser by rememberUpdatedState(user)
    val latestCurrentPodId by rememberUpdatedState(app.currentPod?.podId)
    val vm = remember(client, podClients) {
        CompanionDockViewModel(
            serversProvider = {
                val currentPodId = latestCurrentPodId
                CreationPlacement.options(latestPods) { true }
                    .mapNotNull { option ->
                        val bound = podClients.screens(option.pod)
                            ?: client.takeIf { option.pod.podId == currentPodId }
                        bound?.let { RemoteServer(option.pod, it) }
                    }
                    .sortedWith(
                        compareByDescending<RemoteServer> { it.pod.podId == currentPodId }
                            .thenByDescending { app.liveness(it.pod) == PodInfo.LivenessState.ONLINE },
                    )
            },
            username = { latestUser },
            relayFactory = { if (sharedRelay is MockQrRelayClient) sharedRelay else LiveQrRelayClient() },
        )
    }
    val state by vm.state.collectAsState()
    val phase by vm.phase.collectAsState()
    val selectedPodId by vm.selectedPodId.collectAsState()
    val approvalError by vm.approvalError.collectAsState()
    val revokePending by vm.revokePending.collectAsState()
    var pendingRevoke by remember { mutableStateOf<CompanionSummary?>(null) }
    var pastedLink by remember { mutableStateOf(initialLink) }
    var scanning by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        vm.load()
        if (initialLink.isNotBlank()) vm.stageApproval(initialLink)
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "REMOTE",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
        )
        Text(
            "Open ${Endpoints.remoteHost} on your computer and scan the code it shows. " +
                "The browser gets four hours on the server you pick, without a key. Disconnect it anytime.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )

        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                FSPrimaryButton(
                    label = if (scanning) "Close scanner" else "Scan the browser's code",
                    onClick = { scanning = !scanning },
                    block = true,
                )
                if (scanning) {
                    QRScanner(onScanned = { raw ->
                        if (vm.stageApproval(raw)) {
                            pastedLink = raw
                            scanning = false
                        }
                    })
                }
                OutlinedTextField(
                    value = pastedLink,
                    onValueChange = { pastedLink = it },
                    label = { Text("Or paste its link") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    maxLines = 4,
                )
                FSGhostButton(
                    label = "Use pasted link",
                    onClick = { vm.stageApproval(pastedLink) },
                    enabled = pastedLink.isNotBlank(),
                    block = true,
                )
            }
        }

        when (val p = phase) {
            is CompanionDockViewModel.Phase.Connecting -> {
                Spacer(Modifier.height(FS.space.s3))
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Text("Connecting to the browser…", color = FS.colors.textMuted)
                }
            }
            is CompanionDockViewModel.Phase.Matching, CompanionDockViewModel.Phase.Approving -> {
                val code = (p as? CompanionDockViewModel.Phase.Matching)?.matchCode
                val gateOpen = (p as? CompanionDockViewModel.Phase.Matching)?.gateOpen == true
                Spacer(Modifier.height(FS.space.s3))
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text("Let this browser in?", color = FS.colors.text, fontWeight = FontWeight.SemiBold)
                        Text(
                            "Check the browser shows this code:",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                        if (code != null) {
                            Text(
                                QrRelay.formatMatchCode(code),
                                color = FS.colors.text,
                                style = TextStyle(fontSize = 32.sp, fontFamily = FontFamily.Monospace, letterSpacing = 4.sp),
                            )
                        }
                        Text("SERVER", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold))
                        vm.servers.forEach { server ->
                            val picked = server.pod.podId == selectedPodId
                            FSGhostButton(
                                label = (if (picked) "● " else "○ ") + server.pod.name,
                                onClick = { vm.selectServer(server.pod.podId) },
                                enabled = p !is CompanionDockViewModel.Phase.Approving,
                                block = true,
                            )
                        }
                        Text(
                            "It gets a keyless session for four hours. Protected actions still need this phone.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                        FSPrimaryButton(
                            label = if (p is CompanionDockViewModel.Phase.Approving) "Approving…" else "Codes match: approve",
                            onClick = { vm.approve() },
                            enabled = gateOpen && selectedPodId != null,
                            block = true,
                        )
                        FSGhostButton(label = "Cancel", onClick = { vm.cancel() }, block = true)
                    }
                }
            }
            is CompanionDockViewModel.Phase.Connected -> {
                Spacer(Modifier.height(FS.space.s3))
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Text("Browser connected to ${p.serverName}", color = FS.colors.text, fontWeight = FontWeight.SemiBold)
                }
            }
            CompanionDockViewModel.Phase.Idle -> Unit
        }
        approvalError?.let {
            Spacer(Modifier.height(FS.space.s2))
            Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
        }

        Spacer(Modifier.height(FS.space.s6))
        Text(
            "CONNECTED BROWSERS" +
                (vm.servers.firstOrNull { it.pod.podId == selectedPodId }?.let { " · ${it.pod.name.uppercase()}" } ?: ""),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        )
        Spacer(Modifier.height(FS.space.s2))

        when (val s = state) {
            is LoadingState.Loaded -> {
                if (s.value.companions.isEmpty()) {
                    EmptyCompanionsCard()
                } else {
                    s.value.companions.forEach { c ->
                        CompanionRow(
                            companion = c,
                            revoking = c.tokenPrefix in revokePending,
                            onRevokeRequest = { pendingRevoke = c },
                        )
                        Spacer(Modifier.height(FS.space.s2))
                    }
                }
            }
            is LoadingState.Failed -> ErrorCard(message = s.message, onRetry = { vm.load() })
            else -> ServerCardSkeleton()
        }

        Spacer(Modifier.height(FS.space.s12))
    }

    pendingRevoke?.let { c ->
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text("Disconnect this browser?") },
            text = {
                Text(
                    "Disconnect session ${c.tokenPrefix}. The browser session will stop immediately. " +
                        "It can reconnect any time with a fresh QR from ${Endpoints.remoteHost}.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = c.tokenPrefix
                    pendingRevoke = null
                    vm.revoke(target)
                    toasts.success("Browser disconnected.")
                }) {
                    Text("Disconnect", color = FS.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingRevoke = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun CompanionRow(
    companion: CompanionSummary,
    revoking: Boolean,
    onRevokeRequest: () -> Unit,
) {
    val now by produceState(initialValue = System.currentTimeMillis(), companion.expiresAt) {
        while (true) {
            value = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val remaining = (companion.expiresAt - now).coerceAtLeast(0L)
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    "Session ${companion.tokenPrefix}",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "last seen ${fmtRelative(companion.lastSeenMs, now)} · expires in ${formatRemaining(remaining)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                Text(
                    "token ${companion.tokenPrefix}…",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
                companion.userAgent?.let {
                    Text(
                        it,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                }
            }
            FSGhostButton(
                label = if (revoking) "Disconnecting…" else "Disconnect",
                onClick = onRevokeRequest,
                enabled = !revoking,
            )
        }
    }
}

@Composable
private fun EmptyCompanionsCard() {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Text(
            "No browsers connected yet. Open ${Endpoints.remoteHost} on a computer to add one.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
    }
}

private fun msUntil(expiresAt: Long): Long =
    (expiresAt - System.currentTimeMillis()).coerceAtLeast(0L)

private fun formatRemaining(ms: Long): String {
    if (ms <= 0L) return "expired"
    val totalSec = ms / 1000
    val hours = totalSec / 3600
    val minutes = (totalSec % 3600) / 60
    val seconds = totalSec % 60
    return when {
        hours > 0 -> String.format(Locale.US, "%dh %02dm", hours, minutes)
        minutes > 0 -> String.format(Locale.US, "%dm %02ds", minutes, seconds)
        else -> "${seconds}s"
    }
}

private fun fmtRelative(at: Long, now: Long): String {
    if (at <= 0L) return "—"
    return FlagshipDateFormat.format(at, nowMs = now)
}
