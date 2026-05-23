// Activity tab: phone-alert feed + unlock-approval queue.

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
import com.flagshipserver.app.ui.screens.ActivityScreen
import com.flagshipserver.app.ui.screens.ApproveUnlockScreen
import com.flagshipserver.app.ui.screens.PostRecoveryScreen
import com.flagshipserver.app.ui.screens.SecretRequestsScreen

@Composable
fun ActivityTab() {
    val nav = rememberNavController()
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    LaunchedEffect(pending) {
        when (val link = pending) {
            is DeepLink.UnlockApprove -> {
                deepLinker.consume()
                nav.navigate("unlock-approvals")
            }
            DeepLink.SecretRequests -> {
                deepLinker.consume()
                nav.navigate("secret-requests")
            }
            else -> { /* not for this tab */ }
        }
    }
    NavHost(navController = nav, startDestination = "activity") {
        composable("activity") { ActivityScreen(nav) }
        composable("unlock-approvals") { ApproveUnlockScreen(nav) }
        composable("secret-requests") { SecretRequestsScreen(nav) }
        composable("post-recovery") { PostRecoveryScreen(nav) }
    }
}
