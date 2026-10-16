// Activity tab landing, organised like iOS ActivityScreen: box approvals
// (always reachable), post-recovery, account events with the full audit
// log, then what happened on the servers.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ListAlt
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SystemUpdateAlt
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.navigation.NavController
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.PodSwitcher
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ActivityFeed
import com.flagshipserver.app.viewmodels.ActivityFeedFilter
import com.flagshipserver.app.viewmodels.ActivityItem
import com.flagshipserver.app.viewmodels.ActivityViewModel
import com.flagshipserver.app.viewmodels.LoadingState

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

    FSScreen(
        title = "Activity",
        titleTag = "activity-title",
        onRefresh = { vm.load() },
        refreshing = state is LoadingState.Loading,
        spacing = FS.space.s6,
        actions = {
            FSBarAction(Icons.Outlined.Refresh, "Refresh", onClick = { vm.load() })
        },
    ) {
        // Server filter — shown only when the user owns more than one pod.
        // A specific server narrows the pod-attributable rows while
        // account-wide rows (audit, recovery) always stay visible.
        if (pods.size > 1) {
            PodSwitcher(
                pods = pods,
                currentPodId = effectiveServerFilter,
                leaderPodId = leaderPodId,
                onPick = { serverFilter = it.podId },
                allLabel = "All servers",
                onPickAll = { serverFilter = null },
            )
        }

        // ALWAYS visible, OUTSIDE the loaded-state branch: a box waiting for an
        // unlock/entitlement approval is exactly when the daemon BFF (this feed)
        // can't load, so gating it behind Loaded hid it precisely when needed.
        Section("Box approvals") {
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text("Approve a box's boot", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Servers set to ask on every boot wait here for you to release their disk key.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    FSPrimaryButton(
                        label = "Open approvals",
                        onClick = { nav.navigate("secret-requests") },
                        block = true,
                        modifier = Modifier.testTag("activity-open-approvals"),
                    )
                }
            }
        }

        when (val s = state) {
            is LoadingState.Loaded -> FeedBody(
                ActivityFeed(items = ActivityFeedFilter.apply(s.value.items, filterPodName)),
                nav,
            )
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> ServerCardSkeleton()
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(title)
        content()
    }
}

@Composable
private fun FeedBody(feed: ActivityFeed, nav: NavController) {
    val snapshot = feed.items.filterIsInstance<ActivityItem.RecoverySnapshot>().firstOrNull()?.snapshot
    if (snapshot != null) {
        Section("Post-recovery") {
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    val done = snapshot.lastReissue != null
                    FSRowHeadline(
                        icon = if (done) Icons.Outlined.CheckCircle else Icons.Outlined.Schedule,
                        tint = if (done) FS.colors.success else FS.colors.primary,
                        text = if (done) "Re-attach finished." else "Re-attach in progress.",
                    )
                    snapshot.lastReissue?.let { r ->
                        Text(
                            "${com.flagshipserver.app.ui.components.plural(r.totalRewritten, "row")} rewritten · " +
                                com.flagshipserver.app.ui.components.plural(r.reattachedCount, "app"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    FSSecondaryButton(label = "View report", onClick = { nav.navigate("post-recovery") }, block = true)
                }
            }
        }
    }

    val account = feed.items.filterIsInstance<ActivityItem.AuditEntry>()
    Section("Account events") {
        FSGroup {
            account.forEach { item ->
                FeedRow(item, icon = Icons.Outlined.History)
                FSDivider()
            }
            FSRow(
                title = "View full audit log",
                icon = Icons.AutoMirrored.Outlined.ListAlt,
                iconTint = MaterialTheme.colorScheme.primary,
                onClick = { nav.navigate("audit-log") },
                modifier = Modifier.testTag("activity-open-audit-log"),
            )
        }
    }

    val onServers = feed.items.filter { it is ActivityItem.BoxEvent || it is ActivityItem.InstallEvent }
    Section("On your servers") {
        if (onServers.isEmpty()) {
            FSNote("Nothing has happened yet.")
        } else {
            FSGroup {
                onServers.forEachIndexed { i, item ->
                    when (item) {
                        is ActivityItem.InstallEvent -> {
                            val (icon, verb) = installVerb(item.event.kind)
                            FeedRow(item, icon = icon, title = "$verb ${item.event.serviceId}")
                        }
                        else -> FeedRow(item, icon = Icons.Outlined.Dns)
                    }
                    if (i < onServers.size - 1) FSDivider()
                }
            }
        }
    }
}

private fun installVerb(kind: String): Pair<ImageVector, String> = when (kind) {
    "installed" -> Icons.Outlined.Download to "Deployed"
    "uninstalled" -> Icons.Outlined.Delete to "Removed"
    "deploy" -> Icons.Outlined.Sync to "Redeployed"
    "update-pulled" -> Icons.Outlined.SystemUpdateAlt to "Updated"
    else -> Icons.Outlined.Circle to "Event:"
}

@Composable
private fun FSRowHeadline(icon: ImageVector, tint: Color, text: String) {
    androidx.compose.foundation.layout.Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun FeedRow(item: ActivityItem, icon: ImageVector, title: String = item.title) {
    FSRow(
        title = title,
        subtitle = item.subtitle,
        icon = if (item.warning) Icons.Filled.Warning else icon,
        iconTint = if (item.warning) FS.colors.warning else MaterialTheme.colorScheme.onSurfaceVariant,
        titleColor = if (item.warning) FS.colors.warning else null,
        modifier = if (item.warning) Modifier.testTag("activity-row-warning") else Modifier,
        trailing = {
            Text(
                FlagshipDateFormat.format(item.at),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelMedium,
            )
        },
    )
}
