// P9 — PeerBackupViewModel state machine + toggle round-trip.
//
// Mirrors FlagshipMobileTests/PeerBackupViewModelTests.swift 1:1:
//   - default fixture is honest-empty (matches the daemon's honest default).
//   - load() Idle → Loading → Loaded transition.
//   - toggle() flips and re-stores via the same wire shape.
//   - toggle() before load() defaults to participate=true (matches iOS).
//   - failures land in LoadingState.Failed.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.PeerBackupPeerHostingYou
import com.flagshipserver.app.api.PeerBackupPeerYouHost
import com.flagshipserver.app.api.PeerBackupRepairStatus
import com.flagshipserver.app.api.PeerBackupShardSummary
import com.flagshipserver.app.api.PeerBackupStats
import com.flagshipserver.app.api.PeerBackupStatusResponse
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PeerBackupViewModelTest {

    @Test fun mockDefault_isHonestEmpty() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val r = client.peerBackupStatus()
        assertFalse(r.participating)
        assertTrue(r.peersBackingYouUp.isEmpty())
        assertTrue(r.peersYouBackUp.isEmpty())
        assertTrue(r.shards.isEmpty())
        assertEquals(0, r.stats.total)
        assertEquals(0, r.stats.durable)
        assertEquals(0, r.stats.atRisk)
        assertEquals(0L, r.stats.yourBytesStored)
        assertEquals(0L, r.stats.peerBytesHosted)
        assertEquals("idle", r.repair.state)
        assertNull(r.repair.lastTickMs)
        assertEquals(0, r.repair.queued)
        assertEquals(0, r.repair.completed24h)
        assertNull(r.repair.lastError)
    }

    @Test fun load_defaultFixture_landsLoaded() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertFalse(s.value.participating)
        assertTrue(s.value.peersBackingYouUp.isEmpty())
    }

    @Test fun load_pinnedFixture_isReturnedVerbatim() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            peerBackupStatusFixture = PeerBackupStatusResponse(
                participating = true,
                peersBackingYouUp = listOf(
                    PeerBackupPeerHostingYou(
                        peerFqdn = "bob.bob.flagship.services",
                        shardsHosted = 4,
                        lastSeenMs = 1_700_000_000_000L,
                        online = true,
                    ),
                ),
                peersYouBackUp = listOf(
                    PeerBackupPeerYouHost(
                        peerFqdn = "carol.carol.flagship.services",
                        shardsHosted = 7,
                        bytesHosted = 1024L * 1024,
                        lastFetchedMs = 1_700_000_001_000L,
                    ),
                ),
                shards = listOf(
                    PeerBackupShardSummary(shardId = "deadbeef", replicas = 3, minReplicas = 3, bytes = 0L),
                    PeerBackupShardSummary(shardId = "feedface", replicas = 1, minReplicas = 3, bytes = 0L),
                ),
                repair = PeerBackupRepairStatus(
                    state = "running",
                    lastTickMs = 1_700_000_002_000L,
                    queued = 2,
                    completed24h = 17,
                    lastError = null,
                ),
                stats = PeerBackupStats(
                    total = 2, durable = 1, atRisk = 1,
                    yourBytesStored = 0L, peerBytesHosted = 1024L * 1024,
                ),
            )
        }
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first() as LoadingState.Loaded
        assertTrue(s.value.participating)
        assertEquals(1, s.value.peersBackingYouUp.size)
        assertEquals("bob.bob.flagship.services", s.value.peersBackingYouUp.first().peerFqdn)
        assertEquals(4, s.value.peersBackingYouUp.first().shardsHosted)
        assertTrue(s.value.peersBackingYouUp.first().online)
        assertEquals(1024L * 1024, s.value.peersYouBackUp.first().bytesHosted)
        assertEquals(2, s.value.shards.size)
        assertEquals(1, s.value.stats.atRisk)
        assertEquals("running", s.value.repair.state)
        assertEquals(17, s.value.repair.completed24h)
    }

    @Test fun toggle_fromUnenrolled_flipsToParticipating() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.load().join()
        vm.toggle().join()
        assertEquals(listOf(true), client.togglePeerBackupCalls)
        val s = vm.state.first() as LoadingState.Loaded
        assertTrue(s.value.participating)
    }

    @Test fun toggle_fromParticipating_flipsToUnenrolled() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0).apply {
            peerBackupStatusFixture = PeerBackupStatusResponse(
                participating = true,
                peersBackingYouUp = emptyList(),
                peersYouBackUp = emptyList(),
                shards = emptyList(),
                repair = PeerBackupRepairStatus(
                    state = "idle", lastTickMs = null, queued = 0, completed24h = 0, lastError = null,
                ),
                stats = PeerBackupStats(0, 0, 0, 0L, 0L),
            )
        }
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.load().join()
        vm.toggle().join()
        assertEquals(listOf(false), client.togglePeerBackupCalls)
        val s = vm.state.first() as LoadingState.Loaded
        assertFalse(s.value.participating)
    }

    @Test fun toggle_beforeLoad_sendsTrue() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.toggle().join()
        assertEquals(listOf(true), client.togglePeerBackupCalls)
    }

    @Test fun load_transportError_landsInFailed() = runTest {
        val throwing = object : ScreensClient by MockScreensClient(simulatedLatencyMs = 0) {
            override suspend fun peerBackupStatus(): PeerBackupStatusResponse =
                throw ScreensError.Http(503, "transport down")
        }
        val vm = PeerBackupViewModel(throwing, scope = backgroundScope)
        vm.load().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
        val msg = (s as LoadingState.Failed).message
        // UX-B: the raw status / body is humanized away.
        assertFalse(msg, msg.contains("503") || msg.contains("transport down"))
        assertTrue(msg, msg.contains("try again", ignoreCase = true))
    }

    @Test fun toggle_transportError_landsInFailed() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        val vm = PeerBackupViewModel(client, scope = backgroundScope)
        vm.load().join()
        client.shouldFail = true
        vm.toggle().join()
        val s = vm.state.first()
        assertTrue("expected Failed, was $s", s is LoadingState.Failed)
    }
}
