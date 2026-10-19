// Activity tab landing: accordion sections (server approvals, post-recovery,
// your account, this server's log), one open at a time, each list scrolling
// inside a bounded height and paging in place. Every row's time is a date and
// time to the minute. Mirrors FlagshipUI/Screens/ActivityScreen.swift.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.ui.theme.softTint
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Restore
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import com.flagshipserver.app.ui.components.FSNote
import androidx.compose.runtime.SideEffect
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
import com.flagshipserver.app.ui.components.fsTick
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
fun ActivityScreen(
    nav: NavController,
    /** Bumped each time a push or link asks for the approvals: the section opens. */
    openApprovalsSignal: Int = 0,
) {
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
    // Server approvals live in their section, so the count is known while it is closed.
    val approvals = rememberApprovals()
    LaunchedEffect(approvals) { approvals.reload() }
    val approvalsState by approvals.state.collectAsState()
    val approvalsCount = (approvalsState as? LoadingState.Loaded)?.value?.size ?: 0

    // Server filter (the PodSwitcher). null == "All servers".
    val pods by app.pods.collectAsState()
    val leaderPodId by app.leaderPodId.collectAsState()
    var serverFilter by remember { mutableStateOf<String?>(null) }
    // A pod the user no longer owns can't stay selected; treat a stale
    // selection as "All servers". Derived (no state write during composition).
    val effectiveServerFilter = serverFilter?.takeIf { id -> pods.any { it.podId == id } }
    val filterPodName = pods.firstOrNull { it.podId == effectiveServerFilter }?.name

    val wide = com.flagshipserver.app.ui.shell.LocalWindowWidthClass.current == com.flagshipserver.app.ui.shell.WindowWidthSizeClass.EXPANDED
    val pane = remember { ActivityPane() }
    var open by rememberSaveable { mutableStateOf<ActivitySection?>(null) }
    // A wide window always has a section open on the right.
    LaunchedEffect(wide) { if (wide && open == null) open = ActivitySection.Server }
    // A push or link for an approval lands here with the section open and the list fresh.
    LaunchedEffect(openApprovalsSignal) {
        if (openApprovalsSignal > 0) {
            open = ActivitySection.Approvals
            approvals.reload()
        }
    }
    FSScreen(
        title = "Activity",
        titleTag = "activity-title",
        spacing = 0.dp,
        maxContentWidth = if (wide) 1120.dp else com.flagshipserver.app.ui.theme.FSLayout.readingMaxWidth,
        actions = {
            com.flagshipserver.app.ui.components.TextButton(onClick = { vm.load(); approvals.reload() }) { Text("Refresh") }
        },
    ) {
        val list: @Composable () -> Unit = {
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
            count = approvalsCount,
            badge = true,
        ) { ApprovalsList(approvals) }

        val serverTitle = activityServerTitle(pods, effectiveServerFilter)
        val allServers = serverTitle == "All servers"
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
                    hint = if (allServers) "Updates, backups, apps and shares across all servers" else "Updates, backups, apps and shares on this server",
                    count = box.size,
                    isOpen = open == ActivitySection.Server,
                    onToggle = { toggle(ActivitySection.Server) },
                ) {
                    EventList(
                        rows = box,
                        empty = if (allServers) "Nothing has happened on your servers yet." else "Nothing has happened on this server yet.",
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
        if (wide) {
            androidx.compose.runtime.CompositionLocalProvider(LocalActivityPane provides pane) {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s4), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) { list() }
                    Column(Modifier.weight(1.4f).testTag("activity-detail-pane")) {
                        val c = pane.content
                        if (open != null && c != null) {
                            FSCard(padding = PaddingValues(FS.space.s4)) {
                                Text(pane.title, style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.height(FS.space.s3))
                                c()
                            }
                        } else {
                            FSNote("Pick a section to read it here.")
                        }
                    }
                }
            }
        } else {
            list()
        }
    }
}

internal enum class ActivitySection { Approvals, Recovery, Account, Server }

/** The detail pane of Activity on an expanded window: the open section's content
 *  is drawn here instead of under its title. Null on a phone. */
internal class ActivityPane {
    var content by mutableStateOf<(@Composable () -> Unit)?>(null)
    var title by mutableStateOf("")
}

internal val LocalActivityPane = androidx.compose.runtime.compositionLocalOf<ActivityPane?> { null }

/** "Server · home2": the server this log belongs to (the one picked in the
 *  switcher, else the only one). With several servers and none picked the log is every
 *  server's, so it says "All servers". */
internal fun activityServerTitle(pods: List<com.flagshipserver.app.core.PodInfo>, pickedPodId: String?): String {
    val pod = pods.firstOrNull { it.podId == pickedPodId } ?: pods.singleOrNull()
    if (pod == null && pods.size > 1) return "All servers"
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
    /** Draw the count as a badge (something waits for the owner) instead of a plain number. */
    badge: Boolean = false,
    content: @Composable () -> Unit,
) {
    val tag = "activity-section-${section.name.lowercase()}"
    val view = androidx.compose.ui.platform.LocalView.current
    val pane = LocalActivityPane.current
    val chevron by androidx.compose.animation.core.animateFloatAsState(if (isOpen) 180f else 0f, androidx.compose.animation.core.spring(stiffness = androidx.compose.animation.core.Spring.StiffnessMediumLow), label = "chevron")
    if (pane != null && isOpen) SideEffect { pane.content = content; pane.title = title }
    FSCard(padding = PaddingValues(0.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClickLabel = if (isOpen) "Collapse" else "Expand", onClick = { view.fsTick(); onToggle() })
                    .padding(FS.space.s4)
                    .testTag(tag)
                    .semantics(mergeDescendants = true) {
                        stateDescription = if (isOpen) "expanded" else "collapsed"
                        heading()
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val tileIcon = when (section) {
                    ActivitySection.Approvals -> Icons.Outlined.LockOpen
                    ActivitySection.Recovery -> Icons.Outlined.Restore
                    ActivitySection.Account -> Icons.Outlined.Person
                    ActivitySection.Server -> Icons.Outlined.Dns
                }
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier.size(40.dp).background(FS.colors.softTint(), MaterialTheme.shapes.small),
                ) { Icon(tileIcon, contentDescription = null, tint = FS.colors.accent) }
                Spacer(Modifier.width(FS.space.s3))
                Column(Modifier.weight(1f)) {
                    Text(title, color = FS.colors.text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                    Text(hint, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                }
                if (count != null && count > 0) {
                    if (badge) {
                        FSPill("$count", kind = FSPillKind.Pending, modifier = Modifier.testTag("$tag-count"))
                    } else {
                        Text("$count", color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.width(FS.space.s2))
                }
                if (pane != null) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = if (isOpen) FS.colors.accent else FS.colors.textMuted)
                } else {
                    Icon(
                        Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                        tint = FS.colors.textMuted,
                        modifier = Modifier.rotate(chevron),
                    )
                }
            }
            if (isOpen && pane == null) {
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
            .heightIn(max = if (LocalActivityPane.current != null) 720.dp else ACTIVITY_LIST_MAX_HEIGHT)
            .verticalScroll(rememberScrollState())
            .testTag("activity-event-list"),
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        rows.forEachIndexed { index, item ->
            EventRow(item)
            if (index < rows.lastIndex || more) Divider(color = FS.colors.border)
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
            // The time sits under the words, so a long title keeps the full row.
            Text(
                ActivityDates.format(item.at),
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.testTag("activity-row-time"),
            )
        }
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
