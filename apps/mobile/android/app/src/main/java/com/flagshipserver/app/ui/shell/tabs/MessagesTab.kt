// The Social tab (docs/social-tab.md): your voi.ci page, edited in place, and the conversations people start on it.
// The destination keeps its internal id `messages` (deep links `messages` and `page-editor`, push routing, the gym).

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
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.screens.PostEditorScreen
import com.flagshipserver.app.ui.screens.SignedInSitesScreen
import com.flagshipserver.app.ui.screens.SocialScreen
import com.flagshipserver.app.ui.screens.SocialSection
import com.flagshipserver.app.ui.screens.ThreadScreen

@Composable
fun MessagesTab() {
    val nav = rememberNavController()
    val deepLinker = LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()
    LaunchedEffect(pending) {
        when (val link = pending) {
            is DeepLink.Messages -> {
                deepLinker.consume()
                nav.popBackStack("messages", inclusive = false)
                SocialSection.current.value = SocialSection.MESSAGES
                link.conv?.let { nav.navigate("thread/$it") }
            }
            DeepLink.PageEditor -> {
                deepLinker.consume()
                nav.popBackStack("messages", inclusive = false)
                SocialSection.current.value = SocialSection.PROFILE
            }
            else -> { /* not for this tab */ }
        }
    }
    NavHost(navController = nav, startDestination = "messages",
        enterTransition = com.flagshipserver.app.ui.theme.FSMotion.enter,
        exitTransition = com.flagshipserver.app.ui.theme.FSMotion.exit,
        popEnterTransition = com.flagshipserver.app.ui.theme.FSMotion.popEnter,
        popExitTransition = com.flagshipserver.app.ui.theme.FSMotion.popExit,
    ) {
        composable("messages") { SocialScreen(nav) }
        composable("thread/{conv}", arguments = listOf(navArgument("conv") { type = NavType.StringType })) { e ->
            ThreadScreen(nav, e.arguments?.getString("conv").orEmpty())
        }
        composable("post/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType })) { e ->
            PostEditorScreen(nav, e.arguments?.getString("id").orEmpty())
        }
        composable("signed-in-sites") { SignedInSitesScreen(nav) }
    }
}
