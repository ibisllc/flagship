// Services tab: list of installed services + marketplace + vibe-code launcher.

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
import com.flagshipserver.app.ui.screens.ServiceEnvScreen
import com.flagshipserver.app.ui.screens.ServicesListScreen
import com.flagshipserver.app.ui.screens.MarketplaceListScreen
import com.flagshipserver.app.ui.screens.MarketplaceDetailScreen
import com.flagshipserver.app.ui.screens.AiKeyStepScreen
import com.flagshipserver.app.ui.screens.BuildGitScreen
import com.flagshipserver.app.ui.screens.BuildJournalScreen
import com.flagshipserver.app.ui.screens.BuildMcpScreen
import com.flagshipserver.app.ui.screens.BuildSourceChooserScreen
import com.flagshipserver.app.ui.screens.VibeCodeProviderPickScreen
import com.flagshipserver.app.ui.screens.VibeCodeDescribeScreen
import com.flagshipserver.app.ui.screens.VibeCodeGeneratingScreen
import com.flagshipserver.app.ui.screens.VibeCodeChatScreen
import com.flagshipserver.app.viewmodels.PendingBuildCredential
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
            // W10 — the `vibecode-needs-you` push deep-links here so the AI's
            // mid-build question (talkToUser / requestEnvVar) opens the chat.
            // Mirror iOS's guard: don't re-push if we're already on it.
            is DeepLink.VibeCodeChat -> {
                deepLinker.consume()
                val route = "vibe-code-chat/${link.sessionId}"
                if (nav.currentDestination?.route != "vibe-code-chat/{sessionId}") {
                    nav.navigate(route)
                }
            }
            // A tap on the ops sliver for a git/mcp build opens its journal —
            // the build's own surface (it has no vibe-code chat session).
            is DeepLink.BuildJournal -> {
                deepLinker.consume()
                nav.navigate("build/journal/${link.buildId}")
            }
            DeepLink.Marketplace -> {
                deepLinker.consume()
                nav.navigate("marketplace")
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
        // W10 — per-app env-var KV editor, reachable from the detail screen's
        // "Configure environment" row. serviceId = "<creator>-<slug>"; split at
        // the FIRST '-' (creator is hyphen-free) for the ServiceEnvScreen args.
        composable("service-env/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            val dashIdx = id.indexOf('-')
            val creator = if (dashIdx > 0) id.substring(0, dashIdx) else ""
            val slug = if (dashIdx > 0) id.substring(dashIdx + 1) else id
            ServiceEnvScreen(nav, appId = id, creator = creator, slug = slug)
        }
        composable("marketplace") { MarketplaceListScreen(nav) }
        composable("marketplace-detail/{creator}/{slug}") { entry ->
            val creator = entry.arguments?.getString("creator") ?: return@composable
            val slug = entry.arguments?.getString("slug") ?: return@composable
            MarketplaceDetailScreen(nav, creator = creator, slug = slug)
        }
        composable("build/source") { BuildSourceChooserScreen(nav) }
        composable("build/git") { BuildGitScreen(nav) }
        // AI-key step for the git-adapt path. On confirm it stows the chosen
        // credential and pops back to the git screen, whose onAppear takes it
        // off PendingBuildCredential and runs the adapt pass with it.
        composable("build/git/key") {
            AiKeyStepScreen(
                onConfirm = { cred ->
                    PendingBuildCredential.set(cred)
                    nav.popBackStack()
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable("build/mcp") { BuildMcpScreen(nav) }
        composable("build/journal") { BuildJournalScreen(nav) }
        composable("build/journal/{buildId}") { entry ->
            val bid = entry.arguments?.getString("buildId") ?: return@composable
            BuildJournalScreen(nav, buildId = bid)
        }
        composable("vibe/provider") { VibeCodeProviderPickScreen(nav) }
        // AI-key step for the from-scratch path. On confirm it stows the
        // in-memory credential and continues to the describe screen, which
        // hands it to the box's model when the build starts.
        composable("vibe/key") {
            AiKeyStepScreen(
                onConfirm = { cred ->
                    PendingBuildCredential.set(cred)
                    nav.navigate("vibe/describe") {
                        popUpTo("vibe/key") { inclusive = true }
                    }
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable("vibe/describe") { VibeCodeDescribeScreen(nav) }
        composable("vibe/generating/{sessionId}") { entry ->
            val sid = entry.arguments?.getString("sessionId") ?: return@composable
            VibeCodeGeneratingScreen(nav, sessionId = sid)
        }
        // W10 — vibe-code chat surface (talkToUser / requestEnvVar replies).
        // Reached from the `vibecode-needs-you` push deep link, and from the
        // generating screen's Interrupt (a follow-up reply to the live build).
        composable("vibe-code-chat/{sessionId}") { entry ->
            val sid = entry.arguments?.getString("sessionId") ?: return@composable
            VibeCodeChatScreen(nav, sessionId = sid)
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
