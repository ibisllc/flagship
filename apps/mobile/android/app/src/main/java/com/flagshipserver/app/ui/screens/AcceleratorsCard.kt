// The server page's "GPUs" (packages/server-daemon/src/gpu/http.ts): each GPU with its model, memory
// and state, the app holding it (with Stop, which asks first), and the apps waiting for one. Hidden on
// a box with no GPU or no GPU screen. Mirror of iOS AcceleratorsCard.swift and the webapp
// views/accelerators.js.

package com.flagshipserver.app.ui.screens

import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.flagshipserver.app.R
import com.flagshipserver.app.api.AcceleratorDevice
import com.flagshipserver.app.api.AcceleratorHolder
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.AcceleratorsCopy
import com.flagshipserver.app.core.AdminOrderGate
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AcceleratorsViewModel
import kotlinx.coroutines.launch

@Composable
internal fun AcceleratorsCard(serverDomain: String, client: ScreensClient) {
    val vm = remember(serverDomain, client) { AcceleratorsViewModel(client, serverDomain) }
    val appState = LocalAppState.current
    val canSign = AdminOrderGate.allows(appState)
    val s by vm.state.collectAsState()
    // The card's own scope: answering Stop outlives the dialog, and the card stays in the tree
    // (empty) even when its last row goes, so the reload and the notice are never lost.
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var stopping by remember { mutableStateOf<AcceleratorHolder?>(null) }
    LaunchedEffect(vm) { vm.load() }
    if (!s.shows) return

    Column(modifier = Modifier.testTag("accelerators-card"), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        FSSectionHeader(stringResource(R.string.accelerators_title))
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                val v = s.view
                if (v == null) {
                    s.loadError?.let { Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("accelerators-load-error")) }
                } else {
                    if (v.admissionPaused != null) {
                        Text(stringResource(R.string.accelerators_paused), color = FS.colors.warning, style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("accelerators-paused"))
                    }
                    if (v.devices.isEmpty() && v.reason != null) {
                        Text(stringResource(R.string.accelerators_service_error), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("accelerators-service-error"))
                    }
                    val pending = vm.pending(v)
                    pending.forEach { r ->
                        Column(Modifier.testTag("gpu-approval-pending-${r.appId}"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text(AcceleratorsCopy.asks(r), color = FS.colors.warning, style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.testTag("gpu-approval-ask-${r.appId}"))
                            if (canSign) {
                                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                                    FSPrimaryButton(stringResource(R.string.gpu_approval_approve), onClick = { scope.launch { approveResult(vm.approve(r), vm, toasts) } },
                                        enabled = s.busy == null, modifier = Modifier.testTag("gpu-approval-approve-${r.appId}"))
                                    FSSecondaryButton(stringResource(R.string.gpu_approval_decline), onClick = { approveResult(vm.decline(r), vm, toasts) },
                                        enabled = s.busy == null, modifier = Modifier.testTag("gpu-approval-decline-${r.appId}"))
                                }
                            }
                        }
                    }
                    v.approvals.forEach { r ->
                        Column(Modifier.testTag("gpu-approval-granted-${r.appId}"), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                            Text(AcceleratorsCopy.allowed(r), style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("gpu-approval-allowed-${r.appId}"))
                            if (canSign) {
                                FSSecondaryButton(stringResource(R.string.gpu_approval_withdraw), onClick = { scope.launch { approveResult(vm.withdraw(r), vm, toasts) } },
                                    enabled = s.busy == null, modifier = Modifier.testTag("gpu-approval-withdraw-${r.appId}"))
                            }
                        }
                    }
                    if (!canSign && (pending.isNotEmpty() || v.approvals.isNotEmpty())) {
                        Text(stringResource(R.string.gpu_approval_admin_only), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.testTag("gpu-approval-admin-only"))
                    }
                    v.devices.forEach { d -> DeviceRow(d, busy = s.busy != null, onStop = { stopping = it }) }
                    if (v.queue.isNotEmpty()) {
                        Column(Modifier.testTag("accelerators-queue"), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                            Text(stringResource(R.string.accelerators_waiting_title), fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodySmall)
                            v.queue.forEach { q ->
                                Text(AcceleratorsCopy.waiting(q), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.testTag("accelerator-queue-${q.appId}"))
                            }
                        }
                    }
                }
                s.notice?.let { Text(it, color = FS.colors.success, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("accelerators-notice")) }
                s.error?.let { Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("accelerators-error")) }
            }
        }
    }

    stopping?.let { h ->
        AlertDialog(
            onDismissRequest = { stopping = null },
            confirmButton = {
                TextButton(
                    onClick = {
                        stopping = null
                        scope.launch {
                            if (vm.stop(h)) toasts.success(AcceleratorsCopy.stopped(h))
                            else vm.state.value.error?.let { toasts.error(it) }
                        }
                    },
                    modifier = Modifier.testTag("accelerator-stop-confirm"),
                ) { Text(stringResource(R.string.accelerators_stop)) }
            },
            dismissButton = {
                TextButton(onClick = { stopping = null }, modifier = Modifier.testTag("accelerator-stop-cancel")) { Text(stringResource(R.string.cancel)) }
            },
            title = { Text(AcceleratorsCopy.stopTitle(h)) },
            text = { Text(stringResource(R.string.accelerators_stop_message)) },
        )
    }
}

@Composable
private fun DeviceRow(d: AcceleratorDevice, busy: Boolean, onStop: (AcceleratorHolder) -> Unit) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth().testTag("accelerator-${d.id}"), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
        Text(AcceleratorsCopy.device(d), fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("accelerator-name-${d.id}"))
        Text(
            "${Formatter.formatShortFileSize(ctx, d.memoryMiB * 1024 * 1024)} · ${AcceleratorsCopy.state(d.state)}",
            color = if (d.state == "quarantined") FS.colors.warning else FS.colors.textMuted,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("accelerator-state-${d.id}"),
        )
        d.holders.forEach { h ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text(AcceleratorsCopy.holder(h), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).testTag("accelerator-holder-${d.id}"))
                FSSecondaryButton(
                    stringResource(R.string.accelerators_stop),
                    onClick = { onStop(h) },
                    enabled = !busy,
                    modifier = Modifier.testTag("accelerator-stop-${h.allocationId}"),
                )
            }
        }
    }
}

/** After a signed answer: the notice on the card, and a toast either way. */
private fun approveResult(ok: Boolean, vm: AcceleratorsViewModel, toasts: com.flagshipserver.app.core.ToastCenter) {
    val st = vm.state.value
    if (ok) st.notice?.let { toasts.success(it) } else st.error?.let { toasts.error(it) }
}
