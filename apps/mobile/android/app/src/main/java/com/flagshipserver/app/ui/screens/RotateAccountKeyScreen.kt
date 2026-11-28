// "Change your account key" (docs/account-key-rotation.md): the summary before an admin device removes a device
// and changes the account key, the progress card after it, and the banner a kept device shows until it holds the
// new key.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.keystore.AccountKeyService
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.RotateAccountKeyViewModel
import kotlinx.coroutines.launch

@Composable
fun RotateAccountKeyScreen(nav: NavController, removedDeviceId: String) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val podClients = LocalPodClients.current
    val user = app.currentUser.collectAsState().value.orEmpty()
    val deviceId = app.activeProfile?.deviceId.orEmpty()
    val vm: RotateAccountKeyViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                RotateAccountKeyViewModel(
                    server = server,
                    username = user,
                    deviceId = deviceId,
                    deviceName = { app.activeProfile?.deviceDisplayName },
                    pods = { app.pods.value },
                    clientFor = { pod -> podClients.screens(pod) },
                )
            }
        },
    )
    val phase = vm.phase.collectAsState().value
    val progress = vm.progress.collectAsState().value
    val scope = rememberCoroutineScope()
    LaunchedEffect(removedDeviceId) { if (vm.phase.value == RotateAccountKeyViewModel.Phase.Idle) vm.prepare(removedDeviceId) }

    FSScreen(title = stringResource(R.string.akr_change_account_key), onBack = { nav.popBackStack() }) {
        when (phase) {
            RotateAccountKeyViewModel.Phase.Idle, RotateAccountKeyViewModel.Phase.Checking -> Busy(null)
            RotateAccountKeyViewModel.Phase.Rotating -> Busy(stringResource(R.string.akr_rotating))
            is RotateAccountKeyViewModel.Phase.Unavailable -> Message(phase.message, "akr-unavailable") { nav.popBackStack() }
            is RotateAccountKeyViewModel.Phase.Failed -> Message(phase.message, "akr-failed") { nav.popBackStack() }
            is RotateAccountKeyViewModel.Phase.Summary -> Summary(
                phase,
                onConfirm = { scope.launch { vm.confirm(); vm.refreshProgress() } },
                onCancel = { nav.popBackStack() },
            )
            is RotateAccountKeyViewModel.Phase.Done -> {
                FSCard(modifier = Modifier.testTag("akr-done")) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        Text(stringResource(R.string.akr_done), style = MaterialTheme.typography.titleMedium)
                        if (phase.needsRecovery) {
                            Text(stringResource(R.string.akr_recovery_off), style = MaterialTheme.typography.bodyMedium)
                            FSPrimaryButton(stringResource(R.string.set_up_cloud_recovery), onClick = { nav.navigate("recovery") }, modifier = Modifier.testTag("akr-recovery"))
                        }
                    }
                }
                progress?.let { AccountKeyProgressCard(it, onRetry = { scope.launch { vm.refreshProgress() } }) }
                FSSecondaryButton(stringResource(R.string.done), onClick = { nav.popBackStack("trusted-devices", inclusive = false) })
            }
        }
    }
}

@Composable
private fun Busy(label: String?) {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            label?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("akr-rotating")) }
        }
    }
}

@Composable
private fun Message(text: String, tag: String, onClose: () -> Unit) {
    FSCard(modifier = Modifier.testTag(tag)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
            FSSecondaryButton(stringResource(R.string.done), onClick = onClose)
        }
    }
}

@Composable
private fun Summary(s: RotateAccountKeyViewModel.Phase.Summary, onConfirm: () -> Unit, onCancel: () -> Unit) {
    FSCard(modifier = Modifier.testTag("akr-summary")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            if (s.removedHeldAdminKey) {
                Text(fsString(R.string.akr_admin_first, s.removedName), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("akr-admin-first"))
            }
            Text(stringResource(R.string.akr_summary_others), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.akr_summary_servers), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.akr_summary_kept), style = MaterialTheme.typography.titleSmall)
            for (row in s.kept) {
                val added = row.addedAt?.let { FlagshipDateFormat.format(it) }
                Text(if (added != null) fsString(R.string.akr_kept_row, row.name, added) else row.name, style = MaterialTheme.typography.bodyMedium)
            }
            if (s.excluded.isNotEmpty()) {
                Text(stringResource(R.string.akr_summary_readd), style = MaterialTheme.typography.titleSmall)
                for (row in s.excluded) Text(row.reason ?: row.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("akr-excluded"))
            }
            Text(stringResource(R.string.akr_summary_browsers), style = MaterialTheme.typography.bodyMedium)
            if (s.recoveryOn) Text(stringResource(R.string.akr_summary_recovery), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.akr_summary_backups), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FSPrimaryButton(stringResource(R.string.akr_confirm), onClick = onConfirm, modifier = Modifier.testTag("akr-confirm"))
            FSGhostButton(stringResource(R.string.cancel), onClick = onCancel)
        }
    }
}

/** Devices x/y, servers x/y, and which servers are still on the old key. */
@Composable
fun AccountKeyProgressCard(p: RotateAccountKeyViewModel.Progress, onRetry: () -> Unit) {
    FSCard(modifier = Modifier.testTag("akr-progress")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(stringResource(R.string.akr_progress_title), style = MaterialTheme.typography.titleMedium)
            Text(fsString(R.string.akr_progress_devices, p.devicesUpdated, p.devicesTotal), style = MaterialTheme.typography.bodyMedium)
            Text(fsString(R.string.akr_progress_servers, p.serversOnNewKey, p.serversTotal), style = MaterialTheme.typography.bodyMedium)
            for (name in p.waitingFor) Text(fsString(R.string.akr_progress_waiting, name), style = MaterialTheme.typography.bodySmall)
            for ((name, due) in p.rekeyDue) Text(fsString(R.string.akr_progress_rekey, name, due.joinToString(", ")), style = MaterialTheme.typography.bodySmall)
            if (!p.complete) FSSecondaryButton(stringResource(R.string.retry), onClick = onRetry, modifier = Modifier.testTag("akr-progress-retry"))
        }
    }
}

/** The kept device's calm banner while its new account key waits for an unlock, and once it holds it. */
@Composable
fun AccountKeyBanner() {
    val status by AccountKeyService.status.collectAsState()
    val text = when (status) {
        AccountKeyService.Status.Waiting -> stringResource(R.string.akr_banner_waiting)
        AccountKeyService.Status.Done -> stringResource(R.string.akr_banner_done)
        AccountKeyService.Status.Failed -> stringResource(R.string.akr_banner_failed)
        AccountKeyService.Status.Idle -> return
    }
    Surface(
        color = FS.colors.surface,
        contentColor = FS.colors.text,
        modifier = Modifier.fillMaxWidth().testTag("account-key-banner").semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(4.dp).fillMaxHeight().background(FS.colors.accent))
            Column(Modifier.weight(1f).padding(horizontal = FS.space.s4, vertical = FS.space.s3), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(text, style = MaterialTheme.typography.bodyMedium)
                if (status == AccountKeyService.Status.Done) {
                    FSGhostButton(stringResource(R.string.done), onClick = { AccountKeyService.dismiss() }, modifier = Modifier.testTag("account-key-banner-dismiss"))
                }
            }
        }
    }
}
