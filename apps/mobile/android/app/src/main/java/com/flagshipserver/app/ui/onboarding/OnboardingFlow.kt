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
            RecoverFromWelcomeContainer(
                onComplete = { choice, _seed ->
                    // v1: mark paired with an empty pod list — a
                    // follow-up commit alongside C4's /devices client
                    // resolves the actual username + pod set. The
                    // recovered seed isn't persisted yet
                    // (Keystore.installUMK lands separately, mirror
                    // of the iOS TODO).
                    val user = "recovered-user"
                    app.completeOnboarding(username = user, pods = emptyList())
                    // Replace handling: the IRK rotation lands in C7.
                    @Suppress("UNUSED_EXPRESSION") choice
                    onFinished()
                },
                onBack = { nav.popBackStack() },
            )
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

