// Web-experience gating authorizer screen (docs/service-access-gating.md,
// "Web-experience gating"). Reached from the knock page's
// https://flagshipserver.com/access?... App Link or a pasted "Get link" string. "Open" signs
// the knock against the box (behind the biometric gate) with the key that box
// knows us by (this device's key on our own servers, the share's key on a
// server shared with us, the per-app id elsewhere), then confirms; the
// browser's poll picks up the session and reloads into the app.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
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
                    BiometricAuthority.current()?.ensureFresh(title = "Authorize Flagship", subtitle = reason)
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

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        when (val p = phase) {
            is KnockAuthorizePhase.Done -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text("Signed in", color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                    Text(
                        "Go back to that page: it opens ${svc.ifBlank { "the app" }} on its own." +
                            if (p.browserAgent.isNotBlank()) "\n\nBrowser: ${p.browserAgent}" else "",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
                    )
                    FSPrimaryButton(
                        label = "Done",
                        block = true,
                        large = true,
                        onClick = onDone,
                        modifier = Modifier.semantics { testTag = "knock-authorize-done" },
                    )
                }
            }
            else -> FSCard(padding = PaddingValues(FS.space.s4)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(vm.title, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                    Text(
                        vm.target,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
                        modifier = Modifier.semantics { testTag = "knock-authorize-target" },
                    )
                    Text(
                        "This signs the browser at ${vm.target} in as you. " +
                            "Only do this for a browser you opened yourself.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
                    )
                    val busy = p is KnockAuthorizePhase.Authorizing
                    FSPrimaryButton(
                        label = if (busy) "Signing in…" else "Open",
                        enabled = !busy,
                        block = true,
                        large = true,
                        onClick = { scope.launch { vm.authorize() } },
                        modifier = Modifier.semantics { testTag = "knock-authorize-accept" },
                    )
                    FSSecondaryButton(label = "Cancel", enabled = !busy, block = true, onClick = onDone)
                    (p as? KnockAuthorizePhase.Failed)?.let {
                        Text(
                            it.message,
                            color = FS.colors.danger,
                            style = TextStyle(fontSize = 14.sp),
                            modifier = Modifier.semantics { testTag = "knock-authorize-error" },
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}
