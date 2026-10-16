// One app on a server shared with this account (docs/share-a-server.md):
// what it is and its link, its internet access at "Can manage", and its
// database when the owner lets this share see app data. Mirror of iOS
// SharedAppScreen and the webapp's shared-server app rows.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.core.AppOrderSigning
import com.flagshipserver.app.core.LocalAppOrderSigning
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.LocalServerShares
import com.flagshipserver.app.viewmodels.CoInviteViewModel
import com.flagshipserver.app.viewmodels.ShareCopy
import com.flagshipserver.app.viewmodels.SharedAppUi
import com.flagshipserver.app.viewmodels.SharedAppViewModel
import kotlinx.coroutines.launch

fun sharedAppRoute(shareId: String, serviceId: String) = "shared-app/$shareId/$serviceId"

@Composable
fun SharedAppScreen(shareId: String, serviceId: String, onBack: () -> Unit) {
    val runtime = LocalServerShares.current ?: return
    val shared by runtime.sharedWithMe.ui.collectAsState()
    val entry = shared.items.firstOrNull { it.entry.shareId == shareId }?.entry
    if (entry == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (shared.loaded) Line("This server isn't shared with you any more.") else CircularProgressIndicator()
        }
        return
    }
    val vm = remember(entry.shareId, serviceId) { SharedAppViewModel(runtime, entry, serviceId) }
    val ui by vm.ui.collectAsState()
    LaunchedEffect(vm) { vm.load() }

    val client = ui.client
    if (client == null) {
        SharedAppContent(vm.appName, ui, nav = null, onBack = onBack, onRetry = null)
        return
    }
    // The app's own sections (access list, database) are the owner's screens,
    // run here over the share's session and signed with its member key.
    val signing = remember(vm) { AppOrderSigning(entry.serverDomain) { reason -> vm.memberSigner(reason) } }
    val scope = rememberCoroutineScope()
    val nav = rememberNavController()
    val invites = remember(vm) { vm.coInvites() }
    CompositionLocalProvider(LocalScreensClient provides client, LocalAppOrderSigning provides signing) {
        NavHost(navController = nav, startDestination = "app") {
            composable("app") {
                SharedAppContent(vm.appName, ui, nav, onBack = onBack, onRetry = { scope.launch { vm.load() } }, invites = invites)
            }
            composable(
                route = "service-access-list/{serviceId}?draft={draft}",
                arguments = listOf(
                    navArgument("serviceId") { type = NavType.StringType },
                    navArgument("draft") { type = NavType.BoolType; defaultValue = false },
                ),
            ) { e ->
                AccessListScreen(nav, serviceId = serviceId, fromDraft = e.arguments?.getBoolean("draft") == true)
            }
            composable("app-db/{serviceId}") { AppDatabaseScreen(nav, serviceId = serviceId) }
            composable(
                route = "app-db/{serviceId}/table?store={store}&table={table}",
                arguments = listOf(
                    navArgument("serviceId") { type = NavType.StringType },
                    navArgument("store") { type = NavType.StringType; defaultValue = "" },
                    navArgument("table") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { e ->
                AppDbTableScreen(
                    nav,
                    serviceId = serviceId,
                    store = e.arguments?.getString("store").orEmpty(),
                    table = e.arguments?.getString("table").orEmpty(),
                )
            }
            composable(
                route = "app-db/{serviceId}/query?store={store}",
                arguments = listOf(
                    navArgument("serviceId") { type = NavType.StringType },
                    navArgument("store") { type = NavType.StringType; defaultValue = "" },
                ),
            ) { e ->
                AppDbQueryScreen(nav, serviceId = serviceId, store = e.arguments?.getString("store").orEmpty())
            }
        }
    }
}

@Composable
internal fun SharedAppContent(
    appName: String,
    ui: SharedAppUi,
    nav: NavController?,
    onBack: () -> Unit,
    onRetry: (() -> Unit)?,
    invites: CoInviteViewModel? = null,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(
            Modifier.widthIn(max = FSLayout.readingMaxWidth).fillMaxWidth().padding(horizontal = FS.space.s6).testTag("shared-app"),
        ) {
            Spacer(Modifier.height(FS.space.s8))
            FSGhostButton(label = "← Back", onClick = onBack)
            Spacer(Modifier.height(FS.space.s3))
            Text(appName, color = FS.colors.text, style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium))
            Spacer(Modifier.height(FS.space.s6))
            val detail = ui.detail
            when {
                detail != null && nav != null -> AppSections(appName, detail, ui, nav, invites)
                ui.phase == SharedAppUi.Phase.Waiting -> Line("Waiting for the owner to confirm this share.")
                ui.phase == SharedAppUi.Phase.Ended -> Line("The owner stopped sharing this server.")
                ui.phase == SharedAppUi.Phase.Failed -> ErrorCard(ui.message ?: "Couldn't open this app.", onRetry = onRetry)
                else -> ServerCardSkeleton()
            }
            Spacer(Modifier.height(FS.space.s12))
        }
    }
}

@Composable
private fun AppSections(appName: String, detail: AppDetailResponse, ui: SharedAppUi, nav: NavController, invites: CoInviteViewModel?) {
    val app = detail.app
    val uri = LocalUriHandler.current
    val running = app.status == "running"
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("shared-app-card")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(appName, color = FS.colors.text, style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f))
                FSPill(if (running) "Running" else app.status.replaceFirstChar { it.uppercase() }, kind = if (running) FSPillKind.Online else FSPillKind.Idle)
            }
            app.summary?.takeIf { it.isNotBlank() }?.let { Line(it, size = 14) }
            if (app.accessMode == "members-only") {
                Line(ShareCopy.MEMBERS_ONLY_HINT, size = 13, modifier = Modifier.testTag("shared-app-members-only"))
            }
            if (app.url.isNotEmpty()) {
                FSSecondaryButton(
                    label = "Open $appName",
                    block = true,
                    modifier = Modifier.testTag("shared-app-open"),
                    onClick = { runCatching { uri.openUri(app.url) } },
                )
            }
        }
    }
    val access = app.access
    if (ui.manage && access != null) {
        InternetAccessSection(
            nav = nav,
            serviceId = app.serviceId,
            appName = appName,
            summary = access,
            restricted = false,
            fallbackServerDomain = { null },
        )
    }
    if (ui.manage && invites != null) CoInviteSection(invites)
    if (ui.seeAppData) DatabaseEntrySection(nav, app.serviceId, detail, restricted = false)
}

@Composable
private fun Line(text: String, modifier: Modifier = Modifier, size: Int = 15) {
    Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = size.sp, lineHeight = (size + 6).sp), modifier = modifier)
}
