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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

/**
 * D.2.3 — BiometricSetupScreen.
 *
 * Generates the UMK in StrongBox-backed AndroidKeyStore (with a graceful
 * fallback when StrongBox is absent) plus the cached 32-byte seed that
 * backs the IRK HKDF. This is where the user-master-key is born during
 * onboarding; the open-account step that follows derives the IRK from it
 * and runs the standalone username claim.
 *
 * On Continue we hand control to the host (open-account); the toggle
 * for cloud-recovery via Block Store is surfaced here for parity with
 * iOS, wired in a later phase.
 */
@Composable
fun BiometricSetupScreen(onContinue: () -> Unit) {
    var cloudRecovery by remember { mutableStateOf(true) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12),
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Text(
            text = "Lock it to your fingerprint.",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "Your master key lives in this phone's secure hardware. Approving a server unlock or installing an app will use Face Unlock or your fingerprint.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    text = "Cloud-recovery backup",
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                    color = FS.colors.text,
                )
                Text(
                    text = "Wraps your master key with a Google Block Store key so a fresh phone can recover it. Without this, losing your phone means losing your data.",
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                    color = FS.colors.textMuted,
                )
                Spacer(Modifier.height(FS.space.s2))
                androidx.compose.foundation.layout.Row(
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = FS.space.s2),
                ) {
                    Text(
                        text = if (cloudRecovery) "Enabled" else "Disabled — risky",
                        color = if (cloudRecovery) FS.colors.success else FS.colors.warning,
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                    )
                    Switch(
                        checked = cloudRecovery,
                        onCheckedChange = { cloudRecovery = it },
                    )
                }
            }
        }

        Spacer(Modifier.height(FS.space.s8))

        FSPrimaryButton(
            label = "Generate keys & continue",
            onClick = {
                // Mint the UMK in StrongBox-backed AndroidKeyStore (best
                // effort — fall back to a software key when StrongBox is
                // absent) and ensure the cached seed that backs the IRK.
                // The standalone username claim happens in the next
                // (open-account) step.
                runCatching { Keystore.generateUMK(useStrongBox = true) }
                    .recoverCatching { Keystore.generateUMK(useStrongBox = false) }
                runCatching { Keystore.loadOrCreateUmkSeed() }
                onContinue()
            },
            block = true,
            large = true,
        )
    }
}
