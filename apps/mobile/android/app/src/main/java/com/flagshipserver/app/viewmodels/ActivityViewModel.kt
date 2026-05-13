// Aggregate "activity feed": pending unlock-approvals + recent
// install events + post-recovery snapshot, sorted by time. Mirrors
// FlagshipUI/ViewModels/ActivityViewModel.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.PendingUnlockApproval
import com.flagshipserver.app.api.RecentInstallEvent
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.PostRecoverySnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ActivityItem {
    val at: Long
    val title: String
    val subtitle: String?

    data class UnlockApprove(
        val request: PendingUnlockApproval,
        override val at: Long = request.requestedAt,
        override val title: String = "Unlock requested for ${request.serverFqdn}",
        override val subtitle: String? = request.ip?.let { "from $it" },
    ) : ActivityItem

    data class InstallEvent(
        val event: RecentInstallEvent,
        override val at: Long = event.at,
        override val title: String = "${event.kind}: ${event.appId}",
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
}

data class ActivityFeed(
    val pendingApprovals: List<PendingUnlockApproval>,
    val items: List<ActivityItem>,
)

class ActivityViewModel(
    private val client: ScreensClient,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<LoadingState<ActivityFeed>>(LoadingState.Idle)
    val state: StateFlow<LoadingState<ActivityFeed>> = _state.asStateFlow()

    fun load() = scope.launch {
        _state.value = LoadingState.Loading
        try {
            // Fan out the three feeds and stitch them once they all return.
            val approvalsJob = async { client.unlockApprovalsPending().pending }
            val detailJob = async { runCatching { client.serverDetail().recentInstallEvents }.getOrDefault(emptyList()) }
            val recoveryJob = async { runCatching { client.postRecoveryStatus().report }.getOrNull() }
            val (approvals, recents, snapshot) =
                Triple(approvalsJob.await(), detailJob.await(), recoveryJob.await())

            val items = buildList {
                approvals.forEach { add(ActivityItem.UnlockApprove(it)) }
                recents.forEach { add(ActivityItem.InstallEvent(it)) }
                snapshot?.let { add(ActivityItem.RecoverySnapshot(it)) }
            }.sortedByDescending { it.at }

            _state.value = LoadingState.Loaded(
                ActivityFeed(pendingApprovals = approvals, items = items),
            )
        } catch (t: Throwable) {
            _state.value = LoadingState.Failed(t.message ?: "couldn't load activity")
        }
    }
}
