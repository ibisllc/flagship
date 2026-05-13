// Settings tab: providers, recovery, paired devices, developer pane.

package com.flagship.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagship.ui.screens.AddControlDeviceScreen
import com.flagship.ui.screens.DeveloperScreen
import com.flagship.ui.screens.PairedSessionsScreen
import com.flagship.ui.screens.RecoveryScreen
import com.flagship.ui.screens.SettingsScreen

@Composable
fun SettingsTab() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "settings-root") {
        composable("settings-root") { SettingsScreen(nav) }
        composable("paired-sessions") { PairedSessionsScreen(nav) }
        composable("add-control-device") { AddControlDeviceScreen(nav) }
        composable("recovery") { RecoveryScreen(nav) }
        composable("developer") { DeveloperScreen(nav) }
    }
}
