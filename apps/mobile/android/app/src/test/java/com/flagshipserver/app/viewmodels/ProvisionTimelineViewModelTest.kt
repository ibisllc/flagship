// Mirror of the iOS ProvisionTimelineTests (commit 48a4b9e). Pins the two
// poller modes: ORDER (deep per-order status with the locally-held serial)
// and the DIRECTORY fallback for a serial-less pod (project pending[].phase,
// flip terminal-live when the fqdn registers, never on a revoked row).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.PendingPodEntry
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.PodsDirectoryResponse
import com.flagshipserver.app.api.ProvisionStatusEntry
import com.flagshipserver.app.api.ProvisionStatusRecord
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvisionTimelineViewModelTest {

    private fun record(serial: String, phase: String, history: List<String> = emptyList()) =
        ProvisionStatusRecord(
            serial = serial,
            serverDomain = null,
            phase = phase,
            updatedAt = 1L,
            history = history.map { ProvisionStatusEntry(phase = it, ts = 1L) },
        )

    private fun directory(
        pods: List<PodDirectoryEntry> = emptyList(),
        pending: List<PendingPodEntry> = emptyList(),
    ) = PodsDirectoryResponse(username = "harry", pods = pods, pending = pending)

    // ── Order mode ────────────────────────────────────────────────

    @Test fun orderMode_appliesRecordAndStopsOnTerminal() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val vm = ProvisionTimelineViewModel("SER-1", server)

        // No checkpoint yet (the Worker's 404) → keep waiting.
        assertFalse(vm.pollOnce())
        assertNull(vm.status.value)

        server.provisionStatuses["SER-1"] = record("SER-1", "installing")
        assertFalse(vm.pollOnce())
        assertEquals("installing", vm.status.value?.phase)
        assertFalse(vm.isDone)

        server.provisionStatuses["SER-1"] = record("SER-1", "live")
        assertTrue(vm.pollOnce())
        assertEquals("live", vm.status.value?.phase)
        assertTrue(vm.isDone)
    }

    @Test fun orderMode_networkFailureKeepsLastStatus() = runTest {
        val server = MockFlagshipServerClient(simulatedLatencyMs = 0)
        server.provisionStatuses["SER-1"] = record("SER-1", "registering")
        val vm = ProvisionTimelineViewModel("SER-1", server)
        assertFalse(vm.pollOnce())
        assertEquals("registering", vm.status.value?.phase)

        server.shouldFail = true
        assertFalse(vm.pollOnce())
        // A blip never wipes the last good status.
        assertEquals("registering", vm.status.value?.phase)
    }

    // ── Directory fallback (serial-less pod) ──────────────────────

    @Test fun directoryMode_synthesizesPhaseFromPendingEntry() = runTest {
        // A pod surfaced from `/pods` carries no serial — the VM polls the
        // directory and projects pending[].phase onto the ladder.
        val dir = directory(
            pending = listOf(
                PendingPodEntry(
                    orderRef = "ab".repeat(32),
                    serverName = "abc",
                    fqdn = "abc.harry.flagship.services",
                    phase = "installing",
                    createdAt = 1L,
                ),
            ),
        )
        val vm = ProvisionTimelineViewModel("harry", "ABC.harry.flagship.services") { dir }
        assertFalse(vm.pollOnce())
        assertEquals("installing", vm.status.value?.phase)
        assertEquals("ABC.harry.flagship.services", vm.status.value?.serverDomain)
        assertTrue(vm.status.value?.history?.isEmpty() == true)
        assertFalse(vm.isDone)
    }

    @Test fun directoryMode_flipsLiveOnlyWhenServing_andStops() = runTest {
        // Registered AND serving (lastReported set ⇒ cameOnline) is terminal.
        val dir = directory(
            pods = listOf(
                PodDirectoryEntry(
                    serverDomain = "abc.harry.flagship.services",
                    identityPubKey = "00".repeat(32),
                    lastReported = 1L,
                ),
            ),
        )
        val vm = ProvisionTimelineViewModel("harry", "abc.harry.flagship.services") { dir }
        assertTrue(vm.pollOnce())
        assertEquals("live", vm.status.value?.phase)
        assertTrue(vm.isDone)
    }

    @Test fun directoryMode_registeredButNotServing_doesNotFlipLive() = runTest {
        // The office.harry2 bug: registered (in /pods) but NOT serving — no cert,
        // no heartbeat (cameOnline=false), awaiting a boot-unlock approval. The
        // ladder must NOT read "complete".
        val dir = directory(
            pods = listOf(
                PodDirectoryEntry(
                    serverDomain = "abc.harry.flagship.services",
                    identityPubKey = "00".repeat(32),
                    awaitingUnlock = true,
                ),
            ),
        )
        val vm = ProvisionTimelineViewModel("harry", "abc.harry.flagship.services") { dir }
        assertFalse(vm.pollOnce())
        assertFalse(vm.status.value?.phase == "live")
        assertFalse(vm.isDone)
    }

    @Test fun directoryMode_revokedRegistrationDoesNotFlipLive() = runTest {
        // A revoked registration is NOT the live box; with the pending order
        // also gone the ladder stays on the waiting state (the reconciler is
        // what removes the pod itself).
        val dir = directory(
            pods = listOf(
                PodDirectoryEntry(
                    serverDomain = "abc.harry.flagship.services",
                    identityPubKey = "00".repeat(32),
                    revokedAt = 5L,
                ),
            ),
        )
        val vm = ProvisionTimelineViewModel("harry", "abc.harry.flagship.services") { dir }
        assertFalse(vm.pollOnce())
        assertNull(vm.status.value)
        assertFalse(vm.isDone)
    }

    @Test fun directoryMode_unreachableDirectoryKeepsWaiting() = runTest {
        val vm = ProvisionTimelineViewModel("harry", "abc.harry.flagship.services") { null }
        assertFalse(vm.pollOnce())
        assertNull(vm.status.value)
        assertFalse(vm.isDone)
    }

    @Test fun directoryMode_unknownOrAbsentPhaseIsNoCheckpointYet() = runTest {
        // Forward-compat: an unrecognised wire phase (newer Worker) and a
        // null phase both read as "no checkpoint yet", never a crash.
        val dir = directory(
            pending = listOf(
                PendingPodEntry(
                    serverName = "abc",
                    fqdn = "abc.harry.flagship.services",
                    phase = "some-future-phase",
                ),
                PendingPodEntry(
                    serverName = "other",
                    fqdn = "other.harry.flagship.services",
                    phase = null,
                ),
            ),
        )
        val vm = ProvisionTimelineViewModel("harry", "abc.harry.flagship.services") { dir }
        assertFalse(vm.pollOnce())
        assertNull(vm.status.value)

        val vm2 = ProvisionTimelineViewModel("harry", "other.harry.flagship.services") { dir }
        assertFalse(vm2.pollOnce())
        assertNull(vm2.status.value)
    }
}
