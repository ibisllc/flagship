// Web-experience gating authorizer screen (docs/service-access-gating.md,
// "Web-experience gating"). Reached from the knock page's
// https://flagshipserver.com/access?... App Link or a pasted "Get link" string. "Open" signs
// the knock against the box (behind the biometric gate) with the key that box
// knows us by (this device's key on our own servers, the share's key on a
// server shared with us, the per-app id elsewhere), then confirms; the
// browser's poll picks up the session and reloads into the app.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSecretMailboxClient
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.KnockAuthorizePhase
import com.flagshipserver.app.viewmodels.KnockAuthorizeViewModel
import kotlinx.coroutines.launch

/**
 * @param onDone invoked when the user dismisses the screen (Done / Cancel).
 */
@Composable
fun KnockAuthorizeScreen(
    serverId: String,
    svc: String,
    serviceRef: String,
    pageId: String,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val appState = LocalAppState.current
    val mailbox = LocalSecretMailboxClient.current
    val shares = com.flagshipserver.app.viewmodels.LocalServerShares.current
    val vm = remember(serverId, svc, serviceRef, pageId) {
        KnockAuthorizeViewModel(
            serverId = serverId,
            svc = svc,
            serviceRef = serviceRef,
            pageId = pageId,
            deviceKey = { reason ->
                val user = appState.currentUser.value
                val deviceId = appState.activeProfile?.deviceId?.lowercase()?.takeIf { Regex("^[0-9a-f]{32}$").matches(it) }
                if (user.isNullOrEmpty() || deviceId == null || !Keystore.hasUmkSeed()) {
                    null
                } else {
                    BiometricAuthority.current()?.ensureFresh(title = FSStrings.get(R.string.authorize_flagship), subtitle = reason)
                    val umk = Keystore.currentUmkSeed()
                    Keystore.accountDeviceSigner(umk, user, deviceId) to Keystore.accountDevicePublicKey(umk, user, deviceId)
                }
            },
            sharedServers = { fetch ->
                val rt = shares
                when {
                    rt == null -> emptyList()
                    fetch -> rt.client.inbox().map { it.serverDomain to it.shareId }
                    else -> rt.sharedWithMe.ui.value.items.map { it.entry.serverDomain to it.entry.shareId }
                }
            },
            ownServers = { appState.pods.value.map { it.fqdn } },
            reloadOwnServers = {
                val user = appState.currentUser.value
                if (user.isNullOrEmpty()) emptyList()
                else mailbox.fetchPods(user).pods.filter { it.revokedAt == null }.map { it.serverDomain }
            },
        )
    }
    val phase by vm.phase.collectAsState()

    FSScreen(title = stringResource(R.string.open_app), onBack = onDone) {
        when (val p = phase) {
            is KnockAuthorizePhase.Done -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
                        Text(stringResource(R.string.signed_in), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                    }
                    Text(
                        fsString(R.string.go_back_to_that_page_it, svc.ifBlank { stringResource(R.string.the_app) }) +
                            if (p.browserAgent.isNotBlank()) "\n\nBrowser: ${p.browserAgent}" else "",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    FSPrimaryButton(
                        label = stringResource(R.string.done),
                        block = true,
                        large = true,
                        onClick = onDone,
                        modifier = Modifier.semantics { testTag = "knock-authorize-done" },
                    )
                }
            }
            else -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(vm.title, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge)
                    Text(
                        vm.target,
                        color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.semantics { testTag = "knock-authorize-target" },
                    )
                    Text(
                        fsString(R.string.this_signs_the_browser_at_in, vm.target),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    val busy = p is KnockAuthorizePhase.Authorizing
                    FSPrimaryButton(
                        label = if (busy) stringResource(R.string.signing_in) else stringResource(R.string.open_2),
                        enabled = !busy,
                        block = true,
                        large = true,
                        onClick = { scope.launch { vm.authorize() } },
                        modifier = Modifier.semantics { testTag = "knock-authorize-accept" },
                    )
                    FSSecondaryButton(label = stringResource(R.string.cancel), enabled = !busy, block = true, onClick = onDone)
                    (p as? KnockAuthorizePhase.Failed)?.let {
                        Text(
                            it.message,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.semantics { testTag = "knock-authorize-error" },
                        )
                    }
                }
            }
        }
    }
}
