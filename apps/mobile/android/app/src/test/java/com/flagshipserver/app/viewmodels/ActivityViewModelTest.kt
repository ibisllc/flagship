// Exercise the fan-out + merge-by-time + tolerant-failure branches in
// ActivityViewModel.load(). Uses a hand-written fake so each test pins a
// deterministic outcome.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AppInviteAccessResponse
import com.flagshipserver.app.api.AppInviteIssueRequest
import com.flagshipserver.app.api.AppInviteIssueResponse
import com.flagshipserver.app.api.AppInviteListResponse
import com.flagshipserver.app.api.AppInviteRevokeRequest
import com.flagshipserver.app.api.AppInviteRevokeResponse
import com.flagshipserver.app.api.AppsListResponse
import com.flagshipserver.app.api.CompanionListResponse
import com.flagshipserver.app.api.CompanionMintTicketRequest
import com.flagshipserver.app.api.CompanionMintTicketResponse
import com.flagshipserver.app.api.CompanionPendingWritesResponse
import com.flagshipserver.app.api.CompanionResolvePendingRequest
import com.flagshipserver.app.api.CompanionResolvePendingResponse
import com.flagshipserver.app.api.CompanionRevokeRequest
import com.flagshipserver.app.api.CompanionRevokeResponse
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.AppBackupStartRequest
import com.flagshipserver.app.api.AppBackupStartResponse
import com.flagshipserver.app.api.BrowserTabsListResponse
import com.flagshipserver.app.api.InstallEvent
import com.flagshipserver.app.api.InstallServiceEnvelope
import com.flagshipserver.app.api.InstallServiceResponse
import com.flagshipserver.app.api.MarketplaceBrowseResponse
import com.flagshipserver.app.api.MarketplaceListingDetail
import com.flagshipserver.app.api.OrdersSendRequest
import com.flagshipserver.app.api.OrdersSendResponse
import com.flagshipserver.app.api.PairedSessionsListResponse
import com.flagshipserver.app.api.PostRecoverySnapshot
import com.flagshipserver.app.api.PostRecoveryStatusResponse
import com.flagshipserver.app.api.RecentInstallEvent
import com.flagshipserver.app.api.ReissuanceReportPayload
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.ServerDetailResponse
import com.flagshipserver.app.api.ServerMetricsResponse
import com.flagshipserver.app.api.TierStatusResponse
import com.flagshipserver.app.api.UrlControllerClaimRequest
import com.flagshipserver.app.api.UrlControllerClaimResponse
import com.flagshipserver.app.api.UrlControllerOwnedResponse
import com.flagshipserver.app.api.VerifyCustomDomainRequest
import com.flagshipserver.app.api.VerifyCustomDomainResponse
import com.flagshipserver.app.api.ServiceEnvListResponse
import com.flagshipserver.app.api.ServiceEnvOpResponse
import com.flagshipserver.app.api.ServiceEnvSetRequest
import com.flagshipserver.app.api.ServiceEnvUnsetRequest
import com.flagshipserver.app.api.VibeCodeFrame
import com.flagshipserver.app.api.VibeCodeReplyRequest
import com.flagshipserver.app.api.VibeCodeReplyResponse
import com.flagshipserver.app.api.VibeCodeSessionPublicState
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
    var recentEvents: List<RecentInstallEvent> = emptyList(),
    var recoverySnapshot: PostRecoverySnapshot? = null,
    var detailFails: Boolean = false,
    var recoveryFails: Boolean = false,
) : ScreensClient {
    override suspend fun serverDetail(): ServerDetailResponse {
        if (detailFails) throw ScreensError.Http(500, "detail down")
        return ServerDetailResponse(
            serverFqdn = "home.test.flagship.services",
            username = "test", daemonVersion = "0", startedAt = 0, uptimeMs = 0,
            certSans = emptyList(), serviceCount = 0, pairedSessionCount = 0,
            recentInstallEvents = recentEvents,
        )
    }
    override suspend fun postRecoveryStatus(): PostRecoveryStatusResponse {
        if (recoveryFails) throw ScreensError.Http(404, "no recovery")
        return PostRecoveryStatusResponse(report = recoverySnapshot)
    }
    // ---- not used in these tests; throw to catch accidental wiring ----
    override suspend fun appsList(): AppsListResponse = error("unused")
    override suspend fun appDetail(serviceId: String): AppDetailResponse = error("unused")
    override suspend fun marketplaceBrowse(): MarketplaceBrowseResponse = error("unused")
    override suspend fun marketplaceFetchListing(creator: String, slug: String): MarketplaceListingDetail = error("unused")
    override suspend fun installFromMarketplace(envelope: InstallServiceEnvelope): InstallServiceResponse = error("unused")
    override suspend fun vibeCodeStart(req: VibeCodeStartRequest): VibeCodeStartResponse = error("unused")
    override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse = error("unused")
    override suspend fun browserTabsList(serviceId: String): BrowserTabsListResponse = error("unused")
    override suspend fun pairedSessionsList(): PairedSessionsListResponse = error("unused")
    override suspend fun revokePairedSession(tokenPrefix: String) = error("unused")
    override suspend fun ordersSend(req: OrdersSendRequest): OrdersSendResponse = error("unused")
    override suspend fun tierStatus(): TierStatusResponse = error("unused")
    override suspend fun peerBackupStatus(): PeerBackupStatusResponse = error("unused")
    override suspend fun peerBackupToggle(participate: Boolean): PeerBackupStatusResponse = error("unused")
    override suspend fun urlControllerOwned(): UrlControllerOwnedResponse = error("unused")
    override suspend fun urlControllerClaim(req: UrlControllerClaimRequest): UrlControllerClaimResponse = error("unused")
    override suspend fun appBackupStart(req: AppBackupStartRequest): AppBackupStartResponse = error("unused")
    override suspend fun serverMetrics(podId: String): ServerMetricsResponse = error("unused")
    override suspend fun verifyCustomDomain(req: VerifyCustomDomainRequest): VerifyCustomDomainResponse = error("unused")
    override suspend fun serviceEnvList(appId: String): ServiceEnvListResponse = error("unused")
    override suspend fun serviceEnvSet(appId: String, req: ServiceEnvSetRequest): ServiceEnvOpResponse = error("unused")
    override suspend fun serviceEnvUnset(appId: String, req: ServiceEnvUnsetRequest): ServiceEnvOpResponse = error("unused")
    override suspend fun vibeCodeSessionState(sessionId: String): VibeCodeSessionPublicState = error("unused")
    override suspend fun vibeCodeSessionReply(sessionId: String, req: VibeCodeReplyRequest): VibeCodeReplyResponse = error("unused")
    override suspend fun appInviteIssue(req: AppInviteIssueRequest): AppInviteIssueResponse = error("unused")
    override suspend fun appInviteList(serviceId: String): AppInviteListResponse = error("unused")
    override suspend fun appInviteAccess(serviceId: String): AppInviteAccessResponse = error("unused")
    override suspend fun appInviteRevoke(req: AppInviteRevokeRequest): AppInviteRevokeResponse = error("unused")
    override suspend fun companionMintTicket(req: CompanionMintTicketRequest): CompanionMintTicketResponse = error("unused")
    override suspend fun companionList(): CompanionListResponse = error("unused")
    override suspend fun companionRevoke(req: CompanionRevokeRequest): CompanionRevokeResponse = error("unused")
    override suspend fun companionPendingWrites(): CompanionPendingWritesResponse = error("unused")
    override suspend fun companionResolvePending(req: CompanionResolvePendingRequest): CompanionResolvePendingResponse = error("unused")
    override fun installEvents(serial: String): Flow<InstallEvent> = emptyFlow()
    override fun vibeCodeStream(sessionId: String): Flow<VibeCodeFrame> = emptyFlow()
    override fun browserTabStream(tabId: String): com.flagshipserver.app.api.BrowserStream =
        com.flagshipserver.app.api.MockBrowserStream()
}

@OptIn(ExperimentalCoroutinesApi::class)
class ActivityViewModelTest {

    @Test fun emptyFeed_succeedsWithEmptyItems() = runTest {
        val vm = ActivityViewModel(StubScreensClient(), backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        assertTrue(feed.items.isEmpty())
    }

    @Test fun itemsMergeAndSortByTimeDescending() = runTest {
        val client = StubScreensClient(
            recentEvents = listOf(
                RecentInstallEvent(at = 300, kind = "deploy", serviceId = "wiki", detail = "v1"),
                RecentInstallEvent(at = 200, kind = "installed", serviceId = "plants", detail = null),
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
        assertEquals(listOf<Long>(300L, 200L, 50L), feed.items.map { it.at })
        assertTrue(feed.items[0] is ActivityItem.InstallEvent)
        assertTrue(feed.items[1] is ActivityItem.InstallEvent)
        assertTrue(feed.items[2] is ActivityItem.RecoverySnapshot)
    }

    @Test fun toleratesDetailAndRecoveryFailure_yieldsEmptyLoadedFeed() = runTest {
        // Both the daemon detail fetch and the recovery fetch throw; they're
        // each wrapped in runCatching, so the feed still loads (empty) rather
        // than flipping to Failed.
        val client = StubScreensClient(detailFails = true, recoveryFails = true)
        val vm = ActivityViewModel(client, backgroundScope)
        vm.load().join()
        val feed = (vm.state.first() as LoadingState.Loaded).value
        assertTrue(feed.items.isEmpty())
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
        assertNull(snap.subtitle)
    }
}
