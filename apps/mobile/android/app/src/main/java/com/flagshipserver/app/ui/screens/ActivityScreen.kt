// Activity tab landing: accordion sections (server approvals, post-recovery,
// your account, this server's log), one open at a time, each list scrolling
// inside a bounded height and paging in place. Every row's time is a date and
// time to the minute. Mirrors FlagshipUI/Screens/ActivityScreen.swift.

package com.flagshipserver.app.ui.screens

import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Divider
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.flagshipserver.app.viewmodels.ActivityDates
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
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
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.ui.components.FSScreen
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
import com.flagshipserver.app.core.FlagshipDateFormat
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

    FSScreen(
        title = "Activity",
        titleTag = "activity-title",
        spacing = 0.dp,
        actions = {
            com.flagshipserver.app.ui.components.TextButton(onClick = { vm.load() }) { Text("Refresh") }
        },
    ) {
        // Server filter — shown only when the user owns more than one pod
        // (matches the Services list rule). "All servers" shows the full feed;
        // a specific server names the server section after it (account-wide
        // rows stay either way).
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

        Spacer(Modifier.height(FS.space.s4))

        // One section open at a time, so every title stays on screen.
        var open by rememberSaveable { mutableStateOf<ActivitySection?>(null) }
        fun toggle(which: ActivitySection) { open = if (open == which) null else which }

        // ALWAYS visible, OUTSIDE the loaded-state branch: a box waiting for an
        // unlock/entitlement approval is exactly when the daemon BFF (this feed)
        // can't load, so gating it behind Loaded hid it precisely when needed.
        Accordion(
            section = ActivitySection.Approvals,
            title = "Server approvals",
            hint = "Servers waiting for you to start them",
            isOpen = open == ActivitySection.Approvals,
            onToggle = { toggle(ActivitySection.Approvals) },
        ) { ApprovalsEntryCard(nav) }

        val serverTitle = activityServerTitle(pods, effectiveServerFilter)
        when (val s = state) {
            is LoadingState.Loaded -> {
                val items = s.value.items
                val recovery = items.firstOrNull { it is ActivityItem.RecoverySnapshot } as? ActivityItem.RecoverySnapshot
                if (recovery != null) {
                    Spacer(Modifier.height(FS.space.s3))
                    Accordion(
                        section = ActivitySection.Recovery,
                        title = "Post-recovery",
                        hint = recovery.title,
                        isOpen = open == ActivitySection.Recovery,
                        onToggle = { toggle(ActivitySection.Recovery) },
                    ) { PostRecoveryCard(nav) }
                }
                val audit = items.filterIsInstance<ActivityItem.AuditEntry>()
                Spacer(Modifier.height(FS.space.s3))
                Accordion(
                    section = ActivitySection.Account,
                    title = "Your account",
                    hint = "Devices, recovery and servers, across all your servers",
                    count = audit.size,
                    isOpen = open == ActivitySection.Account,
                    onToggle = { toggle(ActivitySection.Account) },
                ) {
                    EventList(
                        rows = audit,
                        empty = "Nothing has happened on your account yet.",
                        more = s.value.moreAudit,
                        onMore = { vm.loadMoreAudit() },
                        moreTag = "activity-load-more-account",
                    )
                }
                val box = items.filterIsInstance<ActivityItem.BoxEvent>()
                Spacer(Modifier.height(FS.space.s3))
                Accordion(
                    section = ActivitySection.Server,
                    title = serverTitle,
                    hint = "Updates, backups, apps and shares on this server",
                    count = box.size,
                    isOpen = open == ActivitySection.Server,
                    onToggle = { toggle(ActivitySection.Server) },
                ) {
                    EventList(
                        rows = box,
                        empty = "Nothing has happened on this server yet.",
                        more = s.value.moreBox,
                        onMore = { vm.loadMoreBox() },
                        moreTag = "activity-load-more-server",
                    )
                }
            }
            is LoadingState.Failed -> {
                Spacer(Modifier.height(FS.space.s3))
                ErrorCard(s.message, onRetry = { vm.load() })
            }
            else -> {
                Spacer(Modifier.height(FS.space.s3))
                ServerCardSkeleton()
            }
        }
    }
}

internal enum class ActivitySection { Approvals, Recovery, Account, Server }

/** "Server · home2": the server this log belongs to (the one picked in the
 *  switcher, else the only one). */
internal fun activityServerTitle(pods: List<com.flagshipserver.app.core.PodInfo>, pickedPodId: String?): String {
    val pod = pods.firstOrNull { it.podId == pickedPodId } ?: pods.singleOrNull()
    val name = pod?.name?.takeIf { it.isNotEmpty() } ?: return "This server"
    return "Server · $name"
}

@Composable
private fun Accordion(
    section: ActivitySection,
    title: String,
    hint: String,
    isOpen: Boolean,
    onToggle: () -> Unit,
    count: Int? = null,
    content: @Composable () -> Unit,
) {
    val tag = "activity-section-${section.name.lowercase()}"
    FSCard(padding = PaddingValues(0.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClickLabel = if (isOpen) "Collapse" else "Expand", onClick = onToggle)
                    .padding(FS.space.s4)
                    .testTag(tag)
                    .semantics(mergeDescendants = true) {
                        stateDescription = if (isOpen) "expanded" else "collapsed"
                        heading()
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(title, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                    Text(hint, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                }
                if (count != null && count > 0) {
                    Text("$count", color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.width(FS.space.s2))
                }
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = FS.colors.textMuted,
                    modifier = Modifier.rotate(if (isOpen) 180f else 0f),
                )
            }
            if (isOpen) {
                Divider(color = FS.colors.border)
                Column(Modifier.fillMaxWidth().padding(FS.space.s4).testTag("$tag-body")) { content() }
            }
        }
    }
}

/** The rolled-down list: scrolls inside a bounded height, so a long log never
 *  pushes the other titles off screen; pages in place. */
@Composable
private fun EventList(
    rows: List<ActivityItem>,
    empty: String,
    more: Boolean,
    onMore: () -> Unit,
    moreTag: String,
) {
    if (rows.isEmpty()) {
        Text(empty, color = FS.colors.textMuted)
        return
    }
    var loadingMore by remember { mutableStateOf(false) }
    // The list grew (or the load ended): the button can be pressed again.
    LaunchedEffect(rows.size, more) { loadingMore = false }
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = ACTIVITY_LIST_MAX_HEIGHT)
            .verticalScroll(rememberScrollState())
            .testTag("activity-event-list"),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        rows.forEach { item ->
            EventRow(item)
            Divider(color = FS.colors.border)
        }
        if (more) {
            FSGhostButton(
                label = if (loadingMore) "Loading…" else "Load more",
                onClick = { if (!loadingMore) { loadingMore = true; onMore() } },
                modifier = Modifier.testTag(moreTag),
            )
        } else {
            Text("That's everything.", color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("activity-everything"))
        }
    }
}

internal val ACTIVITY_LIST_MAX_HEIGHT = 360.dp

@Composable
private fun EventRow(item: ActivityItem) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (item.warning) {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = "Warning",
                        tint = FS.colors.warning,
                        modifier = Modifier.size(18.dp).testTag("activity-row-warning"),
                    )
                    Spacer(Modifier.width(FS.space.s2))
                }
                Text(
                    item.title,
                    color = if (item.warning) FS.colors.warning else FS.colors.text,
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                )
            }
            item.subtitle?.takeIf { it.isNotEmpty() }?.let { sub ->
                Text(sub, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
        }
        Spacer(Modifier.width(FS.space.s2))
        Text(
            ActivityDates.format(item.at),
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.testTag("activity-row-time"),
        )
    }
}

@Composable
private fun PostRecoveryCard(nav: NavController) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text(
            "Membership re-attach snapshot from the most recent account key swap.",
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodySmall,
        )
        FSGhostButton(label = "View report", onClick = { nav.navigate("post-recovery") })
    }
}

@Composable
private fun ApprovalsEntryCard(nav: NavController) {
    // The in-app way to reach the relay approval list — ALWAYS available, since a
    // box waiting on an unlock/entitlement approval can't load its BFF feed.
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        Text(
            "Approve a server's boot",
            color = FS.colors.text,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(
            "Servers set to ask on every boot wait here for you to release their disk key.",
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodySmall,
        )
        FSGhostButton(label = "Open approvals", onClick = { nav.navigate("secret-requests") })
    }
}
