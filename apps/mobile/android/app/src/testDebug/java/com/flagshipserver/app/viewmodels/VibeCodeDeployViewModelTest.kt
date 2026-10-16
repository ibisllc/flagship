// The chat Deploy: a current box answers {started:true} and is followed on the
// session status through staging / fixing / going-live; an older box answers
// the finished result synchronously.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.LlmProviderCredential
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.VibeCodeDeployReply
import com.flagshipserver.app.api.VibeCodeStatusResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class VibeCodeDeployViewModelTest {

    private fun status(status: String, phase: String? = null, url: String? = null, reason: String? = null) =
        VibeCodeStatusResponse(
            status = status, deployPhase = phase, transcript = emptyList(), files = emptyMap(),
            deployedUrl = url, errorReason = reason,
        )

    /** A box that started the deploy in the background and walks [script]. */
    private fun backgroundBox(
        script: List<VibeCodeStatusResponse>,
        seen: MutableList<VibeCodeDeployViewModel.Phase>,
        vm: () -> VibeCodeDeployViewModel,
        startError: Throwable? = null,
    ): ScreensClient {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        var i = 0
        return object : ScreensClient by mock {
            override suspend fun vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?): VibeCodeDeployReply {
                startError?.let { throw it }
                return VibeCodeDeployReply(ok = true, started = true)
            }
            override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse {
                seen += vm().phase.value
                return script[minOf(i++, script.size - 1)]
            }
        }
    }

    @Test fun backgroundDeploy_followsEachPhase_toTheLiveUrl() = runTest {
        val seen = mutableListOf<VibeCodeDeployViewModel.Phase>()
        lateinit var vm: VibeCodeDeployViewModel
        val box = backgroundBox(
            listOf(
                status("deploying", "staging"),
                status("deploying", "fixing"),
                status("deploying", "going-live"),
                status("deployed", url = "https://habits.home.me.flagship.services"),
            ),
            seen, { vm },
        )
        vm = VibeCodeDeployViewModel("s1", box, scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(
            listOf(null, "staging", "fixing", "going-live"),
            seen.map { (it as VibeCodeDeployViewModel.Phase.Deploying).stage },
        )
        assertEquals(VibeCodeDeployViewModel.Phase.Deployed("https://habits.home.me.flagship.services"), vm.phase.value)
    }

    @Test fun backgroundDeploy_thatFails_showsTheReason() = runTest {
        lateinit var vm: VibeCodeDeployViewModel
        val box = backgroundBox(
            listOf(status("deploying", "staging"), status("failed", reason = "The app didn't start on its test copy.")),
            mutableListOf(), { vm },
        )
        vm = VibeCodeDeployViewModel("s1", box, scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(VibeCodeDeployViewModel.Phase.Failed("The app didn't start on its test copy."), vm.phase.value)
    }

    @Test fun anOlderBox_answersTheFinishedResultAtOnce() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        var polled = false
        val oldBox = object : ScreensClient by mock {
            override suspend fun vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?) =
                VibeCodeDeployReply(ok = true, serviceId = "me--habits", url = "https://habits.home.me.flagship.services", inviteOnly = false)
            override suspend fun vibeCodeStatus(sessionId: String): VibeCodeStatusResponse {
                polled = true
                return mock.vibeCodeStatus(sessionId)
            }
        }
        val vm = VibeCodeDeployViewModel("s1", oldBox, scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(
            VibeCodeDeployViewModel.Phase.Deployed("https://habits.home.me.flagship.services", leftOpen = true),
            vm.phase.value,
        )
        assertEquals(false, polled)
    }

    @Test fun theDefaultClientCall_isTheWaitingDeploy() = runTest {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val waiting = object : ScreensClient by mock {
            override suspend fun vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?): VibeCodeDeployReply =
                super<ScreensClient>.vibeCodeDeployStart(sessionId, credential)
        }
        val reply = waiting.vibeCodeDeployStart("s1")
        assertEquals(null, reply.started)
        assertEquals(true, reply.ok)
        val vm = VibeCodeDeployViewModel("s1", waiting, scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(true, vm.phase.value is VibeCodeDeployViewModel.Phase.Deployed)
    }

    @Test fun aSecondDeployWhileOneRuns_followsTheRunningOne() = runTest {
        lateinit var vm: VibeCodeDeployViewModel
        val box = backgroundBox(
            listOf(status("deploying", "going-live"), status("deployed", url = "https://a.home.me.flagship.services")),
            mutableListOf(), { vm },
            startError = ScreensError.Http(409, """{"error":"already deploying"}"""),
        )
        vm = VibeCodeDeployViewModel("s1", box, scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(VibeCodeDeployViewModel.Phase.Deployed("https://a.home.me.flagship.services"), vm.phase.value)
    }

    @Test fun otherRefusals_showTheBoxsWords() = runTest {
        lateinit var vm: VibeCodeDeployViewModel
        val box = backgroundBox(
            listOf(status("ready-to-deploy")), mutableListOf(), { vm },
            startError = ScreensError.Http(409, """{"error":"cannot deploy while awaiting a tool response"}"""),
        )
        vm = VibeCodeDeployViewModel("s1", box, scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(VibeCodeDeployViewModel.Phase.Failed("cannot deploy while awaiting a tool response"), vm.phase.value)
    }

    @Test fun theMockWalksThePhases() = runTest {
        val vm = VibeCodeDeployViewModel("s1", MockScreensClient(simulatedLatencyMs = 0), scope = backgroundScope, pollIntervalMs = 10)
        vm.deploy().join()
        assertEquals(true, vm.phase.value is VibeCodeDeployViewModel.Phase.Deployed)
    }

    @Test fun stageText() {
        assertEquals("Testing the app on a private copy…", VibeCodeDeployViewModel.stageText("staging"))
        assertEquals("The AI is fixing a problem it found…", VibeCodeDeployViewModel.stageText("fixing"))
        assertEquals("Installing…", VibeCodeDeployViewModel.stageText("going-live"))
        assertEquals("Deploying…", VibeCodeDeployViewModel.stageText(null))
    }
}
