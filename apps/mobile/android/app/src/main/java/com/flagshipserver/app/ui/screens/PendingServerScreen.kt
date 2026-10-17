// Pending server detail. Shown while a box that just received its signed
// install blob hasn't gone live yet — renders the LIVE canonical install
// ladder (no more static "hasn't phoned home" placeholder):
//   - With the locally-held auth-code serial (this device minted the
//     order): deep per-order progress from GET /api/order/<serial>/status.
//   - Serial-less (the pod was surfaced from the unauthenticated `/pods`
//     directory, which ships opaque orderRefs only): list-level progress
//     riding the directory's `pending[].phase`, flipping live when the
//     fqdn registers. Without this fallback the ladder sat forever on the
//     empty "Booting up" state.
// The Cancel-order button hands back to the caller to revoke the
// auth-code on .com (the container in HomeTab handles the network call +
// AppState mutation).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ProvisionProgress
import com.flagshipserver.app.core.AuthCodeRevoke as AuthCodeRevokeBytes
import com.flagshipserver.app.core.ReleaseServerName as ReleaseServerNameBytes
import com.flagshipserver.app.api.AuthCodeRevokeRequest
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ProvisionTimelineViewModel
import kotlinx.coroutines.launch

@Composable
fun PendingServerScreen(
    pod: PodInfo,
    username: String? = null,
    onCancel: () -> Unit,
    /** The app bar's back arrow; defaults to the system back. */
    onBack: (() -> Unit)? = null,
) {
    val backDispatcher = androidx.activity.compose.LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val flagshipServer = LocalFlagshipServerClient.current
    val mailbox = LocalSecretMailboxClient.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    // Live install ladder — order mode with the locally-held serial;
    // directory fallback for a serial-less pod surfaced from `/pods`.
    val timeline = remember(pod.podId, pod.pendingAuthCodeSerial, username) {
        val serial = pod.pendingAuthCodeSerial
        when {
            !serial.isNullOrEmpty() ->
                ProvisionTimelineViewModel(serial, flagshipServer)
            !username.isNullOrEmpty() && pod.fqdn.isNotEmpty() ->
                ProvisionTimelineViewModel(username, pod.fqdn) { u ->
                    runCatching { mailbox.fetchPods(u) }.getOrNull()
                }
            else -> null
        }
    }
    LaunchedEffect(timeline) { timeline?.runUntilTerminal() }
    // Mirror each checkpoint onto the ongoing setup notification (and watch).
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(timeline) {
        val serial = pod.pendingAuthCodeSerial?.takeIf { it.isNotEmpty() }
        val key = serial ?: pod.fqdn
        timeline?.status?.collect { rec ->
            if (rec == null) return@collect
            com.flagshipserver.app.companion.ProvisionProgressCenter.report(
                context,
                com.flagshipserver.app.companion.ProvisionUpdate(
                    key = key, serial = serial, podName = pod.name,
                    phase = rec.phase, detail = rec.detail, serverDomain = rec.serverDomain ?: pod.fqdn,
                ),
            )
        }
    }

    // Mirror of iOS PendingServerScreen: the install checklist in one card,
    // the address in another, then Cancel order.
    FSScreen(
        title = pod.name,
        onBack = onBack ?: { backDispatcher?.onBackPressed(); Unit },
        subtitle = pod.description?.takeIf { it.isNotBlank() },
    ) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                FSPill("Pending", kind = FSPillKind.Pending)
                Text(
                    "Plug in the USB and power on. This screen tracks the install live and turns Online at the end.",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            // The canonical provisioning ladder — same projection the
            // InstallProgressScreen renders, fed by the timeline poller above.
            if (timeline != null) {
                val status by timeline.status.collectAsState()
                Column(Modifier.padding(top = FS.space.s2)) {
                    if (status == null) {
                        Text(
                            "Waiting for the server to phone home…",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(vertical = FS.space.s2),
                        )
                    }
                    val prevPhase = status?.history?.dropLast(1)?.lastOrNull()?.phase
                    val steps = ProvisionProgress.stepStates(status?.phase, status?.detail, prevPhase)
                    for (step in steps) {
                        // The card's own gutter already insets the rows.
                        InstallStepRow(step, horizontalPadding = 0.dp)
                    }
                }
            }
        }
        if (pod.fqdn.isNotEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("pending-server-domain")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Text(
                        "Address",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelLarge,
                    )
                    androidx.compose.foundation.text.selection.SelectionContainer {
                        Text(
                            pod.fqdn,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                        )
                    }
                    if (pod.pendingAuthCodeSerial != null) {
                        Text(
                            "Order ${pod.pendingAuthCodeSerial}",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
        FSDangerButton(
            label = "Cancel order",
            onClick = {
                scope.launch {
                    val username = app.currentUser.value
                    if (username == null) {
                        // No account context — nothing to release; just drop
                        // the local placeholder.
                        onCancel()
                        return@launch
                    }
                    // Mirrors webapp `cancelServer` + iOS HomeTab.cancelOrder:
                    // FIRST release the name (the IRK-signed
                    // ReleaseServerName → /api/server/release un-pins the
                    // routing record so the name can be re-used), THEN
                    // belt-and-braces revoke the install auth-code. If the
                    // release fails we surface the error and KEEP the pod —
                    // dropping it locally would strand the name as
                    // still-reserved.
                    try {
                        // Releasing a name is a sensitive order: `.com` takes
                        // only the admin root on an admin-pinned account
                        // (serverRevoke.ts); the auth-code revoke stays IRK.
                        val adminKey = Keystore.adminSigningKey("Cancel server ${pod.name}")
                        val irk = Keystore.deriveIRK("Cancel server ${pod.name}")
                        val now = System.currentTimeMillis()
                        // 1. Release the name. serverDomain =
                        // <server>.<user>.flagship.services, held on the pod
                        // as its fqdn.
                        val releaseBytes = ReleaseServerNameBytes.canonicalBytes(username, pod.fqdn, now)
                        val releaseSig = HexUtil.encode(adminKey.sign(releaseBytes))
                        flagshipServer.releaseServerName(
                            ReleaseServerNameRequest(
                                request = ReleaseServerNameRequest.Inner(
                                    username = username, serverDomain = pod.fqdn, issuedAt = now,
                                ),
                                signature = releaseSig,
                            ),
                        )
                        // 2. Belt-and-braces auth-code revoke. The release
                        // already revoked active codes server-side; 403/404
                        // (already gone) is treated as success by the client.
                        val serial = pod.pendingAuthCodeSerial
                        if (serial != null) {
                            val revokeBytes = AuthCodeRevokeBytes.canonicalBytes(serial, username, now)
                            val revokeSig = HexUtil.encode(irk.sign(revokeBytes))
                            runCatching {
                                flagshipServer.revokeAuthCode(
                                    AuthCodeRevokeRequest(
                                        request = AuthCodeRevokeRequest.Inner(
                                            serial = serial, username = username, issuedAt = now,
                                        ),
                                        signature = revokeSig,
                                    ),
                                )
                            }
                        }
                        toasts.success("Server \"${pod.name}\" cancelled — the name is free again.")
                        onCancel()
                    } catch (_: Throwable) {
                        // Keep the pod: the name is still reserved, so
                        // dropping it locally would just hide a name the
                        // user can't re-use.
                        toasts.warning("Couldn't cancel — the name is still reserved. Check your connection and try again.")
                    }
                }
            },
            block = true,
            large = true,
            modifier = Modifier.testTag("pending-cancel-order-button"),
        )
    }
}
