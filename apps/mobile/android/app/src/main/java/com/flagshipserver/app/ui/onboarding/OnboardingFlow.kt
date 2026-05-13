// Onboarding flow: Welcome → ChooseUsername → BiometricSetup → CreateServer
// (creates the first pod). Mirrors FlagshipUI/Onboarding/OnboardingFlow.swift.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.SlugUtil
import com.flagshipserver.app.ui.screens.BiometricSetupScreen
import com.flagshipserver.app.ui.screens.BuildCodeScreen
import com.flagshipserver.app.ui.screens.ChooseUsernameScreen
import com.flagshipserver.app.ui.screens.WelcomeScreen
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
