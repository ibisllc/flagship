// Mirror of iOS PendingPodWatcherTests: a pending install's checkpoints
// reach the setup notification while the app runs, and `live` flips the pod
// online on Home.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.ProvisionStatusRecord
import com.flagshipserver.app.companion.ProvisionUpdate
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PendingPodWatcherTest {
    private val fqdn = "home.harry.flagship.services"

    @Test
    fun checkpointsAreReported_andLiveFlipsThePodOnline() = runTest {
        val app = AppState()
        val podId = app.upsertPendingPod(name = "Home", fqdn = fqdn, serial = "S1")
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val seen = mutableListOf<ProvisionUpdate>()
        val watchers = PendingPodWatchers(app, { server }, { seen += it }, pollIntervalMs = 1_000, now = { testScheduler.currentTime })

        watchers.sync(backgroundScope)
        runCurrent()
        assertTrue("no checkpoint yet: nothing reported", seen.isEmpty())

        server.provisionStatuses["S1"] = ProvisionStatusRecord(serial = "S1", phase = "installing", updatedAt = 1)
        advanceTimeBy(1_001)
        assertEquals(listOf("installing"), seen.map { it.phase })
        assertEquals("Home", seen.last().podName)
        assertEquals(PodInfo.Status.PENDING, app.pods.value.single { it.podId == podId }.status)

        server.provisionStatuses["S1"] = ProvisionStatusRecord(serial = "S1", serverDomain = fqdn, phase = "live", updatedAt = 2)
        advanceTimeBy(1_001)
        assertEquals("live", seen.last().phase)
        assertEquals(PodInfo.Status.ONLINE, app.pods.value.single { it.fqdn == fqdn }.status)

        val polls = seen.size
        advanceTimeBy(5_000)
        assertEquals("a finished install stops polling", polls, seen.size)
    }

    @Test
    fun aPodWithoutASerialOrNotPendingIsNotWatched() = runTest {
        val app = AppState()
        app.upsertPendingPod(name = "Other", fqdn = fqdn, serial = null)
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        server.provisionStatuses["S9"] = ProvisionStatusRecord(serial = "S9", phase = "installing", updatedAt = 1)
        val seen = mutableListOf<ProvisionUpdate>()
        val watchers = PendingPodWatchers(app, { server }, { seen += it }, pollIntervalMs = 1_000, now = { testScheduler.currentTime })
        watchers.sync(backgroundScope)
        advanceTimeBy(3_000)
        assertTrue(seen.isEmpty())
    }
}
