// State-machine tests for the build-mode ViewModels (git / mcp / journal).
// Drives the MockBuildClient through each phase and asserts the verdict /
// adapt-503-fallback / deploy / rotate / journal transitions. Mirrors
// FlagshipMobileTests/BuildModeViewModelsTests.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildAdaptRequest
import com.flagshipserver.app.api.BuildAdaptResponse
import com.flagshipserver.app.api.BuildClient
import com.flagshipserver.app.api.BuildDeployResponse
import com.flagshipserver.app.api.BuildEnvRequest
import com.flagshipserver.app.api.BuildEnvRequestsResponse
import com.flagshipserver.app.api.BuildGitRequest
import com.flagshipserver.app.api.BuildGitResponse
import com.flagshipserver.app.api.BuildJournalResponse
import com.flagshipserver.app.api.BuildMcpRequest
import com.flagshipserver.app.api.BuildMcpResponse
import com.flagshipserver.app.api.BuildSessionsResponse
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.core.ActiveOperation
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.DeepLink
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
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

    /** A minimal BuildClient whose deploy() blocks on a gate so a test can
     *  observe the in-flight sliver op (which the VM removes once deploy
     *  returns). gitImport mints a fixed buildId; the rest is unused. */
    private class GatedDeployClient(private val gate: CompletableDeferred<Unit>) : BuildClient {
        var lastBuildId: String = "build-gated"
        override suspend fun gitImport(req: BuildGitRequest): BuildGitResponse =
            BuildGitResponse(buildId = lastBuildId, fit = true, reason = "ok", fileCount = 3)
        override suspend fun deploy(buildId: String): BuildDeployResponse {
            gate.await()
            return BuildDeployResponse(ok = true, serviceId = "harry-app", url = "https://app/")
        }
        override suspend fun adapt(buildId: String, req: BuildAdaptRequest): BuildAdaptResponse =
            throw NotImplementedError()
        override suspend fun mcpCreate(req: BuildMcpRequest): BuildMcpResponse = throw NotImplementedError()
        override suspend fun mcpGet(buildId: String): BuildMcpResponse = throw NotImplementedError()
        override suspend fun mcpRotate(buildId: String, req: BuildMcpRequest): BuildMcpResponse = throw NotImplementedError()
        override suspend fun envRequests(buildId: String): BuildEnvRequestsResponse = throw NotImplementedError()
        override suspend fun sessions(): BuildSessionsResponse = throw NotImplementedError()
        override suspend fun journal(buildId: String): BuildJournalResponse = throw NotImplementedError()
    }

    @Test fun git_deploy_sliverOpTargetsTheBuildJournal_notTheServer() = runTest {
        // M8 — a git build's sliver op must tap through to the build's OWN
        // surface (its journal), not the server detail. With no explicit
        // operationTarget the VM derives BuildJournal(buildId).
        val gate = CompletableDeferred<Unit>()
        val client = GatedDeployClient(gate)
        val center = ActiveOperationsCenter()
        val vm = BuildGitViewModel(
            client,
            scope = backgroundScope,
            operations = center,
            serviceLabel = "your repo",
            serverLabel = "Home",
        )
        vm.checkRepo("https://github.com/you/app", "main").join()
        val buildId = vm.buildId!!

        // Kick off the deploy; it parks on the gate, so the op is live.
        val job = vm.deploy()
        runCurrent()
        val op = center.operations.value.single()
        assertEquals(ActiveOperation.Kind.BUILD, op.kind)
        assertEquals("building your repo on Home", op.label)
        // The tap target is the build's journal — NOT DeepLink.ServerDetail.
        assertEquals(DeepLink.BuildJournal(buildId), op.target)

        // Let the deploy finish → the op is cleared.
        gate.complete(Unit)
        job.join()
        assertTrue(center.operations.value.isEmpty())
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
