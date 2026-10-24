// "Quick approve from watch" on Settings → Account security, the twin of
// iOS's "Quick approve from Apple Watch" (docs/watch-delegate-key-design.md
// §4). Default off. On mints this device's boot-approval-only delegate key and
// has the account key attest it (one biometric); off revokes it. The Wear OS
// app's Approve works only while it is on.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Watch
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.WatchDelegatePhase
import com.flagshipserver.app.viewmodels.WatchDelegateViewModel
import kotlinx.coroutines.launch

@Composable
fun WatchQuickApproveCard(server: FlagshipServerClient, app: AppState) {
    val vm: WatchDelegateViewModel = viewModel(
        key = "watch-delegate",
        factory = viewModelFactory {
            initializer { WatchDelegateViewModel(server = server, username = { app.currentUser.value }) }
        },
    )
    val phase by vm.phase.collectAsState()
    val enabled by vm.isEnabled.collectAsState()
    val expiresAt by vm.expiresAt.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.load() }
    val mailbox = com.flagshipserver.app.core.LocalSecretMailboxClient.current
    val bootVm = androidx.compose.runtime.remember(mailbox) {
        com.flagshipserver.app.viewmodels.WatchBootViewModel(
            optIn = com.flagshipserver.app.core.WatchBootOptIn(
                mailbox = mailbox,
                irk = com.flagshipserver.app.keystore.KeystoreIrkAccess(),
                store = com.flagshipserver.app.keystore.KeystoreWatchBootKeys(),
            ),
            delegatePubHex = { com.flagshipserver.app.keystore.Keystore.watchDelegatePubHex() },
        )
    }
    val pods by app.pods.collectAsState()

    FSCard(padding = PaddingValues(0.dp)) {
        Column {
            FSRow(
                title = stringResource(R.string.quick_approve_from_watch),
                icon = Icons.Outlined.Watch,
                trailing = {
                    Switch(
                        checked = enabled,
                        onCheckedChange = { want ->
                            scope.launch {
                                if (want) {
                                    vm.enable()
                                } else {
                                    bootVm.disableAll(pods.associate { it.fqdn.lowercase() to it.name })
                                    vm.disable()
                                    bootVm.reload()
                                }
                            }
                        },
                        enabled = phase != WatchDelegatePhase.Enabling && phase != WatchDelegatePhase.Disabling,
                        modifier = Modifier.testTag("watch-delegate-toggle"),
                    )
                },
            )
            Column(
                verticalArrangement = Arrangement.spacedBy(FS.space.s2),
                modifier = Modifier.padding(start = FS.space.s4, end = FS.space.s4, bottom = FS.space.s4),
            ) {
                Text(
                    stringResource(R.string.approve_a_server_boot_from_your),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                val exp = expiresAt
                if (enabled && exp != null) {
                    Text(
                        fsString(R.string.active_renews_by, FlagshipDateFormat.format(exp)),
                        color = FS.colors.success,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("watch-delegate-active"),
                    )
                }
                if (enabled && exp != null) {
                    WatchBootServers(bootVm, pods.filter { !it.isRevoked && it.fqdn.isNotEmpty() && it.status != com.flagshipserver.app.core.PodInfo.Status.PENDING }, exp)
                }
                (phase as? WatchDelegatePhase.Failed)?.let {
                    Text(
                        it.message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.testTag("watch-delegate-failed-msg"),
                    )
                }
            }
        }
    }
}

/** Per server: let the watch approve its start-up while this phone is locked. */
@Composable
private fun WatchBootServers(
    vm: com.flagshipserver.app.viewmodels.WatchBootViewModel,
    pods: List<com.flagshipserver.app.core.PodInfo>,
    delegateExpiresAt: Long,
) {
    val copies by vm.copies.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val scope = rememberCoroutineScope()
    if (pods.isEmpty()) return
    Spacer(Modifier.height(FS.space.s2))
    Text(
        stringResource(R.string.watch_boot_title),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.testTag("watch-boot-title"),
    )
    Text(
        stringResource(R.string.watch_boot_explainer),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium,
    )
    pods.forEach { pod ->
        val domain = pod.fqdn.lowercase()
        val until = copies[domain]
        val tag = pod.name.lowercase().replace(Regex("[^a-z0-9-]"), "-")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(pod.name, style = MaterialTheme.typography.bodyLarge)
                if (until != null) {
                    Text(
                        fsString(R.string.watch_boot_until, FlagshipDateFormat.format(until)),
                        color = FS.colors.success,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("watch-boot-until-$tag"),
                    )
                }
            }
            Switch(
                checked = until != null,
                onCheckedChange = { want -> scope.launch { vm.set(pod.fqdn, pod.name, want, delegateExpiresAt) } },
                enabled = busy == null,
                modifier = Modifier.testTag("watch-boot-toggle-$tag"),
            )
        }
    }
    error?.let {
        Text(
            it,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("watch-boot-error"),
        )
    }
}
