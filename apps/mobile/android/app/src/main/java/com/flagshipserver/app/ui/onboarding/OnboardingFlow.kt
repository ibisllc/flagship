// Onboarding flow:
//   Welcome
//     ├─ Create your account → ChooseUsername → Biometric → CreateServer
//     └─ I already have an account → RecoverFromWelcome (C3 wires the
//                                    real WebAuthn-PRF flow; C1 ships
//                                    a placeholder)
// Mirrors FlagshipUI/Onboarding/OnboardingFlow.swift.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.SlugUtil
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.screens.BiometricSetupScreen
import com.flagshipserver.app.ui.screens.BuildCodeScreen
import com.flagshipserver.app.ui.screens.ChooseUsernameScreen
import com.flagshipserver.app.ui.screens.WelcomeScreen
import com.flagshipserver.app.ui.theme.FS
import java.util.UUID

@Composable
fun OnboardingFlow(onFinished: () -> Unit) {
    val nav = rememberNavController()
    val app = LocalAppState.current
    NavHost(navController = nav, startDestination = "welcome") {
        composable("welcome") { WelcomeScreen(nav) }
        composable("username") { ChooseUsernameScreen(nav) }
        composable("biometric") { BiometricSetupScreen(nav) }
        composable("create-first") {
            // BuildCodeScreen is the existing first-server stub on
            // Android; in production this gets replaced by the QR-relay
            // CreateServer flow.
            BuildCodeScreen(nav)
        }
        composable("recover") {
            // Phase C3 wires the real WebAuthn-PRF + PostRecoveryChoice
            // here. C1 lays the placeholder so the navigation graph
            // compiles + the Welcome CTA has somewhere to land.
            RecoverFromWelcomeStub(onBack = { nav.popBackStack() })
        }
        composable("done") {
            val user = app.currentUser.value ?: "you"
            val slug = SlugUtil.slugify(user)
            app.completeOnboarding(
                username = user,
                pods = listOf(
                    PodInfo(
                        podId = "pod-" + UUID.randomUUID().toString().take(6),
                        name = "home",
                        fqdn = "home.$slug.flagship.services",
                        status = PodInfo.Status.ONLINE,
                    ),
                ),
            )
            onFinished()
        }
    }
}

/**
 * Placeholder for the WebAuthn-PRF recovery branch. C3 replaces this
 * with the real CredentialManager flow + PostRecoveryChoice screen.
 * Kept here so the navigation graph compiles after the PodPair
 * deletion lands without dangling references.
 */
@Composable
private fun RecoverFromWelcomeStub(onBack: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            text = "Recover your account",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "Authenticate with your passkey to bring this device into your existing Flagship account. You can choose whether to keep your other devices working or replace a lost one.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "Back", onClick = onBack, block = true)
    }
}
