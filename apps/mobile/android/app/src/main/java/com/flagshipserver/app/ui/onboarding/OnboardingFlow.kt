// Onboarding flow:
//   Welcome
//     ├─ Create your account → ChooseUsername → Biometric → OpenAccount
//     │     (Phase 2: open the ACCOUNT — ensure UMK + standalone username
//     │      claim + name this device → Home with ZERO servers + an
//     │      "add your first server" CTA. A server is a separate, later,
//     │      repeatable resource added from Home; the claim no longer
//     │      rides inside CreateServer's registerControlPlane.)
//     └─ I already have an account → JoinAccountContainer (username-first
//          resolveAccount preflight) → demo opens the sandbox directly;
//          single/multi hand off to the WebAuthn-PRF recovery flow;
//          unknown renders a clean "no account" state.
// Mirrors FlagshipUI/Onboarding/OnboardingFlow.swift.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.ui.screens.BiometricSetupScreen
import com.flagshipserver.app.ui.screens.ChooseUsernameScreen
import com.flagshipserver.app.ui.screens.OpenAccountScreen
import com.flagshipserver.app.ui.screens.WelcomeScreen
import java.net.URLDecoder
import java.net.URLEncoder

@Composable
fun OnboardingFlow(onFinished: () -> Unit) {
    val nav = rememberNavController()
    val app = LocalAppState.current
    NavHost(navController = nav, startDestination = "welcome") {
        composable("welcome") { WelcomeScreen(nav) }
        composable("username") {
            // CREATE path. Picking a username opens the ACCOUNT, not a
            // server — thread the chosen handle forward to the
            // biometric + open-account steps.
            ChooseUsernameScreen(
                onContinue = { username ->
                    nav.navigate("biometric/" + URLEncoder.encode(username, "UTF-8"))
                },
            )
        }
        composable(
            route = "biometric/{username}",
            arguments = listOf(navArgument("username") { type = NavType.StringType }),
        ) { entry ->
            val username = URLDecoder.decode(entry.arguments?.getString("username") ?: "", "UTF-8")
            BiometricSetupScreen(
                onContinue = {
                    nav.navigate("open-account/" + URLEncoder.encode(username, "UTF-8"))
                },
            )
        }
        composable(
            route = "open-account/{username}",
            arguments = listOf(navArgument("username") { type = NavType.StringType }),
        ) { entry ->
            val username = URLDecoder.decode(entry.arguments?.getString("username") ?: "", "UTF-8")
            // Phase 2 — ensure UMK + STANDALONE username claim + name this
            // device, then completeOnboarding with EMPTY pods. AppState
            // flips isPaired ⇒ the shell swaps to Home (zero-server empty
            // state). The server is added later from Home.
            OpenAccountScreen(
                username = username,
                onOpened = onFinished,
                onBack = { nav.popBackStack() },
            )
        }
        composable("recover") {
            // Username-first Join. resolveAccount branches:
            //   demo            → device attached + sandbox open → done
            //   single | multi  → push the existing WebAuthn-PRF flow
            //   unknown         → handled inside the container (state)
            JoinAccountContainer(
                onDemoOpened = onFinished,
                onRecover = { _resolution ->
                    // Phase 1 hands single/multi to the existing
                    // recovery flow; Phase 3 replaces it with the real
                    // state machine driven by `_resolution`.
                    nav.navigate("recover-webauthn")
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable("recover-webauthn") {
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
    }
}

