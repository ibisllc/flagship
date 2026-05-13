// Developer pane. Live-client toggle, mock latency slider, raw push
// tokenId display. Visible only after the user 3-taps the version
// row on Settings.

package com.flagship.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.core.LocalDeveloperSettings
import com.flagship.keystore.Keystore
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.theme.FS

@Composable
fun DeveloperScreen(nav: NavController) {
    val dev = LocalDeveloperSettings.current
    val useLive by (dev?.useLiveClient?.collectAsState() ?: return)
    val latency by dev.mockLatencyMs.collectAsState()

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Developer",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Use live ScreensClient", color = FS.colors.text)
                        Text("Off uses MockScreensClient.", color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                    }
                    Switch(checked = useLive, onCheckedChange = { dev.setUseLiveClient(it) })
                }
                Spacer(Modifier.height(FS.space.s2))
                Text("Mock latency: ${latency}ms", color = FS.colors.text)
                Slider(
                    value = latency.toFloat(),
                    onValueChange = { dev.setMockLatencyMs(it.toInt()) },
                    valueRange = 0f..1500f,
                )
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text("Push tokenId", color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium))
                Text(
                    Keystore.pushTokenId() ?: "(not registered)",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                )
            }
        }
    }
}
