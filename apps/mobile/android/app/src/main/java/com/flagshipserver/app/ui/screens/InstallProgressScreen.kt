// Live install progress — subscribes to the SSE install-events stream
// and renders each step inline (Registered → Boot → TunnelOnline →
// CertIssued → Ready).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.InstallEvent
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.flow.collectLatest

@Composable
fun InstallProgressScreen(
    serial: String,
    onFinish: (resolvedFqdn: String?) -> Unit,
) {
    val client = LocalScreensClient.current
    val events = remember { mutableStateListOf<InstallEvent>() }
    var resolvedFqdn by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(serial) {
        client.installEvents(serial).collectLatest { event ->
            events.add(event)
            if (event is InstallEvent.Ready) {
                resolvedFqdn = event.serverFqdn
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Provisioning",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Watching the new box come online. Don't put your phone away — it's almost done.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 15.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (events.isEmpty()) {
                    Text("Waiting for first event…", color = FS.colors.textMuted)
                }
                events.forEach { event ->
                    val (label, kind) = when (event) {
                        is InstallEvent.Registered -> "Registered with .com" to FSPillKind.Provisioning
                        is InstallEvent.Boot -> "Booted" to FSPillKind.Provisioning
                        is InstallEvent.TunnelOnline -> "Tunnel online" to FSPillKind.Provisioning
                        is InstallEvent.CertIssued -> "TLS cert issued" to FSPillKind.Renewing
                        is InstallEvent.Ready -> "Ready: ${event.serverFqdn}" to FSPillKind.Online
                        is InstallEvent.Failed -> "Failed: ${event.reason}" to FSPillKind.Offline
                    }
                    FSPill(label, kind = kind)
                }
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        FSGhostButton(
            label = if (resolvedFqdn != null) "Continue" else "Run in background",
            onClick = { onFinish(resolvedFqdn) },
            block = true,
        )
    }
}
