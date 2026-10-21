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

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import com.flagshipserver.app.ui.components.fsFocusRing
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Laptop
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.RadioButton
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
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
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
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
            relayFactory = { com.flagshipserver.app.core.Variant.reuseRelay(sharedRelay) ?: LiveQrRelayClient() },
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

    FSScreen(
        title = stringResource(R.string.remote),
        onBack = { nav.popBackStack() },
        subtitle = fsString(R.string.open_on_your_computer_and_scan, Endpoints.remoteHost),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader(stringResource(R.string.connect_a_browser))
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    FSPrimaryButton(
                        label = if (scanning) stringResource(R.string.close_scanner) else stringResource(R.string.scan_the_browsers_code),
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
                        label = { Text(stringResource(R.string.or_paste_its_link)) },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 2,
                        maxLines = 4,
                    )
                    FSSecondaryButton(
                        label = stringResource(R.string.use_pasted_link),
                        onClick = { vm.stageApproval(pastedLink) },
                        enabled = pastedLink.isNotBlank(),
                        block = true,
                    )
                }
            }
        }

        when (val p = phase) {
            is CompanionDockViewModel.Phase.Connecting -> {
                FSCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        Text(
                            stringResource(R.string.connecting_to_the_browser),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
            is CompanionDockViewModel.Phase.Matching, CompanionDockViewModel.Phase.Approving -> {
                val code = (p as? CompanionDockViewModel.Phase.Matching)?.matchCode
                val gateOpen = (p as? CompanionDockViewModel.Phase.Matching)?.gateOpen == true
                val approving = p is CompanionDockViewModel.Phase.Approving
                FSCard {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        Text(stringResource(R.string.let_this_browser_in), style = MaterialTheme.typography.titleMedium)
                        if (code != null) {
                            Text(
                                stringResource(R.string.check_the_browser_shows_this_code),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                QrRelay.formatMatchCode(code),
                                color = MaterialTheme.colorScheme.onSurface,
                                style = MaterialTheme.typography.displaySmall.copy(fontFamily = FontFamily.Monospace, letterSpacing = 4.sp),
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        Text(stringResource(R.string.server_2), style = MaterialTheme.typography.titleSmall)
                        Column(Modifier.selectableGroup()) {
                            vm.servers.forEach { server ->
                                val picked = server.pod.podId == selectedPodId
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 48.dp)
                                        .fsFocusRing(8.dp).selectable(
                                            selected = picked,
                                            enabled = !approving,
                                            role = Role.RadioButton,
                                            onClick = { vm.selectServer(server.pod.podId) },
                                        ),
                                ) {
                                    RadioButton(selected = picked, onClick = null, enabled = !approving)
                                    Text(server.pod.name, style = MaterialTheme.typography.bodyLarge)
                                }
                            }
                        }
                        Text(
                            stringResource(R.string.it_gets_a_keyless_session_for),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        FSPrimaryButton(
                            label = if (approving) stringResource(R.string.approving) else stringResource(R.string.codes_match_approve),
                            onClick = { vm.approve() },
                            enabled = gateOpen && selectedPodId != null,
                            block = true,
                        )
                        FSSecondaryButton(label = stringResource(R.string.cancel), onClick = { vm.cancel() }, block = true)
                    }
                }
            }
            is CompanionDockViewModel.Phase.Connected -> {
                FSCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
                        Text(fsString(R.string.browser_connected_to, p.serverName), style = MaterialTheme.typography.titleSmall)
                    }
                }
            }
            CompanionDockViewModel.Phase.Idle -> Unit
        }
        approvalError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader(
                stringResource(R.string.connected_browsers) +
                    (vm.servers.firstOrNull { it.pod.podId == selectedPodId }?.let { " on ${it.pod.name}" } ?: ""),
            )
            when (val s = state) {
                is LoadingState.Loaded -> {
                    if (s.value.companions.isEmpty()) {
                        EmptyCompanionsCard()
                    } else {
                        FSGroup {
                            s.value.companions.forEachIndexed { idx, c ->
                                CompanionRow(
                                    companion = c,
                                    revoking = c.tokenPrefix in revokePending,
                                    onRevokeRequest = { pendingRevoke = c },
                                )
                                if (idx < s.value.companions.size - 1) FSDivider()
                            }
                        }
                    }
                }
                is LoadingState.Failed -> ErrorCard(message = s.message, onRetry = { vm.load() })
                else -> ServerCardSkeleton()
            }
        }
    }

    pendingRevoke?.let { c ->
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text(stringResource(R.string.disconnect_this_browser)) },
            text = {
                Text(
                    fsString(R.string.disconnect_session_the_browser_session_will, c.tokenPrefix, Endpoints.remoteHost),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = c.tokenPrefix
                    pendingRevoke = null
                    vm.revoke(target)
                    toasts.success(FSStrings.get(R.string.browser_disconnected))
                }) {
                    Text(stringResource(R.string.disconnect), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingRevoke = null }) { Text(stringResource(R.string.cancel)) }
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
    val lines = buildList {
        add("last seen ${fmtRelative(companion.lastSeenMs, now)} · expires in ${formatRemaining(remaining)}")
        companion.userAgent?.let { add(it) }
    }
    FSRow(
        title = fsString(R.string.session, companion.tokenPrefix),
        subtitle = lines.joinToString("\n"),
        icon = Icons.Outlined.Laptop,
        trailing = {
            FSDangerButton(
                label = if (revoking) stringResource(R.string.disconnecting) else stringResource(R.string.disconnect),
                onClick = onRevokeRequest,
                enabled = !revoking,
            )
        },
    )
}

@Composable
private fun EmptyCompanionsCard() {
    FSEmptyState(
        title = stringResource(R.string.no_browsers_connected),
        message = fsString(R.string.open_on_a_computer_to_add, Endpoints.remoteHost),
        icon = Icons.Outlined.Laptop,
    )
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
