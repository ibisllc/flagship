// A git or IDE build a box restart cut off comes back with
// `adapt: {status: "failed", reason}` (daemon 3cadd12da): the build's page
// shows the box's sentence and offers to deploy it as it is or run the AI
// again.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildAdaptStatus
import com.flagshipserver.app.api.BuildState
import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.api.MockBuildClient
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildRestartTest {
    private val aiReason = "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy."
    private val liveReason = "The server restarted while it was putting this build live. Its files are kept: deploy it again."

    private fun vm(client: MockBuildClient, scope: TestScope) =
        BuildJournalViewModel(client, scope = scope, pollIntervalMs = 1)

    @Test fun theBoxSentencesAreInterruptions() {
        assertTrue(BuildGitViewModel.interrupted(aiReason))
        assertTrue(BuildGitViewModel.interrupted(liveReason))
        assertFalse(BuildGitViewModel.interrupted("The AI couldn't adapt this repo."))
        assertFalse(BuildGitViewModel.interrupted(null))
    }

    @Test fun anInterruptedAdaptOffersDeployAndTheAi() = runTest(StandardTestDispatcher()) {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        client.stateFixture["b1"] = BuildState("b1", "git", adapt = BuildAdaptStatus(status = "failed", reason = aiReason))
        val vm = vm(client, this)
        vm.loadDetail("b1")
        advanceUntilIdle()
        assertEquals(BuildJournalViewModel.DetailAdapt.Failed(aiReason, canRunAi = true), vm.detailAdapt.value)

        vm.deployAgain("b1")
        advanceUntilIdle()
        assertEquals(listOf("b1"), client.deployCalls)
        assertEquals(BuildJournalViewModel.DetailAdapt.Deployed("https://newapp.home.bright-maple.flagship.services/"), vm.detailAdapt.value)
    }

    @Test fun aSealedBuildOffersOnlyDeploy() = runTest(StandardTestDispatcher()) {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        client.stateFixture["b2"] = BuildState("b2", "git", adapt = BuildAdaptStatus(status = "failed", reason = liveReason), sealed = true)
        val vm = vm(client, this)
        vm.loadDetail("b2")
        advanceUntilIdle()
        assertEquals(BuildJournalViewModel.DetailAdapt.Failed(liveReason, canRunAi = false), vm.detailAdapt.value)
    }

    @Test fun runningTheAiAgainFollowsItToItsEnd() = runTest(StandardTestDispatcher()) {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        client.stateFixture["b3"] = BuildState("b3", "git", adapt = BuildAdaptStatus(status = "failed", reason = aiReason))
        client.adaptStatusFixture = BuildAdaptStatus(status = "done", fileCount = 9, deployed = true, deployedUrl = "https://plants.x/")
        val vm = vm(client, this)
        vm.loadDetail("b3")
        advanceUntilIdle()
        val cred = LlmProviderCredential(provider = "openai", apiKey = "sk-test")
        vm.runAiAgain("b3", cred)
        advanceUntilIdle()
        assertEquals(1, client.adaptStartCalls.size)
        assertEquals(true, client.adaptStartCalls.single().second.background)
        assertEquals(cred, client.adaptStartCalls.single().second.credential)
        assertEquals(BuildJournalViewModel.DetailAdapt.Deployed("https://plants.x/"), vm.detailAdapt.value)
    }

    @Test fun aBuildThatDidntFailShowsNothing() = runTest(StandardTestDispatcher()) {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = vm(client, this)
        vm.loadDetail("b4")
        advanceUntilIdle()
        assertEquals(BuildJournalViewModel.DetailAdapt.None, vm.detailAdapt.value)
    }
}
