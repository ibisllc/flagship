// Kotlin equivalent of FlagshipUI/Shell/RootShell.swift.
//
// The compact (phone) shell is a bottom-bar Scaffold; the expanded
// (foldable/tablet) shell uses a permanent navigation rail. Each tab
// hosts its own NavHost so back-stack is per-tab, mirroring iOS's
// per-tab NavigationStack(path:) behavior.

package com.flagshipserver.app.ui.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Timeline
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.BurnerPairController
import com.flagshipserver.app.core.EncryptedBurnerPairingStore
import com.flagshipserver.app.core.LiveBurnerPairClient
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.RootDestination
import com.flagshipserver.app.ui.screens.BurnerPairScreen
import com.flagshipserver.app.ui.shell.tabs.ActivityTab
import com.flagshipserver.app.ui.shell.tabs.ServicesTab
import com.flagshipserver.app.ui.shell.tabs.HomeTab
import com.flagshipserver.app.ui.shell.tabs.SettingsTab
import com.flagshipserver.app.ui.theme.FS

/** Local enum so we don't pull androidx.window.core in just for this.
 *  Compose foundation will expose this in a stable release; for now
 *  MainActivity passes COMPACT and the expanded layout is reachable
 *  via tests + manual ExpandedShell composition. */
enum class WindowWidthSizeClass { COMPACT, MEDIUM, EXPANDED }

/** Root entry point invoked from MainActivity once the user is paired.
 *  The compact-vs-expanded branch lets the same code run on phones,
 *  foldables, and tablets without a second layout. Also consumes the
 *  DeepLinker queue and rebalances tab selection so an incoming push
 *  or app-link lands on the right surface. */
@Composable
fun RootShell(
    widthSizeClass: WindowWidthSizeClass = WindowWidthSizeClass.COMPACT,
    /** GYM smoke-mode (§10 Phase-5) — open the shell on this tab on first paint
     *  (the `flagship.smokeTab` selector, mirror of iOS `-smoke-tab`). Null ⇒
     *  Home, the production default. */
    initialTab: RootDestination? = null,
) {
    var selected by remember { mutableStateOf(initialTab ?: RootDestination.HOME) }
    val deepLinker = com.flagshipserver.app.core.LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()

    androidx.compose.runtime.LaunchedEffect(pending) {
        val link = pending ?: return@LaunchedEffect
        selected = when (link) {
            com.flagshipserver.app.core.DeepLink.SecretRequests -> RootDestination.ACTIVITY
            is com.flagshipserver.app.core.DeepLink.ServerDetail -> RootDestination.HOME
            is com.flagshipserver.app.core.DeepLink.AppDetail -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.VibeCodeChat -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.BuildJournal -> RootDestination.APPS
            com.flagshipserver.app.core.DeepLink.CreateServer -> RootDestination.HOME
            com.flagshipserver.app.core.DeepLink.RecoverySetup -> RootDestination.SETTINGS
            // Phase 3b — a JoinDevice deeplink while ALREADY paired means
            // adding a SECOND profile to this phone. Route to Settings,
            // which hosts the join-device-link surface.
            is com.flagshipserver.app.core.DeepLink.JoinDevice -> RootDestination.SETTINGS
            // #92 — a friend-redeem invite routes to the Apps tab, whose
            // NavHost pushes the redeem screen (account-agnostic entry).
            is com.flagshipserver.app.core.DeepLink.RedeemInvite -> RootDestination.APPS
            // Web-experience gating — authorize a browser's QR-login. Routes
            // to the Apps tab, whose NavHost pushes the authorize screen.
            is com.flagshipserver.app.core.DeepLink.AuthorizeKnock -> RootDestination.APPS
        }
        // The tab's NavHost picks the link up via its own LaunchedEffect
        // on LocalDeepLinker.pending. We leave the queue populated so
        // both layers can see it; the tab clears via deepLinker.consume().
    }

    // Cold-launch resume of an in-flight burner pairing → back to the screen.
    // At most once per composition, if a persisted unexpired pairing session
    // exists, reconnect (reusing its keys + sid) and present the pairing screen.
    // Live-client only — a mock/demo session never persists, so nothing to
    // resume there. Mirror of iOS RootShell.tryResumeBurnerPairing.
    val context = LocalContext.current
    val dev = LocalDeveloperSettings.current
    val useLive = dev?.useLiveClient?.collectAsState()?.value ?: true
    val resumeScope = rememberCoroutineScope()
    var resumedPair by remember { mutableStateOf<BurnerPairController?>(null) }
    var attemptedResume by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(useLive) {
        if (attemptedResume || !useLive) return@LaunchedEffect
        attemptedResume = true
        val store = EncryptedBurnerPairingStore.from(context)
        if (store.load() == null) return@LaunchedEffect
        val controller = BurnerPairController(
            client = LiveBurnerPairClient(),
            scope = resumeScope,
            store = store,
        )
        if (controller.resumeFromStore()) resumedPair = controller
    }

    Box(Modifier.fillMaxSize()) {
        if (widthSizeClass == WindowWidthSizeClass.EXPANDED) {
            ExpandedShell(selected) { selected = it }
        } else {
            CompactShell(selected) { selected = it }
        }
        // The resumed pairing screen is layered ABOVE the shell (full-screen
        // cover equivalent) until the user closes/disconnects it.
        resumedPair?.let { controller ->
            Surface(color = FS.colors.bg, modifier = Modifier.fillMaxSize()) {
                BurnerPairScreen(
                    controller = controller,
                    onDeliveredVisible = { _, _ -> },
                    onClose = { _, _ -> resumedPair = null },
                    onCancel = { resumedPair = null },
                )
            }
        }
    }
}

@Composable
private fun CompactShell(
    selected: RootDestination,
    onSelect: (RootDestination) -> Unit,
) {
    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = FS.colors.surface) {
                RootDestination.entries.forEach { dest ->
                    NavigationBarItem(
                        selected = dest == selected,
                        onClick = { onSelect(dest) },
                        icon = { Icon(iconFor(dest), contentDescription = dest.label) },
                        label = { Text(dest.label) },
                        modifier = Modifier.testTag("tab-${dest.key}"),
                    )
                }
            }
        },
    ) { padding ->
        TabContent(selected, padding)
    }
}

@Composable
private fun ExpandedShell(
    selected: RootDestination,
    onSelect: (RootDestination) -> Unit,
) {
    Row(Modifier.fillMaxSize()) {
        NavigationRail(containerColor = FS.colors.surface) {
            RootDestination.entries.forEach { dest ->
                NavigationRailItem(
                    selected = dest == selected,
                    onClick = { onSelect(dest) },
                    icon = { Icon(iconFor(dest), contentDescription = dest.label) },
                    label = { Text(dest.label) },
                    modifier = Modifier.testTag("tab-${dest.key}"),
                )
            }
        }
        Box(Modifier.fillMaxSize()) { TabContent(selected, PaddingValues(0.dp)) }
    }
}

@Composable
private fun TabContent(selected: RootDestination, padding: PaddingValues) {
    Box(Modifier.fillMaxSize().padding(padding)) {
        when (selected) {
            RootDestination.HOME -> HomeTab()
            RootDestination.APPS -> ServicesTab()
            RootDestination.ACTIVITY -> ActivityTab()
            RootDestination.SETTINGS -> SettingsTab()
        }
    }
}

private fun iconFor(dest: RootDestination) = when (dest) {
    RootDestination.HOME -> Icons.Outlined.Home
    RootDestination.APPS -> Icons.Outlined.Apps
    RootDestination.ACTIVITY -> Icons.Outlined.Timeline
    RootDestination.SETTINGS -> Icons.Outlined.Settings
}
