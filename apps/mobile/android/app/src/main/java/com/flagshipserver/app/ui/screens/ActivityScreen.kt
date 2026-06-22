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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.PodSwitcher
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ActivityFeed
import com.flagshipserver.app.viewmodels.ActivityFeedFilter
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

    // Server filter (the PodSwitcher). null == "All servers".
    val pods by app.pods.collectAsState()
    val leaderPodId by app.leaderPodId.collectAsState()
    var serverFilter by remember { mutableStateOf<String?>(null) }
    // A pod the user no longer owns can't stay selected; treat a stale
    // selection as "All servers". Derived (no state write during composition).
    val effectiveServerFilter = serverFilter?.takeIf { id -> pods.any { it.podId == id } }
    val filterPodName = pods.firstOrNull { it.podId == effectiveServerFilter }?.name

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
                    // Match the Home/Services large-title size (32/40) so the
                    // tab headers are consistent — was 28sp here.
                    style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
                    modifier = Modifier.testTag("activity-title"),
                )
                Text(
                    "Pending approvals, install timelines, and recovery progress.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp),
                )
            }
            FSGhostButton(label = "Refresh", onClick = { vm.load() })
        }

        // Server filter — shown only when the user owns more than one pod
        // (matches the Services list rule). "All servers" shows the full feed;
        // a specific server narrows the pod-attributable rows (install events)
        // while account-wide rows (audit, recovery) always stay visible.
        if (pods.size > 1) {
            Spacer(Modifier.height(FS.space.s4))
            PodSwitcher(
                pods = pods,
                currentPodId = effectiveServerFilter,
                leaderPodId = leaderPodId,
                onPick = { serverFilter = it.podId },
                allLabel = "All servers",
                onPickAll = { serverFilter = null },
            )
        }

        Spacer(Modifier.height(FS.space.s4))

        // ALWAYS visible, OUTSIDE the loaded-state branch: a box waiting for an
        // unlock/entitlement approval is exactly when the daemon BFF (this feed)
        // can't load, so gating it behind Loaded hid it precisely when needed.
        ApprovalsEntryCard(nav)

        when (val s = state) {
            is LoadingState.Loaded -> FeedBody(
                ActivityFeed(items = ActivityFeedFilter.apply(s.value.items, filterPodName)),
                nav,
            )
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> ServerCardSkeleton()
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ApprovalsEntryCard(nav: NavController) {
    // The in-app way to reach the relay approval list — ALWAYS available, since a
    // box waiting on an unlock/entitlement approval can't load its BFF feed.
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Approve a box's boot",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Servers set to ask on every boot wait here for you to release their disk key.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSGhostButton(label = "Open approvals", onClick = { nav.navigate("secret-requests") })
        }
    }
    Spacer(Modifier.height(FS.space.s3))
}

@Composable
private fun FeedBody(feed: ActivityFeed, nav: NavController) {
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
        .filter { it !is ActivityItem.RecoverySnapshot }
    // P5 — always-present entry into the dedicated full-page audit log.
    // Mirrors the webapp's "see all activity" + iOS
    // ActivityScreen.viewFullAuditLogRow.
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "View full audit log",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Every signed account action — device changes, recovery rotations, URL renames.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSGhostButton(label = "Open audit log", onClick = { nav.navigate("audit-log") })
        }
    }
    Spacer(Modifier.height(FS.space.s3))
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
