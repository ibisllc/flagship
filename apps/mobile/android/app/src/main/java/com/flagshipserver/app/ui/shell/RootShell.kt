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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Timeline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.RootDestination
import com.flagshipserver.app.ui.shell.tabs.ActivityTab
import com.flagshipserver.app.ui.shell.tabs.ServicesTab
import com.flagshipserver.app.ui.shell.tabs.HomeTab
import com.flagshipserver.app.ui.shell.tabs.SettingsTab
import com.flagshipserver.app.ui.theme.FS

/** Local enum so screens don't depend on the material3 window-size-class
 *  artifact directly; MainActivity maps its real calculateWindowSizeClass
 *  result into this via mapWidth. */
enum class WindowWidthSizeClass { COMPACT, MEDIUM, EXPANDED }

/** The window's width class, for screens that lay out differently when wide
 *  (Activity is list and detail on an expanded window). */
val LocalWindowWidthClass = androidx.compose.runtime.compositionLocalOf { WindowWidthSizeClass.COMPACT }

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
    // Saveable: coming back to a recreated activity keeps the tab (and so
    // the flow open on it), as iOS does.
    var selected by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(initialTab ?: RootDestination.HOME) }
    val deepLinker = com.flagshipserver.app.core.LocalDeepLinker.current
    val pending by deepLinker.pending.collectAsState()

    var backupApproval by remember { mutableStateOf<com.flagshipserver.app.core.DeepLink.ApproveBackupDownload?>(null) }
    androidx.compose.runtime.LaunchedEffect(pending) {
        val link = pending ?: return@LaunchedEffect
        if (link is com.flagshipserver.app.core.DeepLink.ApproveBackupDownload) {
            // A backup's browser download page: approve over this phone's own keys.
            deepLinker.consume()
            backupApproval = link
            return@LaunchedEffect
        }
        selected = when (link) {
            is com.flagshipserver.app.core.DeepLink.ApproveBackupDownload -> selected
            com.flagshipserver.app.core.DeepLink.SecretRequests -> RootDestination.ACTIVITY
            is com.flagshipserver.app.core.DeepLink.ServerDetail -> RootDestination.HOME
            is com.flagshipserver.app.core.DeepLink.AppDetail -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.CreateApp -> RootDestination.APPS
            com.flagshipserver.app.core.DeepLink.StartBuild -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.AccessList -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.VibeCodeChat -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.BuildJournal -> RootDestination.APPS
            com.flagshipserver.app.core.DeepLink.Marketplace -> RootDestination.APPS
            com.flagshipserver.app.core.DeepLink.CreateServer -> RootDestination.HOME
            // Slice C — a `/transfer?o=…` take-over link opens the acquirer flow
            // on the Home tab (adding/receiving a server is a Home concern).
            is com.flagshipserver.app.core.DeepLink.TransferOffer -> RootDestination.HOME
            is com.flagshipserver.app.core.DeepLink.ShareOffer -> RootDestination.HOME
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
            is com.flagshipserver.app.core.DeepLink.CompanionDockApproval -> RootDestination.SETTINGS
            // Studio's pairing QR opens Create server, a Home concern.
            is com.flagshipserver.app.core.DeepLink.BuilderPair -> RootDestination.HOME
            // A friend's acceptance reply: the Apps tab pushes the approve screen.
            is com.flagshipserver.app.core.DeepLink.AcceptInvite -> RootDestination.APPS
            is com.flagshipserver.app.core.DeepLink.InstallProgress -> RootDestination.HOME
            is com.flagshipserver.app.core.DeepLink.Deadman -> RootDestination.HOME
            com.flagshipserver.app.core.DeepLink.AccountSecurity -> RootDestination.SETTINGS
            com.flagshipserver.app.core.DeepLink.TrustedDevices -> RootDestination.SETTINGS
            com.flagshipserver.app.core.DeepLink.AccountActivity -> RootDestination.ACTIVITY
            com.flagshipserver.app.core.DeepLink.Settings -> RootDestination.SETTINGS
        }
        // The tab's NavHost picks the link up via its own LaunchedEffect
        // on LocalDeepLinker.pending. We leave the queue populated so
        // both layers can see it; the tab clears via deepLinker.consume().
    }

    backupApproval?.let { a ->
        com.flagshipserver.app.ui.screens.BackupDownloadApprovalDialog(
            serverFqdn = a.serverFqdn,
            archiveId = a.archiveId,
            requestId = a.requestId,
            onDismiss = { backupApproval = null },
        )
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalWindowWidthClass provides widthSizeClass) {
        // Medium and expanded windows put the destinations in a rail beside the content
        // (Material's guidance); only a compact window uses the bottom bar.
        if (widthSizeClass != WindowWidthSizeClass.COMPACT) {
            ExpandedShell(selected) { selected = it }
        } else {
            CompactShell(selected) { selected = it }
        }
    }
}

@Composable
private fun CompactShell(
    selected: RootDestination,
    onSelect: (RootDestination) -> Unit,
) {
    // The shell's own padding is just the bottom bar (AppRoot already pads
    // the status bar); TabContent consumes it so a screen's own Scaffold
    // doesn't pad the navigation bar twice.
    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            // The bar's labels stop growing at 1.3x: four words across a phone cannot
            // follow the largest text sizes without breaking mid-word (Material's own advice).
            CappedFontScale {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                    RootDestination.entries.forEach { dest ->
                        NavigationBarItem(
                            selected = dest == selected,
                            onClick = { onSelect(dest) },
                            icon = { Icon(iconFor(dest), contentDescription = dest.label) },
                            label = { Text(dest.label, maxLines = 1) },
                            modifier = Modifier.testTag("tab-${dest.key}"),
                        )
                    }
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
        CappedFontScale { NavigationRail(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
            RootDestination.entries.forEach { dest ->
                NavigationRailItem(
                    selected = dest == selected,
                    onClick = { onSelect(dest) },
                    icon = { Icon(iconFor(dest), contentDescription = dest.label) },
                    label = { Text(dest.label) },
                    modifier = Modifier.testTag("tab-${dest.key}"),
                )
            }
        } }
        // Unlike CompactShell (whose Scaffold reserves the NavigationBar's
        // inset-padded height), nothing here accounts for the gesture bar.
        Box(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.systemBars.only(WindowInsetsSides.Bottom)),
        ) { TabContent(selected, PaddingValues(0.dp)) }
    }
}

@Composable
private fun TabContent(selected: RootDestination, padding: PaddingValues) {
    Box(
        Modifier
            .fillMaxSize()
            .padding(padding)
            .consumeWindowInsets(padding),
    ) {
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


/** Navigation chrome stops following the font size past [max]: its labels have a fixed
 *  slot, and the content next to it carries the rest of the scaling. */
@Composable
private fun CappedFontScale(max: Float = 1.3f, content: @Composable () -> Unit) {
    val d = androidx.compose.ui.platform.LocalDensity.current
    androidx.compose.runtime.CompositionLocalProvider(
        androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(d.density, minOf(d.fontScale, max)),
        content = content,
    )
}
