// Services tab: list of installed services + vibe-code launcher.

package com.flagshipserver.app.ui.shell.tabs

import kotlinx.coroutines.launch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.flagshipserver.app.core.DeepLink
import com.flagshipserver.app.core.LocalDeepLinker
import com.flagshipserver.app.ui.screens.AccessListScreen
import com.flagshipserver.app.ui.screens.AppDatabaseScreen
import com.flagshipserver.app.ui.screens.AppDbQueryScreen
import com.flagshipserver.app.ui.screens.AppDbTableScreen
import com.flagshipserver.app.ui.screens.ServiceDetailScreen
import com.flagshipserver.app.ui.screens.accessListRoute
import com.flagshipserver.app.ui.screens.ServiceEnvScreen
import com.flagshipserver.app.ui.screens.ServicesListScreen
import com.flagshipserver.app.ui.screens.AiKeyStepScreen
import com.flagshipserver.app.ui.screens.BuildGitScreen
import com.flagshipserver.app.ui.screens.BuildJournalScreen
import com.flagshipserver.app.ui.screens.BuildMcpScreen
import com.flagshipserver.app.ui.screens.BuildSourceChooserScreen
import com.flagshipserver.app.ui.screens.EditDescribeScreen
import com.flagshipserver.app.ui.screens.EditService
import com.flagshipserver.app.ui.screens.EditServiceScreen
import com.flagshipserver.app.ui.screens.VibeCodeProviderPickScreen
import com.flagshipserver.app.ui.screens.VibeCodeDescribeScreen
import com.flagshipserver.app.ui.screens.VibeCodeGeneratingScreen
import com.flagshipserver.app.ui.screens.VibeCodeChatScreen
import com.flagshipserver.app.viewmodels.PendingBuildCredential
import com.flagshipserver.app.ui.screens.BrowserTabsScreen
import com.flagshipserver.app.ui.screens.BrowserViewerScreen
import com.flagshipserver.app.ui.screens.InviteAcceptScreen
import com.flagshipserver.app.ui.screens.InviteRedeemScreen
import com.flagshipserver.app.ui.screens.KnockAuthorizeScreen
import com.flagshipserver.app.ui.screens.ServiceAccessScreen

@Composable
fun ServicesTab() {
    val nav = rememberNavController()
    val placement = remember { PlacementNavState() }
    val deepLinker = LocalDeepLinker.current
    val appState = com.flagshipserver.app.core.LocalAppState.current
    val podClients = com.flagshipserver.app.core.LocalPodClients.current
    val toasts = com.flagshipserver.app.core.LocalToastCenter.current
    val chatScope = androidx.compose.runtime.rememberCoroutineScope()
    val pending by deepLinker.pending.collectAsState()
    LaunchedEffect(pending) {
        when (val link = pending) {
            is DeepLink.AppDetail -> {
                deepLinker.consume()
                nav.navigateOnPod("app-detail/${link.appId}", link.podId)
            }
            is DeepLink.AccessList -> {
                deepLinker.consume()
                nav.navigateOnPod("app-detail/${link.serviceId}", link.podId)
                nav.navigate(accessListRoute(link.serviceId, draft = link.draft))
            }
            // "Create app here" on a server's page: the creation flow, pinned
            // to that server (docs/app-placement.md §3).
            is DeepLink.CreateApp -> {
                deepLinker.consume()
                nav.navigateOnPod(BUILD_CHOOSER_ROUTE, link.podId, pinned = true)
            }
            // Home's "Build a service" quick action.
            DeepLink.StartBuild -> {
                deepLinker.consume()
                nav.navigate(BUILD_CHOOSER_ROUTE)
            }
            // W10 — the `vibecode-needs-you` push deep-links here so the AI's
            // mid-build question (talkToUser / requestEnvVar) opens the chat.
            // Mirror iOS's guard: don't re-push if we're already on it.
            is DeepLink.VibeCodeChat -> {
                deepLinker.consume()
                // Consuming the link restarts this effect (its key changed), which
                // would cancel a lookup that waits on the boxes: run it on its own.
                chatScope.launch {
                    val onIt = nav.currentDestination?.route == "vibe-code-chat/{sessionId}" &&
                        nav.currentBackStackEntry?.arguments?.getString("sessionId") == link.sessionId
                    // Open it on the server the alert came from (it 404s anywhere
                    // else). A server this device doesn't know, or none: ask the
                    // current server, then every other one it has a session on.
                    if (!onIt) {
                        val pods = appState.pods.value
                        val known = link.server?.let { s -> pods.firstOrNull { it.fqdn.equals(s, ignoreCase = true) } }
                        val pod = known ?: run {
                            val usable = pods.filter { !it.isRevoked && it.fqdn.isNotEmpty() && podClients.screens(it) != null }
                            val fqdn = com.flagshipserver.app.core.SessionServerFinder.find(
                                link.sessionId,
                                first = listOf(appState.currentPod?.fqdn),
                                more = { usable.map { it.fqdn } },
                                probe = { f ->
                                    val p = usable.firstOrNull { it.fqdn.equals(f, ignoreCase = true) } ?: return@find false
                                    val screens = podClients.screens(p) ?: return@find false
                                    screens.vibeCodeSessionState(link.sessionId)
                                    true
                                },
                            )
                            if (fqdn == null) {
                                toasts.error(com.flagshipserver.app.core.SessionServerFinder.NOT_FOUND)
                                nav.openBuildSessions()
                                return@launch
                            }
                            pods.firstOrNull { it.fqdn.equals(fqdn, ignoreCase = true) }
                        }
                        nav.openVibeSession(vibeSessionChatRoute(link.sessionId), pod?.podId)
                    }
                }
            }
            // A tap on the ops sliver for a git/mcp build opens its journal —
            // the build's own surface (it has no vibe-code chat session).
            is DeepLink.BuildJournal -> {
                deepLinker.consume()
                nav.navigate("build/journal/${link.buildId}")
            }
            // #92 — friend redeem of a service-access invite. server + secret
            // are URL-encoded into the route (the secret is 64-hex; the host is
            // DNS-safe, but encode both for safety).
            is DeepLink.RedeemInvite -> {
                deepLinker.consume()
                val s = java.net.URLEncoder.encode(link.serverDomain, "UTF-8")
                val k = java.net.URLEncoder.encode(link.secretHex, "UTF-8")
                val a = java.net.URLEncoder.encode(link.authorAidHex.orEmpty(), "UTF-8")
                val i = java.net.URLEncoder.encode(link.inviteIdHex.orEmpty(), "UTF-8")
                val r = java.net.URLEncoder.encode(link.serviceRef.orEmpty(), "UTF-8")
                nav.navigate("invite-redeem/$s/$k?a=$a&i=$i&s=$r")
            }
            // Web-experience gating — authorize a browser's QR-login for a
            // restricted service's website. All four params URL-encoded into
            // the route (svc may be empty).
            is DeepLink.AuthorizeKnock -> {
                deepLinker.consume()
                val srv = java.net.URLEncoder.encode(link.serverId, "UTF-8")
                // svc may be empty (apex service); an empty path segment breaks
                // route matching, so carry it as a query arg instead.
                val svc = java.net.URLEncoder.encode(link.svc, "UTF-8")
                val ref = java.net.URLEncoder.encode(link.serviceRef, "UTF-8")
                val pg = java.net.URLEncoder.encode(link.pageId, "UTF-8")
                nav.navigate("knock-authorize/$srv/$ref/$pg?svc=$svc")
            }
            // A friend's acceptance reply: approve it on the box it names.
            is DeepLink.AcceptInvite -> {
                deepLinker.consume()
                nav.navigate("invite-accept?reply=${java.net.URLEncoder.encode(link.rawLink, "UTF-8")}")
            }
            else -> { /* not for this tab */ }
        }
    }
    NavHost(navController = nav, startDestination = "apps-list",
        enterTransition = com.flagshipserver.app.ui.theme.FSMotion.enter,
        exitTransition = com.flagshipserver.app.ui.theme.FSMotion.exit,
        popEnterTransition = com.flagshipserver.app.ui.theme.FSMotion.popEnter,
        popExitTransition = com.flagshipserver.app.ui.theme.FSMotion.popExit,
    ) {
        composable("apps-list") { ServicesListScreen(nav) }
        composable(
            route = "service-access-list/{serviceId}?draft={draft}",
            arguments = listOf(
                navArgument("serviceId") { type = NavType.StringType },
                navArgument("draft") { type = NavType.BoolType; defaultValue = false },
            ),
        ) { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                AccessListScreen(nav, serviceId = id, fromDraft = entry.arguments?.getBoolean("draft") == true)
            }
        }
        // The owner's Database section (docs/app-apis.md §6): the app's
        // stores and tables, one table's rows, and Run SQL.
        composable("app-db/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                AppDatabaseScreen(nav, serviceId = id)
            }
        }
        composable(
            route = "app-db/{serviceId}/table?store={store}&table={table}",
            arguments = listOf(
                navArgument("serviceId") { type = NavType.StringType },
                navArgument("store") { type = NavType.StringType; defaultValue = "" },
                navArgument("table") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                val store = entry.arguments?.getString("store").orEmpty()
                val table = entry.arguments?.getString("table").orEmpty()
                AppDbTableScreen(nav, serviceId = id, store = store, table = table)
            }
        }
        composable(
            route = "app-db/{serviceId}/query?store={store}",
            arguments = listOf(
                navArgument("serviceId") { type = NavType.StringType },
                navArgument("store") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                AppDbQueryScreen(nav, serviceId = id, store = entry.arguments?.getString("store").orEmpty())
            }
        }
        // The link field's "I own it": the domain proof for a voi.ci name, then back.
        composable("name-dibs-link/{name}") { entry ->
            com.flagshipserver.app.ui.screens.NameDibsScreen(
                kind = com.flagshipserver.app.viewmodels.NameDibsViewModel.KIND_LINK,
                presetName = entry.arguments?.getString("name").orEmpty(),
                onDone = { nav.popBackStack() },
            )
        }
        composable("app-detail/{appId}") { entry ->
            val id = entry.arguments?.getString("appId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                ServiceDetailScreen(nav, serviceId = id)
            }
        }
        // W10 — per-app env-var KV editor, reachable from the detail screen's
        // "Configure environment" row. serviceId = "<creator>--<slug>"; split on
        // the `--` delimiter (both halves may carry single dashes —
        // docs/service-addressing-double-dash.md) for the ServiceEnvScreen args.
        composable("service-env/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                val delimIdx = id.indexOf("--")
                val creator = if (delimIdx > 0) id.substring(0, delimIdx) else ""
                val slug = if (delimIdx > 0) id.substring(delimIdx + 2) else id
                ServiceEnvScreen(nav, appId = id, creator = creator, slug = slug)
            }
        }
        // "Edit this service": the chooser, then either the AI-key step and
        // "What should change?" or the IDE screen building from its code.
        composable("edit-service/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                EditServiceScreen(nav, serviceId = id)
            }
        }
        composable("edit/key/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                AiKeyStepScreen(
                    onConfirm = { cred ->
                        PendingBuildCredential.set(cred)
                        nav.navigate(EditService.describeRoute(id)) {
                            popUpTo(EditService.keyRoute(id)) { inclusive = true }
                        }
                    },
                    onBack = { nav.popBackStack() },
                )
            }
        }
        composable("edit/describe/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                EditDescribeScreen(nav, serviceId = id)
            }
        }
        composable("edit/mcp/{serviceId}") { entry ->
            val id = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                BuildMcpScreen(nav, editServiceId = id)
            }
        }
        composable(BUILD_CHOOSER_ROUTE) { entry -> PodScoped(nav, placement, entry, creation = true) { BuildSourceChooserScreen(nav) } }
        composable("build/git") { entry -> PodScoped(nav, placement, entry, creation = true) { BuildGitScreen(nav) } }
        // AI-key step for the git-adapt path. On confirm it stows the chosen
        // credential and pops back to the git screen, whose onAppear takes it
        // off PendingBuildCredential and runs the adapt pass with it.
        composable("build/git/key") { entry ->
            PodScoped(nav, placement, entry, creation = true) {
                AiKeyStepScreen(
                    onConfirm = { cred ->
                        PendingBuildCredential.set(cred)
                        nav.popBackStack()
                    },
                    onBack = { nav.popBackStack() },
                )
            }
        }
        composable("build/mcp") { entry -> PodScoped(nav, placement, entry, creation = true) { BuildMcpScreen(nav) } }
        composable("build/journal") { entry -> PodScoped(nav, placement, entry, creation = false) { BuildJournalScreen(nav) } }
        composable("build/journal/{buildId}") { entry ->
            val bid = entry.arguments?.getString("buildId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                BuildJournalScreen(nav, buildId = bid)
            }
        }
        composable("vibe/provider") { entry -> PodScoped(nav, placement, entry, creation = true) { VibeCodeProviderPickScreen(nav) } }
        // AI-key step for the from-scratch path. On confirm it stows the
        // in-memory credential and continues to the describe screen, which
        // hands it to the box's model when the build starts.
        composable("vibe/key") { entry ->
            PodScoped(nav, placement, entry, creation = true) {
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
        }
        composable("vibe/describe") { entry -> PodScoped(nav, placement, entry, creation = true) { VibeCodeDescribeScreen(nav) } }
        composable("vibe/generating/{sessionId}") { entry ->
            val sid = entry.arguments?.getString("sessionId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                VibeCodeGeneratingScreen(nav, sessionId = sid)
            }
        }
        // W10 — vibe-code chat surface (talkToUser / requestEnvVar replies).
        // Reached from the `vibecode-needs-you` push deep link, and from the
        // generating screen's Interrupt (a follow-up reply to the live build).
        composable("vibe-code-chat/{sessionId}") { entry ->
            val sid = entry.arguments?.getString("sessionId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                VibeCodeChatScreen(nav, sessionId = sid)
            }
        }
        composable("browser-tabs/{serviceId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                BrowserTabsScreen(nav, serviceId = sid)
            }
        }
        composable("browser-viewer/{serviceId}/{tabId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            val tid = entry.arguments?.getString("tabId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                BrowserViewerScreen(nav, serviceId = sid, tabId = tid)
            }
        }
        // #92 — per-service access control: open to all / members only, and
        // the members list.
        composable("service-access/{serviceId}") { entry ->
            val sid = entry.arguments?.getString("serviceId") ?: return@composable
            PodScoped(nav, placement, entry, creation = false) {
                ServiceAccessScreen(nav, serviceId = sid)
            }
        }
        // #92 — friend redeem of a service-access invite (deep-link target). `s`
        // names the app: the friend redeems with their id for it (empty ⇒ a link
        // made before per-app ids, refused); `a` marks the box as invited.
        composable(
            route = "invite-redeem/{server}/{secret}?a={a}&i={i}&s={s}",
            arguments = listOf(
                navArgument("server") { type = NavType.StringType },
                navArgument("secret") { type = NavType.StringType },
                navArgument("a") { type = NavType.StringType; defaultValue = "" },
                navArgument("i") { type = NavType.StringType; defaultValue = "" },
                navArgument("s") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val server = java.net.URLDecoder.decode(entry.arguments?.getString("server") ?: "", "UTF-8")
            val secret = java.net.URLDecoder.decode(entry.arguments?.getString("secret") ?: "", "UTF-8")
            val authorAid = java.net.URLDecoder.decode(entry.arguments?.getString("a") ?: "", "UTF-8").ifEmpty { null }
            val inviteId = java.net.URLDecoder.decode(entry.arguments?.getString("i") ?: "", "UTF-8").ifEmpty { null }
            val serviceRef = java.net.URLDecoder.decode(entry.arguments?.getString("s") ?: "", "UTF-8").ifEmpty { null }
            InviteRedeemScreen(
                serverDomain = server,
                secretHex = secret,
                authorAidHex = authorAid,
                inviteIdHex = inviteId,
                serviceRef = serviceRef,
                onOpenService = { nav.popBackStack() },
                onDone = { nav.popBackStack() },
            )
        }
        composable(
            route = "invite-accept?reply={reply}",
            arguments = listOf(navArgument("reply") { type = NavType.StringType; defaultValue = "" }),
        ) { entry ->
            val reply = java.net.URLDecoder.decode(entry.arguments?.getString("reply") ?: "", "UTF-8")
            InviteAcceptScreen(rawReply = reply, onDone = { nav.popBackStack() })
        }
        // Web-experience gating — authorize a browser's QR-login (deep-link +
        // "Process URL" target). svc is an optional query arg (empty = apex).
        composable(
            route = "knock-authorize/{server}/{ref}/{page}?svc={svc}",
            arguments = listOf(
                navArgument("server") { type = NavType.StringType },
                navArgument("ref") { type = NavType.StringType },
                navArgument("page") { type = NavType.StringType },
                navArgument("svc") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { entry ->
            val server = java.net.URLDecoder.decode(entry.arguments?.getString("server") ?: "", "UTF-8")
            val ref = java.net.URLDecoder.decode(entry.arguments?.getString("ref") ?: "", "UTF-8")
            val page = java.net.URLDecoder.decode(entry.arguments?.getString("page") ?: "", "UTF-8")
            val svc = java.net.URLDecoder.decode(entry.arguments?.getString("svc") ?: "", "UTF-8")
            KnockAuthorizeScreen(
                serverId = server,
                svc = svc,
                serviceRef = ref,
                pageId = page,
                onDone = { nav.popBackStack() },
            )
        }
    }
}
