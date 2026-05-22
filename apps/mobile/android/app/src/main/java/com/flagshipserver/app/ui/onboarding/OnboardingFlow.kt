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
//          single/multi drive the REAL login state machine
//          (RealAccountLoginContainer / LoginViewModel) — Phase 3;
//          unknown renders a clean "no account" state.
// Mirrors FlagshipUI/Onboarding/OnboardingFlow.swift.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.ui.screens.BiometricSetupScreen
import com.flagshipserver.app.ui.screens.ChooseUsernameScreen
import com.flagshipserver.app.ui.screens.OpenAccountScreen
import com.flagshipserver.app.ui.screens.WelcomeScreen
import kotlinx.serialization.json.Json
import java.net.URLDecoder
import java.net.URLEncoder

@Composable
fun OnboardingFlow(onFinished: () -> Unit) {
    val nav = rememberNavController()
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
                username = username,
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
            //   single | multi  → drive the REAL login state machine,
            //                     threading the preflight resolution
            //   unknown         → handled inside the container (state)
            JoinAccountContainer(
                onDemoOpened = onFinished,
                onRecover = { resolution ->
                    // Phase 3 — the real single/multi state machine,
                    // driven entirely off the preflight. The resolution
                    // is JSON-encoded into the nav arg so the takeover
                    // branch reads the resolved username + recovery +
                    // grace without re-resolving.
                    val encoded = URLEncoder.encode(
                        Json.encodeToString(AccountResolution.serializer(), resolution),
                        "UTF-8",
                    )
                    nav.navigate("login/$encoded")
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable(
            route = "login/{resolution}",
            arguments = listOf(navArgument("resolution") { type = NavType.StringType }),
        ) { entry ->
            val raw = URLDecoder.decode(entry.arguments?.getString("resolution") ?: "", "UTF-8")
            val resolution = Json.decodeFromString(AccountResolution.serializer(), raw)
            // Phase 3 — the REAL single/multi login state machine.
            // No-cloud-backup renders a STATE (not a 404); single does a
            // 7-day-grace takeover; multi collects the recovery TOTP /
            // code then a 24h-grace takeover. Both install the recovered
            // UMK + initiate re-pair + label this device "admin" with the
            // resolved username (no "recovered-user" placeholder).
            RealAccountLoginContainer(
                resolution = resolution,
                onOpened = onFinished,
                onBack = { nav.popBackStack() },
            )
        }
    }
}

