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
import com.flagshipserver.app.ui.screens.JoinDeviceScreen
import com.flagshipserver.app.ui.screens.KeyfileExportScreen
import java.net.URLDecoder
import java.net.URLEncoder
import com.flagshipserver.app.ui.screens.DeveloperScreen
import com.flagshipserver.app.ui.screens.PairedSessionsScreen
import com.flagshipserver.app.ui.screens.PeerBackupScreen
import com.flagshipserver.app.ui.screens.PrivacyScreen
import com.flagshipserver.app.ui.screens.ProfilesScreen
import com.flagshipserver.app.ui.screens.ProvidersScreen
import com.flagshipserver.app.ui.screens.RecoveryScreen
import com.flagshipserver.app.ui.screens.SettingsScreen
import com.flagshipserver.app.ui.screens.TierStatusScreen
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
        composable("privacy") { PrivacyScreen(nav) }
        composable("profiles") { ProfilesScreen(nav) }
        // P7 — dedicated tier-status / subscription screen.
        composable("tier-status") { TierStatusScreen(nav) }
        // P9 — peer-backup management.
        composable("peer-backup") { PeerBackupScreen(nav) }
    }
}
