// Services tab: list of installed services + vibe-code launcher.

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
import com.flagshipserver.app.ui.screens.ServiceDetailScreen
import com.flagshipserver.app.ui.screens.ServicesListScreen
import com.flagshipserver.app.ui.screens.BuildGitScreen
import com.flagshipserver.app.ui.screens.BuildJournalScreen
import com.flagshipserver.app.ui.screens.BuildMcpScreen
import com.flagshipserver.app.ui.screens.BuildSourceChooserScreen
import com.flagshipserver.app.ui.screens.VibeCodeProviderPickScreen
import com.flagshipserver.app.ui.screens.VibeCodeDescribeScreen
import com.flagshipserver.app.ui.screens.VibeCodeGeneratingScreen
import com.flagshipserver.app.ui.screens.BrowserTabsScreen
import com.flagshipserver.app.ui.screens.BrowserViewerScreen
import com.flagshipserver.app.ui.screens.InviteIssueScreen
import com.flagshipserver.app.ui.screens.InviteManageScreen

@Composable
fun ServicesTab() {
    val nav = rememberNavController()
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    LaunchedEffect(pending) {
        when (val link = pending) {
            is DeepLink.AppDetail -> {
                deepLinker.consume()
                nav.navigate("app-detail/${link.appId}")
            }
            else -> { /* not for this tab */ }
        }
    }
    NavHost(navController = nav, startDestination = "apps-list") {
        composable("apps-list") { ServicesListScreen(nav) }
        composable("app-detail/{appId}") { entry ->
            val id = entry.arguments?.getString("appId") ?: return@composable
            ServiceDetailScreen(nav, serviceId = id)
        }
        composable("build/source") { BuildSourceChooserScreen(nav) }
        composable("build/git") { BuildGitScreen(nav) }
        composable("build/mcp") { BuildMcpScreen(nav) }
        composable("build/journal") { BuildJournalScreen(nav) }
        composable("build/journal/{buildId}") { entry ->
            val bid = entry.arguments?.getString("buildId") ?: return@composable
            BuildJournalScreen(nav, buildId = bid)
        }
        composable("vibe/provider") { VibeCodeProviderPickScreen(nav) }
        composable("vibe/describe") { VibeCodeDescribeScreen(nav) }
        composable("vibe/generating/{sessionId}") { entry ->
            val sid = entry.arguments?.getString("sessionId") ?: return@composable
            VibeCodeGeneratingScreen(nav, sessionId = sid)
        }
        composable("browser-tabs/{serviceId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            BrowserTabsScreen(nav, serviceId = sid)
        }
        composable("browser-viewer/{serviceId}/{tabId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            val tid = entry.arguments?.getString("tabId") ?: return@composable
            BrowserViewerScreen(nav, serviceId = sid, tabId = tid)
        }
        composable("invite-manage/{serviceId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            InviteManageScreen(nav, serviceId = sid)
        }
        composable("invite-issue/{serviceId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            InviteIssueScreen(nav, serviceId = sid)
        }
    }
}
