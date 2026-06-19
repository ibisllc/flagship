// Settings tab: providers, recovery, paired devices, developer pane.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.screens.AccountSecurityScreen
import com.flagshipserver.app.ui.screens.AddControlDeviceScreen
import com.flagshipserver.app.ui.screens.AddDeviceScreen
import com.flagshipserver.app.ui.screens.CompanionDockScreen
import com.flagshipserver.app.ui.screens.CompanionRequestsScreen
import com.flagshipserver.app.ui.screens.JoinDeviceScreen
import com.flagshipserver.app.ui.screens.KeyfileExportScreen
import java.net.URLDecoder
import java.net.URLEncoder
import com.flagshipserver.app.ui.screens.AiKeysManagerScreen
import com.flagshipserver.app.ui.screens.DeveloperScreen
import com.flagshipserver.app.ui.screens.PairedSessionsScreen
import com.flagshipserver.app.ui.screens.PeerBackupScreen
import com.flagshipserver.app.ui.screens.PrivacyScreen
import com.flagshipserver.app.ui.screens.ProcessUrlScreen
import com.flagshipserver.app.ui.screens.ProfilesScreen
import com.flagshipserver.app.ui.screens.SecuredSessionsScreen
import com.flagshipserver.app.ui.screens.ProvidersScreen
import com.flagshipserver.app.ui.screens.RecoveryScreen
import com.flagshipserver.app.ui.screens.ReplaceDeviceFinalizeScreen
import com.flagshipserver.app.ui.screens.SettingsScreen
import com.flagshipserver.app.ui.screens.TrustedDevicesScreen

@Composable
fun SettingsTab() {
    val nav = rememberNavController()
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    // Consume DeepLink.RecoverySetup when it lands on this tab. The
    // RootShell already routed the user to .settings; we just push
    // onto the local nav stack here.
    LaunchedEffect(pending) {
        if (pending == DeepLink.RecoverySetup) {
            deepLinker.consume()
            nav.navigate("recovery")
        }
        // Phase 3b — a JoinDevice deeplink that lands here (already paired
        // ⇒ adding a 2nd profile). Route into the incoming join surface.
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
    NavHost(navController = nav, startDestination = "settings-root") {
        composable("settings-root") { SettingsScreen(nav) }
        composable("trusted-devices") { TrustedDevicesScreen(nav) }
        // H5 — Replace-device FINALIZE (24h grace countdown + Complete).
        // Reached when initiate returns Pending OR from the M4 banner's
        // "Finalize now"; carries the server-reported completesAt (Unix ms).
        composable(
            route = "replace-finalize/{completesAt}",
            arguments = listOf(navArgument("completesAt") { type = NavType.LongType }),
        ) { entry ->
            val completesAt = entry.arguments?.getLong("completesAt") ?: 0L
            ReplaceDeviceFinalizeScreen(nav, completesAt = completesAt)
        }
        // Phase 3b — admin cross-device pairing (Add device).
        composable("add-device") {
            AddDeviceScreen(
                onDone = { nav.popBackStack("trusted-devices", inclusive = false) },
                onCancel = { nav.popBackStack() },
            )
        }
        // Phase 3b — incoming join via App-Links deeplink while paired
        // (adds a 2nd profile to this phone).
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
                onJoined = { nav.popBackStack("settings-root", inclusive = false) },
                onCancel = { nav.popBackStack() },
            )
        }
        composable("account-security") { AccountSecurityScreen(nav) }
        composable("paired-sessions") { PairedSessionsScreen(nav) }
        composable("add-control-device") { AddControlDeviceScreen(nav) }
        composable("recovery") { RecoveryScreen(nav) }
        composable("keyfile-export") { KeyfileExportScreen(nav) }
        composable("developer") { DeveloperScreen(nav) }
        composable("providers") { ProvidersScreen(nav) }
        composable("ai-keys") { AiKeysManagerScreen(nav) }
        composable("privacy") { PrivacyScreen(nav) }
        composable("profiles") { ProfilesScreen(nav) }
        // Web-experience gating — the browser QR-logins this phone authorized.
        composable("secured-sessions") { SecuredSessionsScreen(nav) }
        // Web-experience gating — paste a flagship://access link / "Get link".
        composable("process-url") { ProcessUrlScreen(nav) }
        // The authorize target ProcessUrl hands off to (same route shape as the
        // ServicesTab deep-link target; svc is an optional query arg).
        composable(
            route = "knock-authorize/{server}/{ref}/{page}?svc={svc}",
            arguments = listOf(
                navArgument("server") { type = NavType.StringType },
                navArgument("ref") { type = NavType.StringType },
                navArgument("page") { type = NavType.StringType },
                navArgument("svc") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val server = URLDecoder.decode(entry.arguments?.getString("server") ?: "", "UTF-8")
            val ref = URLDecoder.decode(entry.arguments?.getString("ref") ?: "", "UTF-8")
            val page = URLDecoder.decode(entry.arguments?.getString("page") ?: "", "UTF-8")
            val svc = URLDecoder.decode(entry.arguments?.getString("svc") ?: "", "UTF-8")
            com.flagshipserver.app.ui.screens.KnockAuthorizeScreen(
                serverId = server,
                svc = svc,
                serviceRef = ref,
                pageId = page,
                onDone = { nav.popBackStack() },
            )
        }
        // P9 — peer-backup management.
        composable("peer-backup") { PeerBackupScreen(nav) }
        // P14 — companion-dock (dock a browser).
        composable("companion-dock") { CompanionDockScreen(nav) }
        // P14 Phase 2 — companion-requests inbox.
        composable("companion-requests") { CompanionRequestsScreen(nav) }
    }
}
