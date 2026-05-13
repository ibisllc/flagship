// Pending server placeholder. Shown while a box that just received its
// signed install blob hasn't phoned home yet. The Cancel-order button
// hands back to the caller to revoke the auth-code on .com (the
// container in HomeTab handles the network call + AppState mutation).

package com.flagship.ui.screens

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
import com.flagship.core.HexUtil
import com.flagship.core.LocalAppState
import com.flagship.core.LocalFlagshipServerClient
import com.flagship.core.LocalToastCenter
import com.flagship.core.PodInfo
import com.flagship.core.AuthCodeRevoke as AuthCodeRevokeBytes
import com.flagship.api.AuthCodeRevokeRequest
import com.flagship.keystore.Keystore
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.theme.FS
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
                    val serial = pod.pendingAuthCodeSerial
                    val username = app.currentUser.value
                    if (serial != null && username != null) {
                        try {
                            val irk = Keystore.deriveIRK("Cancel order for ${pod.name}")
                            val now = System.currentTimeMillis()
                            val canonical = AuthCodeRevokeBytes.canonicalBytes(serial, username, now)
                            val sig = HexUtil.encode(irk.sign(canonical))
                            flagshipServer.revokeAuthCode(
                                AuthCodeRevokeRequest(
                                    request = AuthCodeRevokeRequest.Inner(
                                        serial = serial, username = username, issuedAt = now,
                                    ),
                                    signature = sig,
                                ),
                            )
                            toasts.success("Order cancelled.")
                        } catch (_: Throwable) {
                            toasts.warning("Couldn't reach .com — local pod will be dropped anyway.")
                        }
                    }
                    onCancel()
                }
            },
            block = true,
        )
    }
}
