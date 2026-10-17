// Aggregate "activity feed": pending unlock-approvals + recent
// install events + post-recovery snapshot, sorted by time. Mirrors
// FlagshipUI/ViewModels/ActivityViewModel.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AuditEvent
import com.flagshipserver.app.api.BoxActivityEntry
import com.flagshipserver.app.core.BoxEventLabels
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.RecentInstallEvent
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.PostRecoverySnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ActivityItem {
    val at: Long
    val title: String
    val subtitle: String?
    /** Something went wrong or was locked down: the row is shown as a warning. */
    val warning: Boolean get() = false

    data class InstallEvent(
        val event: RecentInstallEvent,
        override val at: Long = event.at,
        override val title: String = "${event.kind}: ${event.serviceId}",
        override val subtitle: String? = event.detail,
    ) : ActivityItem

    /** What the server itself did (its own log: updates, migration, backups,
     *  imports, app changes, shares). */
    data class BoxEvent(
        val entry: BoxActivityEntry,
        override val at: Long = entry.ts,
        override val title: String = BoxEventLabels.title(entry) ?: "",
        override val subtitle: String? = entry.detail,
        override val warning: Boolean = !entry.ok,
    ) : ActivityItem

    data class RecoverySnapshot(
        val snapshot: PostRecoverySnapshot,
        override val at: Long =
            snapshot.lastReissue?.completedAt
                ?: snapshot.lastReissue?.startedAt
                ?: 0L,
        override val title: String = "Recovery: ${snapshot.lastReissue?.status ?: "snapshot"}",
        override val subtitle: String? =
            snapshot.lastReissue?.let { "${it.totalRewritten} rewrites · ${it.reattachedCount} reattached" },
    ) : ActivityItem

    /** Account-level audit event — surfaced alongside install events
     *  in the merged time-sorted feed. eventKind matches the Worker's
     *  controlled vocabulary; subtitle carries the human-readable
     *  detail string the Worker recorded ("Disconnected iPad (kitchen)"). */
    data class AuditEntry(
        val event: AuditEvent,
        override val at: Long = event.postedAt,
        override val title: String = auditEventLabel(event.eventKind),
        override val subtitle: String? = auditEventDisplayDetail(event),
    ) : ActivityItem
}

data class ActivityFeed(
    val items: List<ActivityItem>,
    /** The last fetch of account events filled its page, so older ones may exist. */
    val moreAudit: Boolean = false,
    /** Same for this server's own log. */
    val moreBox: Boolean = false,
)

/** The time on every Activity row: date and time to the minute ("Oct 17, 2:45 PM"),
 *  with the year when it isn't this one. */
object ActivityDates {
    fun format(
        ms: Long,
        nowMs: Long = System.currentTimeMillis(),
        zone: java.time.ZoneId = java.time.ZoneId.systemDefault(),
        locale: java.util.Locale = java.util.Locale.getDefault(),
    ): String {
        val at = java.time.Instant.ofEpochMilli(ms).atZone(zone)
        val sameYear = at.year == java.time.Instant.ofEpochMilli(nowMs).atZone(zone).year
        val pattern = if (sameYear) "MMM d, h:mm a" else "MMM d, yyyy, h:mm a"
        return java.time.format.DateTimeFormatter.ofPattern(pattern, locale).format(at)
    }
}

/**
 * Pure, Compose-free server-filter logic for the Activity feed, kept testable
 * on the JVM (the same split as [PodSwitcherModel]). The feed mixes
 * pod-attributable rows (install events, whose serviceId/detail can carry a
 * `.<pod>.` subdomain segment) with account-wide rows (audit, recovery) that
 * belong to no single server. So a server filter keeps account-wide rows
 * ALWAYS visible and narrows only the attributable rows to those that mention
 * the selected pod; "All servers" (podName == null) shows everything.
 */
object ActivityFeedFilter {
    /** True if [item] should be shown when filtering to the pod named
     *  [podName]. A null [podName] is "All servers" → everything passes. */
    fun matches(item: ActivityItem, podName: String?): Boolean {
        if (podName.isNullOrEmpty()) return true
        return when (item) {
            // Account-wide — never hidden by a server filter.
            is ActivityItem.AuditEntry -> true
            // The log of the server the page reads: already scoped to one box.
            is ActivityItem.BoxEvent -> true
            is ActivityItem.RecoverySnapshot -> true
            // Pod-attributable: keep only when the event text names the pod as
            // a complete dot-delimited LABEL — a segment boundary before it
            // (start-of-text OR any non-[a-z0-9-] char, e.g. '.'/space) and a
            // '.' immediately after. So a serviceId like "blog.home.harry…" AND
            // a detail string naming "…to home.harry…" both match the pod
            // "home", but "homestead.harry…" does NOT (home is not a full
            // label). A bare ".pod." needle missed the boundary case (a pod
            // that is the leftmost FQDN label, e.g. "home.harry…").
            is ActivityItem.InstallEvent -> {
                val pod = podName.lowercase()
                val hay = ("${item.event.serviceId} ${item.event.detail ?: ""}").lowercase()
                Regex("(^|[^a-z0-9-])" + Regex.escape(pod) + "\\.").containsMatchIn(hay)
            }
        }
    }

    fun apply(items: List<ActivityItem>, podName: String?): List<ActivityItem> =
        items.filter { matches(it, podName) }
}

class ActivityViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    /** Optional — only wired in production. When null, the audit
     *  section silently stays empty so older callers + tests that
     *  don't care about account-level events still work. Kept after
     *  `scope` so existing `(client, scope)` positional callers
     *  (the test fixtures) stay binding-compatible. */
    private val server: FlagshipServerClient? = null,
    /** Captured rather than stored so the VM picks up AppState
     *  changes (post sign-in / sign-out) without a re-init. */
    private val username: () -> String? = { null },
) {
    private val _state = MutableStateFlow<LoadingState<ActivityFeed>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<ActivityFeed>> = _state.asStateFlow()

    private var auditLimit = PAGE_SIZE
    private var boxLimit = PAGE_SIZE

    /** The next page of account events: the list grows in place. */
    fun loadMoreAudit() = scope.launch { auditLimit += PAGE_SIZE; fetch(quiet = true) }

    /** The next page of this server's events. */
    fun loadMoreBox() = scope.launch { boxLimit += PAGE_SIZE; fetch(quiet = true) }

    fun load() = scope.launch { fetch(quiet = false) }

    private suspend fun fetch(quiet: Boolean) {
        if (!quiet) _state.value = LoadingState.Loading
        val boxN = boxLimit
        val auditN = auditLimit
        // coroutineScope contains the structured-concurrency tree so a
        // sibling async{} failure cancels its siblings cleanly and
        // bubbles out as a single throw the outer try{} catches — no
        // dangling uncaught exceptions in the parent scope.
        val outcome = runCatching {
            coroutineScope {
                val detailJob = async { runCatching { client.boxActivity(boxN) }.getOrDefault(emptyList()) }
                val recoveryJob = async { runCatching { client.postRecoveryStatus().report }.getOrNull() }
                // Account-level audit feed. Lives on .com (not the
                // daemon) so the fetch is tolerated as missing (a
                // misconfigured Worker shouldn't break the rest of
                // the feed).
                val auditJob = async {
                    val u = username()
                    val s = server
                    if (s == null || u.isNullOrEmpty()) emptyList()
                    else runCatching { s.listAuditEvents(u, sinceSeq = 0, limit = auditN).events }.getOrDefault(emptyList())
                }
                Triple(
                    detailJob.await(),
                    recoveryJob.await(),
                    auditJob.await(),
                )
            }
        }
        outcome.fold(
            onSuccess = { (recents, snapshot, audit) ->
                val items = buildList {
                    recents.filter { BoxEventLabels.title(it) != null }.forEach { add(ActivityItem.BoxEvent(it)) }
                    snapshot?.let { add(ActivityItem.RecoverySnapshot(it)) }
                    audit.forEach { add(ActivityItem.AuditEntry(it)) }
                }.sortedByDescending { it.at }
                _state.value = LoadingState.Loaded(
                    ActivityFeed(items = items, moreAudit = audit.size >= auditN, moreBox = recents.size >= boxN),
                )
            },
            onFailure = { t ->
                _state.value = LoadingState.Failed(t.message ?: "couldn't load activity")
            },
        )
    }

    companion object {
        /** Rows per page of each list. */
        const val PAGE_SIZE = 30
    }
}
