// Settings landing. Routes to providers, recovery, paired sessions,
// add-control-device, developer pane.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(nav: NavController) {
    val app = LocalAppState.current
    val dev = LocalDeveloperSettings.current
    val server = LocalFlagshipServerClient.current
    val devUnlocked = dev?.unlocked?.collectAsState()?.value ?: false
    var versionTaps by remember { mutableIntStateOf(0) }
    // C6a — drives the Remove-this-device confirmation dialog.
    var showRemoveConfirm by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val hasRecovery by app.hasCloudRecovery.collectAsState()

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Settings",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            app.currentUser.collectAsState().value ?: "no account",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        Spacer(Modifier.height(FS.space.s6))

        SettingsRow(label = "AI providers", description = "BYO LLM provider keys (Anthropic, OpenAI, Google, Groq, Ollama).") {
            nav.navigate("providers")
        }
        SettingsRow(label = "Trusted devices", description = "Phones and tablets that hold your account keys.") {
            nav.navigate("trusted-devices")
        }
        SettingsRow(label = "Browser sessions", description = "Per-pod browser tabs paired with this account.") {
            nav.navigate("paired-sessions")
        }
        SettingsRow(label = "Add a control device", description = "Pair a browser or tablet with the current account.") {
            nav.navigate("add-control-device")
        }
        SettingsRow(label = "Recovery", description = "Cloud recovery + offline recovery codes.") {
            nav.navigate("recovery")
        }
        if (devUnlocked) {
            SettingsRow(label = "Developer", description = "Toggle the live screens client + dev fixtures.") {
                nav.navigate("developer")
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text(
                    "Flagship Android",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                )
                Text(
                    "v0.0.1 · BUSL-1.1",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                    modifier = Modifier
                        .padding(top = FS.space.s1),
                )
                FSGhostButton(
                    label = if (devUnlocked) "Developer unlocked" else "Tap version to unlock developer",
                    onClick = {
                        versionTaps += 1
                        if (versionTaps >= 3) dev?.setUnlocked(true)
                    },
                )
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // C6a — danger zone. Same UX semantics as iOS SettingsScreen
        // dangerZone(): two-stage confirm, copy adapts based on
        // whether cloud recovery is enrolled. Strictly destructive —
        // revokes the push token on .com AND wipes local Keystore.
        Text(
            "DANGER ZONE",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            if (hasRecovery)
                "Remove this device from your account. You'll need your recovery passkey to come back."
            else
                "Remove this device from your account. ⚠️ You have NO cloud recovery " +
                    "enrolled — this will permanently lose access.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSDangerButton(
            label = "Remove this device from account",
            onClick = { showRemoveConfirm = true },
            block = true,
        )

        if (showRemoveConfirm) {
            AlertDialog(
                onDismissRequest = { showRemoveConfirm = false },
                confirmButton = {
                    TextButton(onClick = {
                        showRemoveConfirm = false
                        scope.launch {
                            // Best-effort push revoke (network failure
                            // tolerated — local wipe still proceeds).
                            val tokenId = Keystore.pushTokenId()
                            if (!tokenId.isNullOrEmpty()) {
                                runCatching { server.revokePushToken(tokenId) }
                            }
                            Keystore.wipe()
                            Keystore.setPushTokenId(null)
                            app.signOut()
                        }
                    }) {
                        Text("Remove this device", color = FS.colors.danger)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showRemoveConfirm = false }) {
                        Text("Cancel")
                    }
                },
                title = {
                    Text(
                        if (hasRecovery) "Remove this device from your account?"
                        else "Permanently remove this device?",
                    )
                },
                text = {
                    Text(
                        if (hasRecovery)
                            "We'll revoke this device's notification access and erase its local keys. " +
                                "Use your recovery passkey to sign in again later."
                        else
                            "You have no cloud recovery on this account. After removal, no other " +
                                "device can take over — your account is gone for good. Set up " +
                                "recovery first if you might want to come back.",
                    )
                },
            )
        }

        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun SettingsRow(label: String, description: String, onClick: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            Text(label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Text(description, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            FSGhostButton(label = "Open", onClick = onClick)
        }
    }
    Spacer(Modifier.height(FS.space.s2))
}
