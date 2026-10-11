// State-machine tests for the build-mode ViewModels (git / mcp / journal).
// Drives the MockBuildClient through each phase and asserts the verdict /
// adapt-503-fallback / deploy / rotate / journal transitions. Mirrors
// FlagshipMobileTests/BuildModeViewModelsTests.swift.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.BuildAdaptReply
import com.flagshipserver.app.api.BuildAdaptRequest
import com.flagshipserver.app.api.BuildAdaptStatus
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
import com.flagshipserver.app.api.BuildStateResponse
import com.flagshipserver.app.api.MockBuildClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.core.ActiveOperation
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.DeepLink
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    @Test fun git_check404_showsPlatformAbsentMessage() = runTest {
        // A 404 on "Check repo" means the box has no service/build platform —
        // surface the platform-absent copy, not the generic 404 string.
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { entryFailStatus = 404 }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/you/app", "").join()
        val phase = vm.phase.value
        assertTrue(phase is BuildGitViewModel.GitPhase.Failed)
        val msg = (phase as BuildGitViewModel.GitPhase.Failed).message
        assertTrue("expected platform-absent copy, got: $msg",
            msg.contains("isn't set up to build services"))
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
        assertEquals(BuildGitViewModel.GitPhase.Adapted(fileCount = 12), vm.phase.value)
        assertEquals(true, client.adaptStartCalls.single().second.background)
    }

    @Test fun git_sendsTheTypedNameAsALabel() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/random", "", "My App").join()
        assertEquals("myapp", client.gitImportCalls.last().name)
        assertEquals("myapp", vm.assignedName.value)

        client.gitAssignedNameFixture = "random-dev"
        vm.checkRepo("https://github.com/me/random", "dev", "").join()
        assertNull(client.gitImportCalls.last().name)
        assertEquals("random-dev", vm.assignedName.value)
    }

    @Test fun git_takenName_raisesTheConflict() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            gitImportError = ScreensError.Http(
                409,
                """{"error":"A build session already uses the name \"notes\".","ok":false,"kind":"session","sessionId":"s1","message":"x"}""",
            )
        }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/notes", "", "notes").join()
        assertEquals("session", vm.conflict.value?.kind)
        assertEquals("s1", vm.conflict.value?.sessionId)
        assertNull(vm.buildId)
        assertEquals(BuildGitViewModel.GitPhase.Idle, vm.phase.value)
        vm.dismissConflict()
        assertNull(vm.conflict.value)
    }

    @Test fun git_cloneFailure_showsTheBoxReason() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            gitImportError = ScreensError.Http(
                422,
                """{"error":"Couldn't clone this repo. Check the address, and that the repo is public."}""",
            )
        }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/missing", "").join()
        assertEquals(
            BuildGitViewModel.GitPhase.Failed("Couldn't clone this repo. Check the address, and that the repo is public."),
            vm.phase.value,
        )
    }

    @Test fun git_adaptThatDeployed_showsItInstalled() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            gitFitFixture = false
            adaptStatusFixture = BuildAdaptStatus(
                status = "done", fileCount = 8, deployed = true, deployedUrl = "https://hello.home.me.flagship.services",
            )
        }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/hello", "").join()
        vm.adapt().join()
        assertEquals(BuildGitViewModel.GitPhase.Deployed("https://hello.home.me.flagship.services"), vm.phase.value)
    }

    @Test fun git_failedAdapt_restoresTheVerdictWithTheReason() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            gitFitFixture = false
            adaptStatusFixture = BuildAdaptStatus(status = "failed", reason = "adapt model call failed: bad key")
        }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/hello", "").join()
        vm.adapt().join()
        assertEquals("adapt model call failed: bad key", vm.adaptError.value)
        assertTrue(vm.phase.value is BuildGitViewModel.GitPhase.Verdict)
    }

    @Test fun git_exportAdapter_savesTheFileToShare() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/random", "").join()
        val dir = java.nio.file.Files.createTempDirectory("adapters").toFile()
        try {
            vm.exportAdapter(dir)!!.join()
            val file = requireNotNull(vm.adapterFile.value)
            assertEquals("flagship.app.json", file.name)
            assertTrue(file.readText().contains("\"adapter\""))
            assertNull(vm.exportError.value)
            assertEquals(false, vm.exportingAdapter.value)
            vm.adapterFileShared()
            assertNull(vm.adapterFile.value)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun git_exportAdapter_showsTheBoxReason() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply {
            adapterFileError = ScreensError.Http(404, """{"error":"no flagship.app.json for this build"}""")
        }
        val vm = BuildGitViewModel(client, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/random", "").join()
        val dir = java.nio.file.Files.createTempDirectory("adapters").toFile()
        try {
            vm.exportAdapter(dir)!!.join()
            assertNull(vm.adapterFile.value)
            assertEquals("no flagship.app.json for this build", vm.exportError.value)
            assertEquals(false, vm.exportingAdapter.value)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun git_adaptOnAnOlderBox_usesTheFinishedReply() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = false }
        val oldBox = object : BuildClient by mock {
            override suspend fun adaptStart(buildId: String, req: BuildAdaptRequest) =
                BuildAdaptReply(ok = true, fileCount = 7)
        }
        val vm = BuildGitViewModel(oldBox, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/hello", "").join()
        vm.adapt().join()
        assertEquals(BuildGitViewModel.GitPhase.Adapted(fileCount = 7), vm.phase.value)
    }

    @Test fun git_adaptKeepsPollingThroughAFewDroppedPolls() = runTest {
        val mock = MockBuildClient(simulatedLatencyMs = 0).apply { gitFitFixture = false }
        var polls = 0
        val flaky = object : BuildClient by mock {
            override suspend fun state(buildId: String): BuildStateResponse {
                polls++
                if (polls <= 4) throw ScreensError.Http(502, "")
                return mock.state(buildId)
            }
        }
        val vm = BuildGitViewModel(flaky, scope = backgroundScope)
        vm.checkRepo("https://github.com/me/hello", "").join()
        vm.adapt().join()
        assertEquals(BuildGitViewModel.GitPhase.Adapted(fileCount = 12), vm.phase.value)
    }

    @Test fun git_notReadyCard_saysItPlainly() {
        assertEquals(
            "This repo has no flagship.app.json and is not yet adapted to run on Flagship.",
            BuildGitViewModel.notReadyText("no flagship.app.json — repo isn't a Flagship app yet; the AI can adapt it"),
        )
        val broken = "flagship.app.json present but invalid: name"
        assertEquals(broken, BuildGitViewModel.notReadyText(broken))
    }

    @Test fun git_addressAndHint_followTheName() {
        assertEquals("notes", BuildGitViewModel.addressLabel("notes", "random"))
        assertEquals("random-dev", BuildGitViewModel.addressLabel("", "random-dev"))
        assertEquals("<repo name>", BuildGitViewModel.addressLabel("", null))
        assertEquals("Leave it blank to name it after the repo.", BuildGitViewModel.blankNameHint(""))
        assertEquals("Leave it blank to name it after the repo and branch.", BuildGitViewModel.blankNameHint("dev"))
        assertEquals("my-app2", BuildGitViewModel.slug("My-App_2!"))
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

    @Test fun mcp_edit_asksTheBoxToStartFromTheService() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        val vm = BuildMcpViewModel(client, scope = backgroundScope, editServiceId = "alice--notes")
        assertEquals("notes", vm.editingName)
        vm.create().join()
        assertEquals("alice--notes", client.mcpCreateCalls.last().editServiceId)
        // Regenerating the key keeps the same build; it doesn't restart the edit.
        vm.rotate().join()
        assertNull(client.mcpRotateCalls.last().second.editServiceId)
        assertNull(BuildMcpViewModel(client, scope = backgroundScope).editingName)
    }

    @Test fun mcp_newBuild_sendsNoEditServiceId() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0)
        BuildMcpViewModel(client, scope = backgroundScope).create().join()
        assertNull(client.mcpCreateCalls.last().editServiceId)
    }

    @Test fun mcp_create404_showsPlatformAbsentMessage() = runTest {
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { entryFailStatus = 404 }
        val vm = BuildMcpViewModel(client, scope = backgroundScope)
        vm.create("android").join()
        val phase = vm.phase.value
        assertTrue(phase is BuildMcpViewModel.McpPhase.Failed)
        val msg = (phase as BuildMcpViewModel.McpPhase.Failed).message
        assertTrue("expected platform-absent copy, got: $msg",
            msg.contains("isn't set up to build services"))
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

    @Test fun journal_list404_showsPlatformAbsentMessage() = runTest {
        // The sessions list is a build-platform ENTRY call — a 404 means the
        // box can't build services (unlike loadDetail's session-scoped 404).
        val client = MockBuildClient(simulatedLatencyMs = 0).apply { entryFailStatus = 404 }
        val vm = BuildJournalViewModel(client, scope = backgroundScope)
        vm.loadList().join()
        val list = vm.list.value
        assertTrue(list is LoadingState.Failed)
        val msg = (list as LoadingState.Failed).message
        assertTrue("expected platform-absent copy, got: $msg",
            msg.contains("isn't set up to build services"))
    }
}
