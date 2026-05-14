// Exercise the fan-out + merge-by-time + tolerant-failure branches in
// ActivityViewModel.load(). Uses MockScreensClient with a custom
// fixture override so each test pins a deterministic outcome.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.AppBackupStartRequest
import com.flagshipserver.app.api.AppBackupStartResponse
import com.flagshipserver.app.api.BrowserTabsListResponse
import com.flagshipserver.app.api.InstallEvent
import com.flagshipserver.app.api.MarketplaceBrowseResponse
import com.flagshipserver.app.api.OrdersSendRequest
import com.flagshipserver.app.api.OrdersSendResponse
import com.flagshipserver.app.api.PairedSessionsListResponse
import com.flagshipserver.app.api.PendingUnlockApproval
import com.flagshipserver.app.api.PostRecoverySnapshot
import com.flagshipserver.app.api.PostRecoveryStatusResponse
import com.flagshipserver.app.api.RecentInstallEvent
import com.flagshipserver.app.api.ReissuanceReportPayload
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.api.TierStatusResponse
import com.flagshipserver.app.api.UnlockApprovalApproveRequest
import com.flagshipserver.app.api.UnlockApprovalsPendingResponse
import com.flagshipserver.app.api.UrlControllerClaimRequest
import com.flagshipserver.app.api.UrlControllerClaimResponse
import com.flagshipserver.app.api.UrlControllerOwnedResponse
import com.flagshipserver.app.api.VerifyCustomDomainRequest
import com.flagshipserver.app.api.VerifyCustomDomainResponse
import com.flagshipserver.app.api.VibeCodeFrame
import com.flagshipserver.app.api.VibeCodeStartRequest
import com.flagshipserver.app.api.VibeCodeStartResponse
import com.flagshipserver.app.api.VibeCodeStatusResponse
import com.flagshipserver.app.api.WatcherState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Hand-written fake — full control over each call's return value so we
 * can exercise the merge/sort/empty branches deterministically.
 */
private class StubScreensClient(
    var approvals: List<PendingUnlockApproval> = emptyList(),
    var recentEvents: List<RecentInstallEvent> = emptyList(),
    var recoverySnapshot: PostRecoverySnapshot? = null,
    var detailFails: Boolean = false,
    var recoveryFails: Boolean = false,
    var approvalsThrows: Boolean = false,
) : ScreensClient {
    override suspend fun serverDetail(): ServerDetailResponse {
        if (detailFails) throw ScreensError.Http(500, "detail down")
        return ServerDetailResponse(
            serverFqdn = "home.test.flagship.services",
            username = "test", daemonVersion = "0", startedAt = 0, uptimeMs = 0,
            certSans = emptyList(), appCount = 0, pairedSessionCount = 0,
            recentInstallEvents = recentEvents,
        )
    }
    override suspend fun unlockApprovalsPending(): UnlockApprovalsPendingResponse {
        if (approvalsThrows) throw ScreensError.Http(503, "approvals down")
        return UnlockApprovalsPendingResponse(pending = approvals)
    }
    override suspend fun postRecoveryStatus(): PostRecoveryStatusResponse {
        if (recoveryFails) throw ScreensError.Http(404, "no recovery")
        return PostRecoveryStatusResponse(report = recoverySnapshot)
    }
    // ---- not used in these tests; throw to catch accidental wiring ----
    override suspend fun appsList(): AppsListResponse = error("unused")
    override suspend fun appDetail(appId: String): AppDetailResponse = error("unused")
    override suspend fun marketplaceBrowse(): MarketplaceBrowseResponse = error("unused")
    override suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse = error("unused")
    override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse = error("unused")
    override suspend fun approveUnlock(requestId: String, body: UnlockApprovalApproveRequest) = error("unused")
    override suspend fun browserTabsList(appId: String): BrowserTabsListResponse = error("unused")
    override suspend fun pairedSessionsList(): PairedSessionsListResponse = error("unused")
    override suspend fun revokePairedSession(tokenPrefix: String) = error("unused")
    override suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse = error("unused")
    override suspend fun tierStatus(): TierStatusResponse = error("unused")
    override suspend fun urlControllerOwned(): UrlControllerOwnedResponse = error("unused")
    override suspend fun urlControllerClaim(req: UrlControllerClaimRequest): UrlControllerClaimResponse = error("unused")
    override suspend fun appBackupStart(req: AppBackupStartRequest): AppBackupStartResponse = error("unused")
    override suspend fun serverMetrics(podId: String): ServerMetricsResponse = error("unused")
    override suspend fun verifyCustomDomain(req: VerifyCustomDomainRequest): VerifyCustomDomainResponse = error("unused")
    override fun installEvents(serial: String): Flow<InstallEvent> = emptyFlow()
    override fun vibeCodeStream(sessionId: String): Flow<VibeCodeFrame> = emptyFlow()
}

@OptIn(ExperimentalCoroutinesApi::class)
class ActivityViewModelTest {

    @Test fun emptyFeed_succeedsWithEmptyItems() = runTest {
        val vm = ActivityViewModel(StubScreensClient(), backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        assertTrue(feed.pendingApprovals.isEmpty())
        assertTrue(feed.items.isEmpty())
    }

    @Test fun itemsMergeAndSortByTimeDescending() = runTest {
        val client = StubScreensClient(
            approvals = listOf(
                PendingUnlockApproval(serverFqdn = "home.t.flagship.services",
                    requestId = "r1", requestedAt = 100, ip = "10.0.0.1"),
            ),
            recentEvents = listOf(
                RecentInstallEvent(at = 300, kind = "deploy", appId = "wiki", detail = "v1"),
                RecentInstallEvent(at = 200, kind = "installed", appId = "plants", detail = null),
            ),
            recoverySnapshot = PostRecoverySnapshot(
                currentIrkPubHex = "ab", state = WatcherState(lastPolledAt = 0),
                lastReissue = ReissuanceReportPayload(
                    startedAt = 40, completedAt = 50, status = "complete",
                    oldIrkPrefix = "old", newIrkPrefix = "new", apps = emptyList(),
                    totalRewritten = 0, reattachedCount = 0, unchangedCount = 0,
                    undoWindowExpiresAt = 999,
                ),
            ),
        )
        val vm = ActivityViewModel(client, backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(listOf<Long>(300L, 200L, 100L, 50L), feed.items.map { it.at })
        // First two items are install events (highest at)
        assertTrue(feed.items[0] is ActivityItem.InstallEvent)
        assertTrue(feed.items[1] is ActivityItem.InstallEvent)
        assertTrue(feed.items[2] is ActivityItem.UnlockApprove)
        assertTrue(feed.items[3] is ActivityItem.RecoverySnapshot)
    }

    @Test fun toleratesDetailFailure_stillStitchesApprovals() = runTest {
        
        val client = StubScreensClient(
            approvals = listOf(
                PendingUnlockApproval(serverFqdn = "home.t.flagship.services",
                    requestId = "r1", requestedAt = 100, ip = null),
            ),
            detailFails = true,    // serverDetail() throws
            recoveryFails = true,  // postRecoveryStatus() throws
        )
        val vm = ActivityViewModel(client, backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        assertEquals(1, feed.items.size)
        assertTrue(feed.items.single() is ActivityItem.UnlockApprove)
    }

    @Test fun bubbleUpFailureWhenApprovalsThrow() = runTest {
        // approvalsThrows is the one branch that isn't wrapped in
        // runCatching — the catch in load() converts to Failed state.
        
        val vm = ActivityViewModel(StubScreensClient(approvalsThrows = true), backgroundScope)
        vm.load().join()
        val state = vm.state.first()
        assertTrue(state is LoadingState.Failed)
        assertTrue((state as LoadingState.Failed).message.contains("approvals down"))
    }

    @Test fun activityItem_recoverySnapshot_atFallsBackToStartedAtWhenNoCompleted() = runTest {
        
        val client = StubScreensClient(
            recoverySnapshot = PostRecoverySnapshot(
                currentIrkPubHex = "ab", state = WatcherState(lastPolledAt = 0),
                lastReissue = ReissuanceReportPayload(
                    startedAt = 77, completedAt = null, status = "running",
                    oldIrkPrefix = "old", newIrkPrefix = "new", apps = emptyList(),
                    totalRewritten = 0, reattachedCount = 0, unchangedCount = 0,
                    undoWindowExpiresAt = 999,
                ),
            ),
        )
        val vm = ActivityViewModel(client, backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        val snap = feed.items.single() as ActivityItem.RecoverySnapshot
        assertEquals(77, snap.at)
    }

    @Test fun activityItem_recoverySnapshot_atIsZeroWhenNoReissueAtAll() = runTest {
        
        val client = StubScreensClient(
            recoverySnapshot = PostRecoverySnapshot(
                currentIrkPubHex = "ab", state = WatcherState(lastPolledAt = 0),
                lastReissue = null,
            ),
        )
        val vm = ActivityViewModel(client, backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        val snap = feed.items.single() as ActivityItem.RecoverySnapshot
        assertEquals(0L, snap.at)
        // subtitle is null when there's no reissue report
        assertNull(snap.subtitle)
    }
}
