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
import com.flagshipserver.app.ui.components.FSCard
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

    LaunchedEffect(serviceId) { vm.load() }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Open tabs",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Pick a tab to stream. Touches are forwarded to the headless browser.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        when (val s = state) {
            is LoadingState.Loaded -> TabsBody(s.value) { tab ->
                nav.navigate("browser-viewer/$serviceId/${tab.tabId}")
            }
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> ServerCardSkeleton()
        }
    }
}

@Composable
private fun TabsBody(tabs: List<BrowserTab>, onPick: (BrowserTab) -> Unit) {
    if (tabs.isEmpty()) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Text(
                "No tabs open for this app.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
        }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        for (tab in tabs) {
            FSCard(
                padding = PaddingValues(FS.space.s4),
                modifier = Modifier.fillMaxWidth().clickable { onPick(tab) },
            ) {
                Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            tab.title ?: tab.tabId,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                        )
                        tab.currentUrl?.let { url ->
                            Text(
                                url,
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 12.sp),
                                maxLines = 1,
                            )
                        }
                    }
                    Text("▶", color = FS.colors.primary, style = TextStyle(fontSize = 18.sp))
                }
            }
        }
    }
}
