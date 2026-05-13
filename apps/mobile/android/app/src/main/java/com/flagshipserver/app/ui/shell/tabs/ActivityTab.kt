// Activity tab: phone-alert feed + unlock-approval queue.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.ui.screens.ActivityScreen
import com.flagshipserver.app.ui.screens.ApproveUnlockScreen
import com.flagshipserver.app.ui.screens.PostRecoveryScreen

@Composable
fun ActivityTab() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "activity") {
        composable("activity") { ActivityScreen(nav) }
        composable("unlock-approvals") { ApproveUnlockScreen(nav) }
        composable("post-recovery") { PostRecoveryScreen(nav) }
    }
}
