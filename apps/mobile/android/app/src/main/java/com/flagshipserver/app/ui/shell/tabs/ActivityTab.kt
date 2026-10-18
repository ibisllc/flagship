// Activity tab: phone-alert feed + the Server approvals section.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.screens.ActivityScreen
import com.flagshipserver.app.ui.screens.AuditLogScreen
import com.flagshipserver.app.ui.screens.PostRecoveryScreen

@Composable
fun ActivityTab() {
    val nav = rememberNavController()
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    // The approvals are a section of Activity: a push or link for one opens it.
    var openApprovals by remember { mutableIntStateOf(0) }
    LaunchedEffect(pending) {
        when (val link = pending) {
            DeepLink.SecretRequests -> {
                deepLinker.consume()
                nav.popBackStack("activity", inclusive = false)
                openApprovals++
            }
            DeepLink.AccountActivity -> {
                deepLinker.consume()
                nav.popBackStack("activity", inclusive = false)
                nav.navigate("audit-log")
            }
            else -> { /* not for this tab */ }
        }
    }
    NavHost(navController = nav, startDestination = "activity",
        enterTransition = com.flagshipserver.app.ui.theme.FSMotion.enter,
        exitTransition = com.flagshipserver.app.ui.theme.FSMotion.exit,
        popEnterTransition = com.flagshipserver.app.ui.theme.FSMotion.popEnter,
        popExitTransition = com.flagshipserver.app.ui.theme.FSMotion.popExit,
    ) {
        composable("activity") { ActivityScreen(nav, openApprovalsSignal = openApprovals) }
        composable("post-recovery") { PostRecoveryScreen(nav) }
        // P5 — full-page audit-log viewer reached from the Activity feed.
        composable("audit-log") { AuditLogScreen(nav) }
    }
}
