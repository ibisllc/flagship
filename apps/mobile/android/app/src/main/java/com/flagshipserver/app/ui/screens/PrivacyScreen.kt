// C12 — privacy preferences (BiometricPrompt at launch).
//
// Mirror of FlagshipUI/Shell/SettingsTab.swift's PrivacyScreen. Today
// the single toggle is "Require biometrics when the app opens".
// Enabling fires a one-time BiometricPrompt evaluation so a bystander
// can't silently arm the trap; disabling doesn't gate (the user is
// already authorized, infinite loop otherwise).

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.UserErrorText
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Password
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPrivacySettings
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.BiometricGate
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun PrivacyScreen(nav: NavController) {
    val privacy = LocalPrivacySettings.current
    val app = LocalAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val enabled = privacy?.requireBiometricAtLaunch?.collectAsState()?.value ?: false
    val passphraseEnabled = privacy?.requirePassphraseAtLaunch?.collectAsState()?.value ?: false
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val onBiometricChange: (Boolean) -> Unit = { newValue ->
        errorMsg = null
        if (newValue) {
            val activity = ctx as? FragmentActivity
            if (activity == null) {
                errorMsg = "Lost activity context; restart and retry."
            } else {
                scope.launch {
                    try {
                        BiometricGate.evaluate(
                            activity = activity,
                            title = "Enable biometric lock",
                            subtitle = "Confirm to enable",
                        )
                        privacy?.setRequireBiometricAtLaunch(true)
                        app.setRequireBiometricAtLaunch(true)
                        app.markUnlocked() // user just authed
                    } catch (_: BiometricCancelled) {
                        // No-op — user backed out.
                    } catch (e: Throwable) {
                        errorMsg = "Couldn't enable. ${UserErrorText.of(e)}"
                    }
                }
            }
        } else {
            privacy?.setRequireBiometricAtLaunch(false)
            app.setRequireBiometricAtLaunch(false)
        }
    }

    FSScreen(title = "Privacy", onBack = { nav.popBackStack() }) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSGroup(header = "Lock the app") {
                FSRow(
                    title = "Lock with biometrics",
                    icon = Icons.Outlined.Fingerprint,
                    onClick = { onBiometricChange(!enabled) },
                    trailing = { Switch(checked = enabled, onCheckedChange = onBiometricChange) },
                )
            }
            Explainer(
                "On by default. Flagship asks for biometrics each time the app " +
                    "launches or comes back from the background, so you stay signed " +
                    "in without re-entering your passphrase. Turn it off to open " +
                    "straight in. Either way your servers stay running; this just " +
                    "controls who can see and tap.",
            )
            errorMsg?.let { msg ->
                Text(
                    msg,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = FS.space.s4),
                )
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSGroup(header = "Require your passphrase") {
                FSRow(
                    title = "Sign in with your passphrase every time",
                    icon = Icons.Outlined.Password,
                    onClick = { privacy?.setRequirePassphraseAtLaunch(!passphraseEnabled) },
                    trailing = {
                        Switch(
                            checked = passphraseEnabled,
                            onCheckedChange = { newValue ->
                                privacy?.setRequirePassphraseAtLaunch(newValue)
                            },
                        )
                    },
                )
            }
            Explainer(
                "Off by default. When on, Flagship doesn't keep you signed in — " +
                    "each launch needs a full sign-in with your account passphrase, " +
                    "not just biometrics. The strongest option, and the slowest.",
            )
        }
    }
}

@Composable
private fun Explainer(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(horizontal = FS.space.s4),
    )
}
