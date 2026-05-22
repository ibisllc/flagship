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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.screens.BiometricSetupScreen
import com.flagshipserver.app.ui.screens.ChooseUsernameScreen
import com.flagshipserver.app.ui.screens.JoinDeviceScreen
import com.flagshipserver.app.ui.screens.OpenAccountScreen
import com.flagshipserver.app.ui.screens.WelcomeScreen
import kotlinx.serialization.json.Json
import java.net.URLDecoder
import java.net.URLEncoder

@Composable
fun OnboardingFlow(onFinished: () -> Unit) {
    val nav = rememberNavController()
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    // Phase 3b — a JoinDevice deeplink (the collaborator followed the
    // admin's App-Links / flagship://join URL via their native camera).
    // Carry the raw sid + pk into the join screen route.
    LaunchedEffect(pending) {
        val link = pending
        if (link is DeepLink.JoinDevice) {
            deepLinker.consume()
            nav.navigate(
                "join-device-link/" +
                    URLEncoder.encode(link.sid, "UTF-8") + "/" +
                    URLEncoder.encode(link.pk, "UTF-8"),
            )
        }
    }
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
        // Phase 3b — cross-device pairing, INCOMING side. Two entries:
        //   join-device            → in-app scanner first (Welcome CTA).
        //   join-device-link/{…}   → arrived via the App-Links deeplink
        //                            (sid + pk already known; skip scan).
        composable("join-device") {
            JoinDeviceScreen(
                initialLink = null,
                onJoined = onFinished,
                onCancel = { nav.popBackStack() },
            )
        }
        composable(
            route = "join-device-link/{sid}/{pk}",
            arguments = listOf(
                navArgument("sid") { type = NavType.StringType },
                navArgument("pk") { type = NavType.StringType },
            ),
        ) { entry ->
            val sid = URLDecoder.decode(entry.arguments?.getString("sid") ?: "", "UTF-8")
            val pk = URLDecoder.decode(entry.arguments?.getString("pk") ?: "", "UTF-8")
            val link = JoinLink.parse("flagship://join?sid=$sid&pk=$pk")
            JoinDeviceScreen(
                initialLink = link,
                onJoined = onFinished,
                onCancel = { nav.popBackStack() },
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

