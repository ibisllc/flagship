// C12 — privacy preferences (BiometricPrompt at launch).
//
// Mirror of FlagshipUI/Shell/SettingsTab.swift's PrivacyScreen. Today
// the single toggle is "Require biometrics when the app opens".
// Enabling fires a one-time BiometricPrompt evaluation so a bystander
// can't silently arm the trap; disabling doesn't gate (the user is
// already authorized, infinite loop otherwise).

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
import androidx.compose.material3.Switch
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
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun PrivacyScreen(nav: NavController) {
    val privacy = LocalPrivacySettings.current
    val app = LocalAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val enabled = privacy?.requireBiometricAtLaunch?.collectAsState()?.value ?: false
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Privacy",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s6))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                androidx.compose.foundation.layout.Row(
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    modifier = Modifier.padding(end = FS.space.s2),
                ) {
                    Text(
                        "Lock with biometrics",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.padding(end = FS.space.s4),
                    )
                    Switch(
                        checked = enabled,
                        onCheckedChange = { newValue ->
                            errorMsg = null
                            if (newValue) {
                                val activity = ctx as? FragmentActivity
                                if (activity == null) {
                                    errorMsg = "Lost activity context; restart and retry."
                                    return@Switch
                                }
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
                                        errorMsg = "Couldn't enable: ${e.message}"
                                    }
                                }
                            } else {
                                privacy?.setRequireBiometricAtLaunch(false)
                                app.setRequireBiometricAtLaunch(false)
                            }
                        },
                    )
                }
                Text(
                    "When on, Flagship asks for biometrics each time the app launches " +
                        "or comes back from the background. Pods stay running; this just " +
                        "controls who can see and tap.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
                errorMsg?.let { msg ->
                    Text(msg, color = FS.colors.danger, style = TextStyle(fontSize = 12.sp))
                }
            }
        }

        Spacer(Modifier.height(FS.space.s6))
        FSGhostButton(label = "Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s12))
    }
}
