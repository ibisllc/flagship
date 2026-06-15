// State-machine tests for the build-mode ViewModels (git / mcp / journal).
// Drives the MockBuildClient through each phase and asserts the verdict /
// adapt-503-fallback / deploy / rotate / journal transitions. Mirrors
// FlagshipMobileTests/BuildModeViewModelsTests.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildEnvRequest
import com.flagshipserver.app.api.BuildEnvRequestsResponse
import com.flagshipserver.app.api.MockBuildClient
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BuildModeViewModelsTest {

    // ---------- git ----------------------------------------------------

    @Test fun git_check_fit_thenDeploy() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = true }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/you/app", "main").join()
        val verdict = vm.phase.value
        assertTrue(verdict is BuildGitViewModel.GitPhase.Verdict)
        assertTrue((verdict as BuildGitViewModel.GitPhase.Verdict).fit)
        assertNotNull(vm.buildId)
        // The wire request carried the trimmed url + ref.
        assertEquals("https://github.com/you/app", client.gitImportCalls.last().gitUrl)
        assertEquals("main", client.gitImportCalls.last().ref)

        vm.deploy().join()
        val deployed = vm.phase.value
        assertTrue(deployed is BuildGitViewModel.GitPhase.Deployed)
        assertTrue((deployed as BuildGitViewModel.GitPhase.Deployed).url.startsWith("https://"))
        assertEquals(1, client.deployCalls.size)
    }

    @Test fun git_blankRef_sentAsNull() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/you/app", "   ").join()
        assertEquals(null, client.gitImportCalls.last().ref)
    }

    @Test fun git_notFit_thenAdaptSucceeds() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = false }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/you/app", "").join()
        val verdict = vm.phase.value
        assertTrue(verdict is BuildGitViewModel.GitPhase.Verdict)
        assertTrue(!(verdict as BuildGitViewModel.GitPhase.Verdict).fit)

        vm.adapt().join()
        assertTrue(vm.phase.value is BuildGitViewModel.GitPhase.Adapted)
        assertEquals(1, client.adaptCalls.size)
    }

    @Test fun git_adapt503_fallsBackToScratchSignal() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            gitFitFixture = false
            adaptNotConfigured = true
        }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/you/app", "").join()
        vm.adapt().join()
        // The 503 maps to the scratch-fallback signal, NOT a generic failure.
        assertTrue(vm.phase.value is BuildGitViewModel.GitPhase.AdaptUnavailable)
    }

    // ---------- mcp ----------------------------------------------------

    @Test fun mcp_create_exposesConnectionAndEnvRequests() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildMcpViewModel(client, scope = backgroundScope)
        vm.create("android").join()
        assertTrue(vm.phase.value is BuildMcpViewModel.McpPhase.Ready)
        val conn = vm.connection.value
        assertNotNull(conn)
        assertTrue(conn!!.url.contains("/mcp/build/"))
        assertEquals(64, conn.key.length) // 32 bytes hex
        assertEquals("android", client.mcpCreateCalls.last().label)
        // env-requests loaded value-free.
        assertTrue(vm.envRequests.value.isNotEmpty())
        assertEquals("WEATHER_API_KEY", vm.envRequests.value.first().name)
    }

    @Test fun mcp_rotate_replacesConnection() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildMcpViewModel(client, scope = backgroundScope)
        vm.create().join()
        val firstKey = vm.connection.value!!.key
        vm.rotate("android").join()
        val secondKey = vm.connection.value!!.key
        assertTrue(firstKey != secondKey)
        assertEquals(1, client.mcpRotateCalls.size)
    }

    @Test fun mcp_envRequests_areValueFree() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            envRequestsFixture = BuildEnvRequestsResponse(
                requests = listOf(
                    BuildEnvRequest(name = "STRIPE_KEY", why = "billing", secret = true, currentlySet = false),
                ),
            )
        }
        val vm = BuildMcpViewModel(client, scope = backgroundScope)
        vm.create().join()
        val req = vm.envRequests.value.single()
        assertEquals("STRIPE_KEY", req.name)
        assertTrue(req.secret)
        // The wire shape carries only the name/why/flags — no value field exists.
    }

    @Test fun mcp_deploy_recordsStatus() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildMcpViewModel(client, scope = backgroundScope)
        vm.create().join()
        vm.deploy().join()
        assertTrue(vm.deployStatus.value!!.startsWith("Deployed →"))
        assertEquals(1, client.deployCalls.size)
    }

    // ---------- journal ------------------------------------------------

    @Test fun journal_list_thenDetail() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildJournalViewModel(client, scope = backgroundScope)
        vm.loadList().join()
        val list = vm.list.value
        assertTrue(list is LoadingState.Loaded)
        assertTrue((list as LoadingState.Loaded).value.isNotEmpty())

        val first = list.value.first().buildId
        vm.loadDetail(first).join()
        val detail = vm.detail.value
        assertTrue(detail is LoadingState.Loaded)
        assertTrue((detail as LoadingState.Loaded).value.isNotEmpty())
    }
}
