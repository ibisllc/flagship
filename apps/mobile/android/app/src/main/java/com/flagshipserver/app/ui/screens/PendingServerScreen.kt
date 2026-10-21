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

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.CancelPendingOrder
import com.flagshipserver.app.core.PendingRckStore
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ProvisionProgress
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
    var cancelError by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<String?>(null) }
    var cancelling by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }

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
                FSPill(stringResource(R.string.pending), kind = FSPillKind.Pending)
                Text(
                    stringResource(R.string.plug_in_the_usb_and_power),
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
                            stringResource(R.string.waiting_for_the_server_to_phone),
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
        if (timeline != null && !pod.pendingAuthCodeSerial.isNullOrEmpty()) {
            val failed by timeline.status.collectAsState()
            if (failed?.phase == "error") {
                SetupStoppedCard(
                    serial = pod.pendingAuthCodeSerial!!,
                    step = ProvisionProgress.failureDetail(failed?.detail),
                    onStartedOver = onCancel,
                )
            }
        }
        if (pod.fqdn.isNotEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.testTag("pending-server-domain")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Text(
                        stringResource(R.string.address),
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
                            fsString(R.string.order, pod.pendingAuthCodeSerial),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
        if (cancelError != null) {
            Text(
                cancelError!!,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("pending-cancel-error"),
            )
        }
        FSDangerButton(
            label = if (cancelling) stringResource(R.string.cancelling) else if (cancelError != null) stringResource(R.string.try_cancelling_again) else stringResource(R.string.cancel_order),
            enabled = !cancelling,
            onClick = {
                scope.launch {
                    val user = app.currentUser.value
                    if (user == null) {
                        // No account context — nothing to release; just drop
                        // the local placeholder.
                        onCancel()
                        return@launch
                    }
                    cancelling = true
                    cancelError = null
                    // Mirrors webapp `cancelServer` + iOS HomeTab.cancelOrder:
                    // release the name FIRST, then revoke the install
                    // auth-code. On a failure the pod is KEPT (dropping it
                    // would strand the name as still reserved) and the reason
                    // is shown with a button that runs the same cancel again.
                    when (val out = CancelPendingOrder.run(pod, user, flagshipServer)) {
                        is CancelPendingOrder.Outcome.Cancelled -> {
                            PendingRckStore.from(context).clear(pod.fqdn)
                            toasts.success(
                                if (out.releasedName) FSStrings.get(R.string.server_cancelled_the_name_is_free, pod.name)
                                else FSStrings.get(R.string.removed_from_your_servers, pod.name),
                            )
                            onCancel()
                        }
                        is CancelPendingOrder.Outcome.Failed -> cancelError = out.message
                    }
                    cancelling = false
                }
            },
            block = true,
            large = true,
            modifier = Modifier.testTag("pending-cancel-order-button"),
        )
    }
}
