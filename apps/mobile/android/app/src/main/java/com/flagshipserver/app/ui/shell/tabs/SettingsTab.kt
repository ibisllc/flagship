// Settings tab: providers, recovery, paired devices, developer pane.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.screens.AccountSecurityScreen
import com.flagshipserver.app.ui.screens.AddControlDeviceScreen
import com.flagshipserver.app.ui.screens.DeveloperScreen
import com.flagshipserver.app.ui.screens.PairedSessionsScreen
import com.flagshipserver.app.ui.screens.PrivacyScreen
import com.flagshipserver.app.ui.screens.ProvidersScreen
import com.flagshipserver.app.ui.screens.RecoveryScreen
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
    }
    NavHost(navController = nav, startDestination = "settings-root") {
        composable("settings-root") { SettingsScreen(nav) }
        composable("trusted-devices") { TrustedDevicesScreen(nav) }
        composable("account-security") { AccountSecurityScreen(nav) }
        composable("paired-sessions") { PairedSessionsScreen(nav) }
        composable("add-control-device") { AddControlDeviceScreen(nav) }
        composable("recovery") { RecoveryScreen(nav) }
        composable("developer") { DeveloperScreen(nav) }
        composable("providers") { ProvidersScreen(nav) }
        composable("privacy") { PrivacyScreen(nav) }
    }
}
