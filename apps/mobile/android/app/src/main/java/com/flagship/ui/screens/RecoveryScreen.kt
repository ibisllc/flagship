// Recovery management. Two phases:
//   - Configure: pick passkey-PRF cloud recovery (CredentialManager) or
//     offline 10-word codes. Mirrors iOS Recovery.swift.
//   - Restore: paste 10-word codes / pick a passkey to fetch the
//     wrapped UMK from /api/recovery/fetch.
//
// CredentialManager + Block Store integration is left as a hook —
// production wiring lives in a follow-up keystore task.

package com.flagship.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSField
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPrimaryButton
import com.flagship.ui.theme.FS

private enum class RecoveryMode { Choose, Passkey, Codes, Restore }

@Composable
fun RecoveryScreen(nav: NavController) {
    var mode by remember { mutableStateOf(RecoveryMode.Choose) }
    var codes by remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Recovery",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "If you lose this phone, you can recover your account on a new device using one of these mechanisms.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        when (mode) {
            RecoveryMode.Choose -> {
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text("Cloud recovery (passkey)", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                        Text(
                            "Wraps your master key with a passkey held by Google Password Manager (or iCloud Keychain if you cross-sign). Most convenient.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                        FSPrimaryButton(label = "Set up passkey", onClick = { mode = RecoveryMode.Passkey })
                    }
                }
                Spacer(Modifier.height(FS.space.s3))
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text("Offline codes", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                        Text(
                            "Generate ten BIP39 words you copy to paper / a password manager. Belt-and-suspenders alongside the passkey.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                        FSGhostButton(label = "Generate codes", onClick = { mode = RecoveryMode.Codes })
                        FSGhostButton(label = "Restore from codes", onClick = { mode = RecoveryMode.Restore })
                    }
                }
            }
            RecoveryMode.Passkey -> {
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column {
                        Text("Passkey recovery", color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                        Text(
                            "CredentialManager flow lands here. We'll create a discoverable passkey with PRF and wrap the UMK under the derived secret.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                        FSGhostButton(label = "Back", onClick = { mode = RecoveryMode.Choose })
                    }
                }
            }
            RecoveryMode.Codes -> {
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Text(
                            "Your recovery words",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                        )
                        Text(
                            "Write these down somewhere safe. Anyone with the words and your username can take over your account.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp),
                        )
                        Text(
                            "word-one word-two word-three word-four word-five " +
                                "word-six word-seven word-eight word-nine word-ten",
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                        )
                        FSGhostButton(label = "Done", onClick = { mode = RecoveryMode.Choose })
                    }
                }
            }
            RecoveryMode.Restore -> {
                FSCard(padding = PaddingValues(FS.space.s4)) {
                    Column {
                        FSField(value = codes, onValueChange = { codes = it }, label = "10 recovery words")
                        Spacer(Modifier.height(FS.space.s2))
                        FSPrimaryButton(label = "Restore", onClick = { mode = RecoveryMode.Choose })
                        FSGhostButton(label = "Cancel", onClick = { mode = RecoveryMode.Choose })
                    }
                }
            }
        }
    }
}
