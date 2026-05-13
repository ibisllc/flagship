// Apps tab: list of installed apps + marketplace + vibe-code launcher.

package com.flagshipserver.app.ui.shell.tabs

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.ui.screens.AppDetailScreen
import com.flagshipserver.app.ui.screens.AppsListScreen
import com.flagshipserver.app.ui.screens.MarketplaceListScreen
import com.flagshipserver.app.ui.screens.MarketplaceDetailScreen
import com.flagshipserver.app.ui.screens.VibeCodeProviderPickScreen
import com.flagshipserver.app.ui.screens.VibeCodeDescribeScreen
import com.flagshipserver.app.ui.screens.VibeCodeGeneratingScreen

@Composable
fun AppsTab() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "apps-list") {
        composable("apps-list") { AppsListScreen(nav) }
        composable("app-detail/{appId}") { entry ->
            val id = entry.arguments?.getString("appId") ?: return@composable
            AppDetailScreen(nav, appId = id)
        }
        composable("marketplace") { MarketplaceListScreen(nav) }
        composable("marketplace-detail/{creator}/{slug}") { entry ->
            val creator = entry.arguments?.getString("creator") ?: return@composable
            val slug = entry.arguments?.getString("slug") ?: return@composable
            MarketplaceDetailScreen(nav, creator = creator, slug = slug)
        }
        composable("vibe/provider") { VibeCodeProviderPickScreen(nav) }
        composable("vibe/describe") { VibeCodeDescribeScreen(nav) }
        composable("vibe/generating/{sessionId}") { entry ->
            val sid = entry.arguments?.getString("sessionId") ?: return@composable
            VibeCodeGeneratingScreen(nav, sessionId = sid)
        }
    }
}
