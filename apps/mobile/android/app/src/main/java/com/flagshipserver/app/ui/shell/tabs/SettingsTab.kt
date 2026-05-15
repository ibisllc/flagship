// Settings tab: providers, recovery, paired devices, developer pane.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.ui.screens.AddControlDeviceScreen
import com.flagshipserver.app.ui.screens.DeveloperScreen
import com.flagshipserver.app.ui.screens.PairedSessionsScreen
import com.flagshipserver.app.ui.screens.ProvidersScreen
import com.flagshipserver.app.ui.screens.RecoveryScreen
import com.flagshipserver.app.ui.screens.SettingsScreen
import com.flagshipserver.app.ui.screens.TrustedDevicesScreen

@Composable
fun SettingsTab() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "settings-root") {
        composable("settings-root") { SettingsScreen(nav) }
        composable("trusted-devices") { TrustedDevicesScreen(nav) }
        composable("paired-sessions") { PairedSessionsScreen(nav) }
        composable("add-control-device") { AddControlDeviceScreen(nav) }
        composable("recovery") { RecoveryScreen(nav) }
        composable("developer") { DeveloperScreen(nav) }
        composable("providers") { ProvidersScreen(nav) }
    }
}
