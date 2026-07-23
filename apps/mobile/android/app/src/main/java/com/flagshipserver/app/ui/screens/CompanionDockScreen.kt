// P14 — Settings → Dock a browser.
//
// Phone-side companion-dock surface. The desktop starts the ceremony and
// displays a QR; this keyholder phone scans/pastes it, biometric-gates the
// approval, and grants a 4-hour keyless companion session. Active
// companions are listed below; each row has a single-tap revoke with a
// confirm dialog.
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
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CompanionDockViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import kotlinx.coroutines.delay
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Locale

@Composable
fun CompanionDockScreen(nav: NavController, initialLink: String = "") {
    val client = LocalScreensClient.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val vm = remember(client, app.currentPod?.fqdn) {
        CompanionDockViewModel(client, expectedServerDomain = app.currentPod?.fqdn)
    }
    val state by vm.state.collectAsState()
    val stagedApproval by vm.stagedApproval.collectAsState()
    val approvalPending by vm.approvalPending.collectAsState()
    val approvalError by vm.approvalError.collectAsState()
    val approvalComplete by vm.approvalComplete.collectAsState()
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
            "Dock a browser",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Open web.flagshipserver.com/dock on your computer, then approve its pairing code here.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )

        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                FSPrimaryButton(
                    label = if (scanning) "Close scanner" else "Scan pairing QR",
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
                    label = { Text("Paste pairing link") },
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

        stagedApproval?.let { approval ->
            Spacer(Modifier.height(FS.space.s3))
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text("Approve this browser?", color = FS.colors.text, fontWeight = FontWeight.SemiBold)
                    Text(approval.serverDomain, color = FS.colors.textMuted, fontFamily = FontFamily.Monospace)
                    Text(
                        "It will receive a keyless companion session for four hours. Protected actions still require approval from this phone.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 13.sp),
                    )
                    FSPrimaryButton(
                        label = if (approvalPending) "Approving…" else "Approve with biometrics",
                        onClick = { vm.approve() },
                        enabled = !approvalPending,
                        block = true,
                    )
                    FSGhostButton(label = "Cancel", onClick = { vm.clearApproval() }, block = true)
                }
            }
        }
        if (approvalComplete) {
            Spacer(Modifier.height(FS.space.s3))
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text("Browser docked", color = FS.colors.text, fontWeight = FontWeight.SemiBold)
            }
        }
        approvalError?.let {
            Spacer(Modifier.height(FS.space.s2))
            Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
        }

        Spacer(Modifier.height(FS.space.s6))
        Text(
            "ACTIVE BROWSERS",
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
            title = { Text("Revoke this browser?") },
            text = {
                Text(
                    "Revoke session ${c.tokenPrefix}. The browser session will stop immediately. " +
                        "You can pair it again any time with a fresh QR from the desktop dock page.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = c.tokenPrefix
                    pendingRevoke = null
                    vm.revoke(target)
                    toasts.success("Browser revoked.")
                }) {
                    Text("Revoke", color = FS.colors.danger)
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
                label = if (revoking) "Revoking…" else "Revoke",
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
            "No browsers docked yet. Open the dock page on a computer to add one.",
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
