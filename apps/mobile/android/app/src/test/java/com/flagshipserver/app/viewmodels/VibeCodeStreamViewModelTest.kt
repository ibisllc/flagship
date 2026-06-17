// State-machine tests for the live vibe-code (build-from-scratch) stream VM.
// Mirrors the iOS VibeCodeStreamViewModel behaviour: tokens accumulate into
// the transcript, build frames fill the logs + flip status, deploy/done/error
// are terminal, and the global-operations sliver gets a build op on
// build-start (tapping → the chat) that is dropped on every terminal frame
// AND on cancel(). Covers both the imperative apply() path and a live flow.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.api.VibeCodeFrame
import com.flagshipserver.app.core.ActiveOperation
import com.flagshipserver.app.core.ActiveOperationsCenter
import com.flagshipserver.app.core.DeepLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VibeCodeStreamViewModelTest {

    /** A ScreensClient that streams a scripted list of frames — the "fake
     *  event source" for the live start() path. Delegates everything else to
     *  the honest in-memory MockScreensClient (final, so we wrap, not extend);
     *  only vibeCodeStream is overridden. */
    private class ScriptedStreamClient(
        private val frames: List<VibeCodeFrame>,
        private val base: MockScreensClient = MockScreensClient(simulatedLatencyMs = 0),
    ) : ScreensClient by base {
        override fun vibeCodeStream(sessionId: String): Flow<VibeCodeFrame> = flow {
            for (f in frames) emit(f)
        }
    }

    private fun vm(
        sessionId: String = "sess-1",
        operations: ActiveOperationsCenter? = null,
        serverLabel: String? = null,
        client: ScreensClient = MockScreensClient(simulatedLatencyMs = 0),
        scope: kotlinx.coroutines.CoroutineScope,
    ) = VibeCodeStreamViewModel(
        sessionId = sessionId,
        client = client,
        scope = scope,
        operations = operations,
        serviceLabel = "blog",
        serverLabel = serverLabel,
    )

    // ── apply(): per-frame transitions ─────────────────────────────

    @Test fun tokens_accumulateIntoTranscript() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.Token("Hello "))
        m.apply(VibeCodeFrame.Token("world"))
        assertEquals("Hello world", m.transcript.value)
        assertEquals(VibeCodeStreamViewModel.Status.STREAMING, m.status.value)
    }

    @Test fun manifestEmit_isCaptured() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.ManifestEmit("{\"name\":\"blog\"}"))
        assertEquals("{\"name\":\"blog\"}", m.manifestJson.value)
    }

    @Test fun buildStart_flipsStatusAndLogs() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.BuildStart)
        assertEquals(VibeCodeStreamViewModel.Status.BUILDING, m.status.value)
        assertTrue(m.buildLogs.value.contains("── BUILD START ──"))
        m.apply(VibeCodeFrame.BuildLog("FROM node:20-alpine"))
        assertTrue(m.buildLogs.value.contains("FROM node:20-alpine"))
    }

    @Test fun repoCreate_appendsLog() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.RepoCreate("you/blog"))
        assertTrue(m.buildLogs.value.contains("Created git repo."))
    }

    @Test fun deploy_setsUrlAndDeployedStatus() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.Deploy("harry-blog", "https://blog.home.harry.flagship.services/"))
        assertEquals("harry-blog", m.deployedServiceId.value)
        assertEquals("https://blog.home.harry.flagship.services/", m.deployedUrl.value)
        assertEquals(VibeCodeStreamViewModel.Status.DEPLOYED, m.status.value)
    }

    @Test fun error_setsMessageAndFailedStatus() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.Err("model refused"))
        assertEquals("model refused", m.errorMessage.value)
        assertEquals(VibeCodeStreamViewModel.Status.FAILED, m.status.value)
    }

    @Test fun done_setsDoneStatus() = runTest {
        val m = vm(scope = backgroundScope)
        m.apply(VibeCodeFrame.Done)
        assertEquals(VibeCodeStreamViewModel.Status.DONE, m.status.value)
    }

    // ── build-op upsert/remove on the operations sliver ────────────

    @Test fun buildStart_registersBuildOp_targetingTheChat() = runTest {
        val center = ActiveOperationsCenter()
        val m = vm(sessionId = "sess-1", operations = center, serverLabel = "Home", scope = backgroundScope)
        // Nothing in the sliver until the build actually starts.
        assertNull(center.primary)
        m.apply(VibeCodeFrame.BuildStart)
        val op = center.primary!!
        assertEquals(ActiveOperation.Kind.BUILD, op.kind)
        assertEquals("building blog on Home", op.label)
        // Tapping the sliver opens THIS build's own surface — the chat.
        assertEquals(DeepLink.VibeCodeChat("sess-1"), op.target)
    }

    @Test fun deploy_removesBuildOp() = runTest {
        val center = ActiveOperationsCenter()
        val m = vm(operations = center, serverLabel = "Home", scope = backgroundScope)
        m.apply(VibeCodeFrame.BuildStart)
        assertEquals(1, center.operations.value.size)
        m.apply(VibeCodeFrame.Deploy("harry-blog", "https://blog/"))
        assertTrue(center.operations.value.isEmpty())
        assertNull(center.primary)
    }

    @Test fun error_removesBuildOp() = runTest {
        val center = ActiveOperationsCenter()
        val m = vm(operations = center, scope = backgroundScope)
        m.apply(VibeCodeFrame.BuildStart)
        m.apply(VibeCodeFrame.Err("boom"))
        assertTrue(center.operations.value.isEmpty())
    }

    @Test fun done_removesBuildOp() = runTest {
        val center = ActiveOperationsCenter()
        val m = vm(operations = center, scope = backgroundScope)
        m.apply(VibeCodeFrame.BuildStart)
        m.apply(VibeCodeFrame.Done)
        assertTrue(center.operations.value.isEmpty())
    }

    @Test fun cancel_removesBuildOp() = runTest {
        val center = ActiveOperationsCenter()
        val m = vm(operations = center, scope = backgroundScope)
        m.apply(VibeCodeFrame.BuildStart)
        assertEquals(1, center.operations.value.size)
        // Popping the screen mid-build must not strand a phantom op.
        m.cancel()
        assertTrue(center.operations.value.isEmpty())
    }

    @Test fun noOperationsCenter_appliesFramesWithoutCrashing() = runTest {
        // Tests/previews without a sliver wired must behave identically.
        val m = vm(operations = null, scope = backgroundScope)
        m.apply(VibeCodeFrame.BuildStart)
        m.apply(VibeCodeFrame.Done)
        assertEquals(VibeCodeStreamViewModel.Status.DONE, m.status.value)
    }

    // ── start(): consuming the live frame stream end-to-end ────────

    @Test fun start_consumesLiveStream_toDeployedState() = runTest {
        val center = ActiveOperationsCenter()
        val client = ScriptedStreamClient(
            listOf(
                VibeCodeFrame.Token("Sketching "),
                VibeCodeFrame.Token("schema.\n"),
                VibeCodeFrame.ManifestEmit("{\"name\":\"blog\"}"),
                VibeCodeFrame.BuildStart,
                VibeCodeFrame.BuildLog("FROM node:20-alpine"),
                VibeCodeFrame.Deploy("harry-blog", "https://blog.home.harry.flagship.services/"),
                VibeCodeFrame.Done,
            ),
        )
        val m = vm(operations = center, serverLabel = "Home", client = client, scope = backgroundScope)
        m.start().join()

        assertEquals("Sketching schema.\n", m.transcript.value)
        assertEquals("{\"name\":\"blog\"}", m.manifestJson.value)
        assertTrue(m.buildLogs.value.contains("── BUILD START ──"))
        assertTrue(m.buildLogs.value.contains("FROM node:20-alpine"))
        assertEquals("https://blog.home.harry.flagship.services/", m.deployedUrl.value)
        // Done is the last frame → terminal, and the op is cleared.
        assertEquals(VibeCodeStreamViewModel.Status.DONE, m.status.value)
        assertTrue(center.operations.value.isEmpty())
    }
}
