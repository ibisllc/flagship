// P8 — lists the daemon's open Chromium tabs for a given serviceId.
// Mirrors webapp `renderTabs()` in views/browser-viewer.js + iOS
// FlagshipUI/Screens/BrowserTabsScreen.swift 1:1.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Tab
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.api.BrowserTab
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.BrowserTabsViewModel
import com.flagshipserver.app.viewmodels.LoadingState

@Composable
fun BrowserTabsScreen(nav: NavController, serviceId: String) {
    val client = LocalScreensClient.current
    val vm: BrowserTabsViewModel = viewModel(
        factory = viewModelFactory {
            initializer { BrowserTabsViewModel(client, serviceId) }
        },
    )
    val state by vm.state.collectAsState()
    val certMismatch by vm.certMismatch.collectAsState()

    LaunchedEffect(serviceId) { vm.load() }

    FSScreen(
        title = "Open tabs",
        onBack = { nav.popBackStack() },
        subtitle = "Pick a tab to stream. Your touches go to the browser running on your server.",
        actions = { FSBarAction(Icons.Outlined.Refresh, "Refresh", onClick = { vm.load() }) },
    ) {
        when (val s = state) {
            is LoadingState.Loaded -> TabsBody(s.value) { tab ->
                nav.navigate("browser-viewer/$serviceId/${tab.tabId}")
            }
            is LoadingState.Failed ->
                if (certMismatch) {
                    CertMismatchWarningCard(s.message, onRetry = { vm.load() })
                } else {
                    ErrorCard(s.message, onRetry = { vm.load() })
                }
            else -> ServerCardSkeleton()
        }
    }
}

@Composable
private fun TabsBody(tabs: List<BrowserTab>, onPick: (BrowserTab) -> Unit) {
    if (tabs.isEmpty()) {
        FSNote("No tabs open for this app.")
        return
    }
    FSGroup {
        tabs.forEachIndexed { idx, tab ->
            if (idx > 0) FSDivider()
            FSRow(
                title = tab.title ?: tab.tabId,
                subtitle = tab.currentUrl,
                icon = Icons.Outlined.Tab,
                onClick = { onPick(tab) },
                trailing = {
                    Icon(Icons.Outlined.PlayCircle, contentDescription = "Stream", tint = MaterialTheme.colorScheme.primary)
                },
            )
        }
    }
}

/** UX-A — the box served a cert that didn't match its STK-signed fingerprint.
 *  Distinct from a plain network error: this is a security warning, not a
 *  retry hint. */
@Composable
private fun CertMismatchWarningCard(message: String, onRetry: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.GppMaybe, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                Text(
                    "Connection couldn't be verified",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            Text(
                message,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            FSSecondaryButton(label = "Try again", onClick = onRetry)
        }
    }
}
