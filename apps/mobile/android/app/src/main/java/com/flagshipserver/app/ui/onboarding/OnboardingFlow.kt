// Onboarding flow:
//   Welcome
//     ├─ Create your account → ChooseUsername → Biometric → OpenAccount
//     │     (Phase 2: open the ACCOUNT — ensure UMK + standalone username
//     │      claim + name this device → Home with ZERO servers + an
//     │      "add your first server" CTA. A server is a separate, later,
//     │      repeatable resource added from Home; the claim no longer
//     │      rides inside CreateServer's registerControlPlane.)
//     └─ Connect to an existing account → ConnectAccountScreen, one page:
//          join with a pairing code (scan, or paste a code or link) →
//          JoinDeviceScreen; or sign in with the account name (username-first
//          resolveAccount preflight) → demo opens the sandbox directly;
//          single/multi drive the REAL login state machine
//          (RealAccountLoginContainer / LoginViewModel) — Phase 3;
//          unknown renders a clean "no account" state.
// Mirrors FlagshipUI/Onboarding/OnboardingFlow.swift.

package com.flagshipserver.app.ui.onboarding

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.flagshipserver.app.core.Base64URL
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
import com.flagshipserver.app.ui.screens.SuggestUsernameScreen
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
    // "Create a new account" on the account-removed screen lands on the create step.
    LaunchedEffect(Unit) {
        if (com.flagshipserver.app.core.AccountGone.consumeCreateNext()) nav.navigate("username")
    }
    val pending by deepLinker.pending.collectAsState()
    // Phase 3b — a JoinDevice deeplink (the collaborator followed the
    // admin's https://flagshipserver.com/join App Link via their native camera).
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
    // Edge-to-edge (Android 15+): the root pads only the top and sides, so
    // every onboarding screen keeps clear of the navigation bar (and the
    // keyboard) here.
    Box(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
    ) {
    NavHost(navController = nav, startDestination = "welcome",
        enterTransition = com.flagshipserver.app.ui.theme.FSMotion.enter,
        exitTransition = com.flagshipserver.app.ui.theme.FSMotion.exit,
        popEnterTransition = com.flagshipserver.app.ui.theme.FSMotion.popEnter,
        popExitTransition = com.flagshipserver.app.ui.theme.FSMotion.popExit,
    ) {
        composable("welcome") { WelcomeScreen(nav) }
        composable("username") {
            // CREATE path. Picking a username opens the ACCOUNT, not a
            // server — thread the chosen handle forward to the
            // biometric + open-account steps.
            SuggestUsernameScreen(
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
            //
            // CREATE path only: openAccount() ALSO arms the SKIPPABLE
            // "Secure your account" backup nudge, which AppRoot renders as
            // a full-screen overlay ABOVE the freshly-mounted shell until
            // the user backs up or skips. (The recovery / "I already have
            // an account" path never arms it, so it never sees the step.)
            OpenAccountScreen(
                username = username,
                onOpened = onFinished,
                onBack = { nav.popBackStack() },
            )
        }
        // Phase 3b — cross-device pairing, INCOMING side. Two entries:
        //   join-device            → in-app scanner first (Scan a code).
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
            val link = JoinLink.parse("https://${JoinLink.HOST}${JoinLink.PATH}?sid=$sid&pk=$pk")
            JoinDeviceScreen(
                initialLink = link,
                onJoined = onFinished,
                onCancel = { nav.popBackStack() },
            )
        }
        composable("connect") {
            // One page, both ways in. Sign in by name: resolveAccount
            // branches —
            //   demo            → device attached + sandbox open → done
            //   single | multi  → drive the REAL login state machine,
            //                     threading the preflight resolution
            //   unknown         → an inline state on the page
            // Join with a pairing code: the incoming JoinDeviceScreen (the
            // scanner, or straight in with a pasted link).
            ConnectAccountScreen(
                onDemoOpened = onFinished,
                onJoin = { link ->
                    if (link == null) {
                        nav.navigate("join-device")
                    } else {
                        nav.navigate(
                            "join-device-link/" +
                                URLEncoder.encode(link.sid, "UTF-8") + "/" +
                                URLEncoder.encode(Base64URL.encode(link.adminPubKey), "UTF-8"),
                        )
                    }
                },
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
            // 3-day-grace takeover; multi collects the recovery TOTP /
            // code then a 24h-grace takeover. Both install the recovered
            // UMK + initiate re-pair, opening the account with the
            // resolved username (no "recovered-user" placeholder).
            RealAccountLoginContainer(
                resolution = resolution,
                onOpened = onFinished,
                onBack = { nav.popBackStack() },
            )
        }
    }
    }
}
