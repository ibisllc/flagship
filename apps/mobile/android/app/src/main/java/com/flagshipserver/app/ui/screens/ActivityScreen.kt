// Activity tab landing: merged feed of pending unlock-approvals,
// recent install events, and post-recovery progress, sorted by time.
// Mirrors FlagshipUI/Screens/ActivityScreen.swift.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
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
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ActivityFeed
import com.flagshipserver.app.viewmodels.ActivityItem
import com.flagshipserver.app.viewmodels.ActivityViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun ActivityScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val server = com.flagshipserver.app.core.LocalFlagshipServerClient.current
    val app = com.flagshipserver.app.core.LocalAppState.current
    val vm = remember {
        ActivityViewModel(
            client = client,
            server = server,
            username = { app.currentUser.value },
        )
    }
    val state by vm.state.collectAsState()

    LaunchedEffect(Unit) { vm.load() }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    "Activity",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
                )
                Text(
                    "Pending approvals, install timelines, and recovery progress.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp),
                )
            }
            FSGhostButton(label = "Refresh", onClick = { vm.load() })
        }

        Spacer(Modifier.height(FS.space.s4))

        when (val s = state) {
            is LoadingState.Loaded -> FeedBody(s.value, nav)
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> ServerCardSkeleton()
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun FeedBody(feed: ActivityFeed, nav: NavController) {
    if (feed.pendingApprovals.isNotEmpty()) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Unlock requests",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.weight(1f),
                    )
                    FSPill("${feed.pendingApprovals.size} waiting", kind = FSPillKind.Provisioning)
                }
                FSGhostButton(label = "Open queue", onClick = { nav.navigate("unlock-approvals") })
            }
        }
        Spacer(Modifier.height(FS.space.s3))
    }

    if (feed.items.any { it is ActivityItem.RecoverySnapshot }) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Post-recovery",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "Membership re-attach snapshot from the most recent IRK swap.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                FSGhostButton(label = "View report", onClick = { nav.navigate("post-recovery") })
            }
        }
        Spacer(Modifier.height(FS.space.s4))
    }

    Text(
        "Recent",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))

    val recentRows = feed.items
        .filter { it !is ActivityItem.UnlockApprove && it !is ActivityItem.RecoverySnapshot }
    if (recentRows.isEmpty()) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Text("No recent activity.", color = FS.colors.textMuted)
        }
    } else {
        val fmt = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
        recentRows.forEach { item ->
            FSCard(padding = PaddingValues(FS.space.s3)) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        item.title,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                    )
                    item.subtitle?.let { sub ->
                        Text(
                            sub,
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 12.sp),
                        )
                    }
                    Text(
                        fmt.format(Date(item.at)),
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 11.sp),
                    )
                }
            }
            Spacer(Modifier.height(FS.space.s2))
        }
    }
}
