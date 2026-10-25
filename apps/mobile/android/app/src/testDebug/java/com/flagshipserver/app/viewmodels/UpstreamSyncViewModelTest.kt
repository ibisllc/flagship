// "Check for updates from <repo>" (N12): the request names the app and the chosen version, the
// proposal reads as counts with capability changes apart, an up-to-date answer offers nothing to
// deploy and opens no build, a proposal's build is discarded on leaving, and an app not imported here says so.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildSyncResponse
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.SyncCapabilityChange
import com.flagshipserver.app.api.SyncProposal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpstreamSyncViewModelTest {
    private fun vm(client: MockBuildClient) = UpstreamSyncViewModel("bright-maple--plants", client, CoroutineScope(Dispatchers.Unconfined))

    @Test fun theRequestNamesTheAppAndTheChosenVersion() = runBlocking {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val m = vm(client)
        m.check("  v2.1  ").join()
        m.check("").join()
        assertEquals(listOf("bright-maple--plants" to "v2.1", "bright-maple--plants" to null), client.syncCalls)
    }

    @Test fun theProposalReadsAsCountsWithPermissionsApart() = runBlocking {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val m = vm(client)
        m.check("").join()
        val r = (m.phase.value as UpstreamSyncViewModel.Phase.Proposal).result
        assertEquals("Version 4f2a9c0e1b7d", UpstreamSyncText.version(r.candidateCommit))
        assertEquals(listOf("2 files updated from upstream", "1 of your changes kept"), UpstreamSyncText.counts(r))
        assertEquals("1 conflict: your version was kept", UpstreamSyncText.conflictsHeading(r.proposal.conflicts.size))
        val c = r.proposal.capabilityChanges.single()
        assertEquals("Internet access", UpstreamSyncText.section(c.section))
        assertEquals(listOf("Adds: api.rain.example"), UpstreamSyncText.changeLines(c))
        assertEquals(listOf("Adds: a, b", "Removes: c"), UpstreamSyncText.changeLines(SyncCapabilityChange("x", listOf("a", "b"), listOf("c"))))
        assertEquals("Public pages", UpstreamSyncText.section("access"))
        assertEquals("custom.section", UpstreamSyncText.section("custom.section"))
        assertEquals("3 files already match", UpstreamSyncText.counts(BuildSyncResponse(buildId = "b", proposal = SyncProposal(alreadyApplied = listOf("a", "b", "c")))).single())
        assertNull(UpstreamSyncText.version(null))
    }

    @Test fun upToDateOffersNothingAndOpensNoBuild() = runBlocking {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        client.syncFixture = BuildSyncResponse(candidateCommit = "abc", upToDate = true)
        val m = vm(client)
        m.check("").join()
        assertEquals(UpstreamSyncViewModel.Phase.UpToDate, m.phase.value)
        assertNull(m.discard())
        assertTrue(client.discardCalls.isEmpty())
    }

    @Test fun discardingAProposalForgetsItsBuild() = runBlocking {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val m = vm(client)
        m.check("").join()
        assertEquals("bld-sync-0001", (m.phase.value as UpstreamSyncViewModel.Phase.Proposal).buildId)
        m.discard()?.join()
        assertEquals(listOf("bld-sync-0001"), client.discardCalls)
        assertEquals(UpstreamSyncViewModel.Phase.Idle, m.phase.value)
    }

    @Test fun anAppNotImportedHereSaysSo() = runBlocking {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        client.syncError = ScreensError.Http(404, """{"error":"this app was not imported from a repo on this server, or its import is too large to sync"}""")
        val m = vm(client)
        m.check("").join()
        assertEquals(
            "This app wasn't imported from a repo on this server, so it can't check for updates.",
            (m.phase.value as UpstreamSyncViewModel.Phase.Failed).message,
        )
        client.syncError = ScreensError.Http(422, """{"error":"the repo could not be read"}""")
        m.check("").join()
        assertEquals("the repo could not be read", (m.phase.value as UpstreamSyncViewModel.Phase.Failed).message)
        assertTrue(client.discardCalls.isEmpty())
    }
}
