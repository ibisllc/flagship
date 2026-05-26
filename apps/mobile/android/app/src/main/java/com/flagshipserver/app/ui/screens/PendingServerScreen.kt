// Pending server placeholder. Shown while a box that just received its
// signed install blob hasn't phoned home yet. The Cancel-order button
// hands back to the caller to revoke the auth-code on .com (the
// container in HomeTab handles the network call + AppState mutation).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.AuthCodeRevoke as AuthCodeRevokeBytes
import com.flagshipserver.app.core.ReleaseServerName as ReleaseServerNameBytes
import com.flagshipserver.app.api.AuthCodeRevokeRequest
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun PendingServerScreen(pod: PodInfo, onCancel: () -> Unit) {
    val flagshipServer = LocalFlagshipServerClient.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            pod.name,
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        FSPill("Pending", kind = FSPillKind.Provisioning)
        Spacer(Modifier.height(FS.space.s4))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text(
                    "We've delivered the signed install blob to the browser, but the new box hasn't phoned home yet. Plug in the USB, power on, and watch this screen flip to Online.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    "Subdomain: ${pod.fqdn}",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                )
                if (pod.pendingAuthCodeSerial != null) {
                    Text(
                        "Auth-code serial: ${pod.pendingAuthCodeSerial}",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                }
            }
        }
        Spacer(Modifier.height(FS.space.s6))
        FSGhostButton(
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
                        val irk = Keystore.deriveIRK("Cancel server ${pod.name}")
                        val now = System.currentTimeMillis()
                        // 1. Release the name. serverDomain =
                        // <server>.<user>.flagship.services, held on the pod
                        // as its fqdn.
                        val releaseBytes = ReleaseServerNameBytes.canonicalBytes(username, pod.fqdn, now)
                        val releaseSig = HexUtil.encode(irk.sign(releaseBytes))
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
        )
    }
}
