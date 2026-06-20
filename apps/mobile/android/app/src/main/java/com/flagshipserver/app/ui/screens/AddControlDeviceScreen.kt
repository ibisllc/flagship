// Add a control-device (browser / tablet). The control device shows a QR
// carrying its server's FQDN; the phone scans it, then on confirm signs an
// owner-IRK `add-paired-session` order for that pod and POSTs it to the box's
// /api/orders-from-user — the same primitive iOS PodPairViewModel + the
// webapp lib/podPair.js use. On 200 the daemon stores the fresh token as the
// x-flagship-session paired-session token.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AddControlDevicePhase
import com.flagshipserver.app.viewmodels.AddControlDeviceViewModel
import kotlinx.coroutines.launch

@Composable
fun AddControlDeviceScreen(nav: NavController) {
    val toasts = LocalToastCenter.current
    val store = LocalSessionStore.current
    val scope = rememberCoroutineScope()
    val vm = remember { AddControlDeviceViewModel(store = store) }
    val phase by vm.phase.collectAsState()
    var scanned by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(phase) {
        when (val p = phase) {
            is AddControlDevicePhase.Paired -> toasts.success("Device paired.")
            is AddControlDevicePhase.AlreadyPaired ->
                toasts.info("This device is already paired with a server.")
            is AddControlDevicePhase.Failed -> toasts.error(p.message)
            else -> {}
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Add a control device",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "On the device you're pairing, open flagshipserver.com/webapp → Settings → Add this device. Then scan its QR here.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))
        if (scanned == null) {
            QRScanner(onScanned = { code ->
                scanned = code
                toasts.success("Captured pairing QR.")
            })
        } else {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Column {
                    Text(
                        "Captured",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        scanned!!.take(80) + if (scanned!!.length > 80) "…" else "",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                    Spacer(Modifier.height(FS.space.s3))
                    val busy = phase is AddControlDevicePhase.Signing ||
                        phase is AddControlDevicePhase.Posting
                    FSPrimaryButton(
                        label = when (phase) {
                            is AddControlDevicePhase.Signing -> "Approving…"
                            is AddControlDevicePhase.Posting -> "Pairing…"
                            else -> "Pair this device"
                        },
                        onClick = {
                            if (!busy) {
                                val code = scanned ?: return@FSPrimaryButton
                                scope.launch { vm.send(code) }
                            }
                        },
                        enabled = !busy,
                        block = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("add-control-pair"),
                    )
                    Spacer(Modifier.height(FS.space.s2))
                    FSGhostButton(label = "Scan again", onClick = { scanned = null }, enabled = !busy)
                }
            }
        }
    }
}
