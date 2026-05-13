package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

/**
 * D.4.1 — ApproveUnlockScreen. Push-driven entry point.
 *
 * Surface the request: server FQDN, request origin (IP + Wi-Fi name when
 * available), the box's identity fingerprint. Two actions:
 *   - "Approve with Face ID" (primary)
 *   - "Not me. Block." (ghost-styled danger — never a painted-red button)
 *
 * Auto-approve toggle for trusted networks (24h TTL).
 */
@Composable
fun ApproveUnlockScreen(nav: NavController) {
    var autoApprove by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12),
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Text(
            text = "Unlock your Flagship?",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "Someone just powered on your server at home. Approve to send the unlock key.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                LabelValue("Server", "home.harry.flagship.services", mono = true)
                LabelValue("Requested from", "192.0.2.14 · home Wi-Fi")
                LabelValue("Fingerprint", "4f:9a:7c:b2:01:dd:e8:b1", mono = true, tappable = true)
            }
        }

        androidx.compose.foundation.layout.Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.padding(horizontal = FS.space.s2),
        ) {
            Text(
                text = "Auto-approve from home Wi-Fi for 24h",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp),
            )
            Switch(checked = autoApprove, onCheckedChange = { autoApprove = it })
        }

        Spacer(Modifier.height(FS.space.s4))

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSPrimaryButton(
                label = "Approve with Face ID",
                onClick = { /* TODO: BiometricGate.run + DepositUnlockKey */ },
                block = true,
                large = true,
            )
            FSDangerButton(
                label = "Not me. Block.",
                onClick = { /* TODO: revoke-self order */ },
                block = true,
                large = true,
            )
        }
    }
}

@Composable
private fun LabelValue(label: String, value: String, mono: Boolean = false, tappable: Boolean = false) {
    Column {
        Text(
            text = label,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s1))
        Text(
            text = value + if (tappable) "  ·  tap to verify" else "",
            color = FS.colors.text,
            style = TextStyle(
                fontSize = 16.sp,
                lineHeight = 22.sp,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            ),
        )
    }
}
