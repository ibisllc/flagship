// Aggregate "activity feed": pending unlock-approvals + recent
// install events + post-recovery snapshot, sorted by time. Mirrors
// FlagshipUI/ViewModels/ActivityViewModel.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AuditEvent
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

    data class InstallEvent(
        val event: RecentInstallEvent,
        override val at: Long = event.at,
        override val title: String = "${event.kind}: ${event.serviceId}",
        override val subtitle: String? = event.detail,
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
        override val title: String = auditLabel(event.eventKind),
        override val subtitle: String? = event.detail.takeIf { it.isNotBlank() },
    ) : ActivityItem
}

private fun auditLabel(kind: String): String = when (kind) {
    "device-disconnected" -> "Disconnected device"
    "device-replaced"     -> "Replaced device"
    "device-added"        -> "Added device"
    "wipe-restart"        -> "Wiped & restarted account"
    "recovery-set-up"     -> "Set up recovery"
    "recovery-rotated"    -> "Rotated recovery passkey"
    "app-renamed"         -> "Renamed app URL"
    "server-created"      -> "Created server"
    "server-online"       -> "Server came online"
    else                  -> kind
}

data class ActivityFeed(
    val items: List<ActivityItem>,
)

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

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        // coroutineScope contains the structured-concurrency tree so a
        // sibling async{} failure cancels its siblings cleanly and
        // bubbles out as a single throw the outer try{} catches — no
        // dangling uncaught exceptions in the parent scope.
        val outcome = runCatching {
            coroutineScope {
                val detailJob = async { runCatching { client.serverDetail().recentInstallEvents }.getOrDefault(emptyList()) }
                val recoveryJob = async { runCatching { client.postRecoveryStatus().report }.getOrNull() }
                // Account-level audit feed. Lives on .com (not the
                // daemon) so the fetch is tolerated as missing (a
                // misconfigured Worker shouldn't break the rest of
                // the feed).
                val auditJob = async {
                    val u = username()
                    val s = server
                    if (s == null || u.isNullOrEmpty()) emptyList()
                    else runCatching { s.listAuditEvents(u, sinceSeq = 0, limit = 20).events }.getOrDefault(emptyList())
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
                    recents.forEach { add(ActivityItem.InstallEvent(it)) }
                    snapshot?.let { add(ActivityItem.RecoverySnapshot(it)) }
                    audit.forEach { add(ActivityItem.AuditEntry(it)) }
                }.sortedByDescending { it.at }
                _state.value = LoadingState.Loaded(ActivityFeed(items = items))
            },
            onFailure = { t ->
                _state.value = LoadingState.Failed(t.message ?: "couldn't load activity")
            },
        )
    }
}
