// GYM Android mock tier — Local AI (docs/architecture-v2/local-ai.md), twins of iOS GymLocalAiTests:
// a server page opens Local AI; a model downloads and lands on the server; the job queue says which
// app holds each GPU and where a job waits; a fine-tune starts as a signed order on an app's sample
// data; an app is allowed and withdrawn with signed grants; and the build chat's model menu offers
// "On this server", saying so when nothing is downloaded instead of switching provider. NO BACKEND:
// the mock box answers like localAi/http.ts and records what it received.

package com.flagshipserver.app.gym

import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import com.flagshipserver.app.api.MockScreensClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymLocalAiTest : GymBase() {

    private val mock: MockScreensClient get() = MockScreensClient.smokeInstance!!

    private fun openLocalAi(adminRoot: Boolean = true, before: (MockScreensClient) -> Unit = {}) {
        launch(tab = "home", adminRoot = adminRoot)
        mock.localAiFixture = mock.defaultLocalAi()
        mock.localAiTrainBodies.clear()
        mock.localAiGrantBodies.clear()
        mock.localAiActions.clear()
        before(mock)
        waitText("Living-room mini-PC", 20_000)
        tapText("Living-room mini-PC")
        tap("sd-local-ai-open", 20_000)
        waitUntilExists("local-ai-privacy", 15_000)
    }

    private fun textExists(t: String) = composeRule.onAllNodesWithText(t, substring = true).fetchSemanticsNodes().isNotEmpty()

    /** android-local-ai-models-download: Download a model; it ends on this server. */
    @Test
    fun localAiModelDownloads() {
        openLocalAi()
        waitText("Runs only on this server. Nothing is sent anywhere.")
        tap("local-ai-download-qwen2.5-0.5b-q4")
        eventually(what = "the download order") { "model:download:qwen2.5-0.5b-q4" in mock.localAiActions }
        gymShot("local-ai-downloading")
        eventually(timeoutMs = 20_000, what = "installed") {
            mock.localAiFixture.models.first { it.id == "qwen2.5-0.5b-q4" }.state == "installed" &&
                textOfTag("local-ai-model-state-qwen2.5-0.5b-q4") == "On this server"
        }
        waitUntilExists("local-ai-delete-qwen2.5-0.5b-q4")
        gymShot("local-ai-downloaded")
    }

    /** android-local-ai-queue-gpu-holder: the GPU names the app that holds it; a waiting job its place. */
    @Test
    fun localAiQueueShowsGpuHolder() {
        openLocalAi()
        waitText("Used by Render farm", 15_000)
        waitUntilExists("local-ai-job-queue-fedcba9876543210")
        assertEquals("Number 2 in line", textOfTag("local-ai-job-queue-fedcba9876543210"))
        assertEquals("On the processor", textOfTag("local-ai-job-device-0123456789abcdef"))
        assertTrue(textExists("Free: runs on this server"))
        tap("local-ai-job-open-0123456789abcdef")
        waitUntilExists("local-ai-checkpoint-1")
        gymShot("local-ai-queue")
    }

    /** android-local-ai-fine-tune-start: a signed order for one app's sample data. */
    @Test
    fun localAiFineTuneStarts() {
        openLocalAi()
        tap("local-ai-train-app-alice--notes", 15_000)
        tap("local-ai-train-model-stories-15m")
        tap("local-ai-train-start")
        eventually(what = "the signed training order") {
            val b = mock.localAiTrainBodies.lastOrNull()
            b != null && b.order.serviceId == "alice--notes" && b.order.baseModel == "stories-15m" && b.order.epochs == 3 &&
                Regex("^[0-9a-f]{16}$").matches(b.order.jobId) && b.signature.length == 128
        }
        val id = mock.localAiTrainBodies.last().order.jobId
        waitUntilExists("local-ai-job-$id", 15_000)
        gymShot("local-ai-fine-tune-queued")
    }

    /** android-local-ai-app-grant: allow an app with quotas, then withdraw; both signed. */
    @Test
    fun localAiAppGrantAndWithdraw() {
        openLocalAi()
        tap("local-ai-allow-alice--notes", 15_000)
        tap("local-ai-allow-confirm")
        eventually(what = "the signed grant") {
            val g = mock.localAiGrantBodies.lastOrNull()?.order
            g != null && g.serviceId == "alice--notes" && g.requestsPerDay == 500L && g.tokensPerDay == 200_000L && g.maxTokensPerRequest == 1_024L
        }
        waitUntilExists("local-ai-withdraw-alice--notes", 15_000)
        gymShot("local-ai-app-allowed")
        tap("local-ai-withdraw-alice--notes")
        eventually(what = "the withdrawal") { mock.localAiGrantBodies.lastOrNull()?.order?.requestsPerDay == 0L }
        gymShot("local-ai-app-withdrawn")
    }

    /** android-local-ai-menu-unavailable: the chat's menu lists "On this server" and says nothing is
     *  downloaded; nothing switches provider on its own. */
    @Test
    fun buildMenuOnThisServerSaysNothingIsDownloaded() {
        launch(tab = "home", ops = true, chat = "failed")
        mock.localAiFixture = mock.defaultLocalAi().let { v -> v.copy(models = v.models.map { it.copy(state = "available") }) }
        tap("global-operations-bar", 20_000)
        waitText("The app didn't start", 20_000)
        tap("model-menu")
        waitUntilExists("model-group-flagship-local", 15_000)
        eventually(timeoutMs = 15_000, what = "the local note") {
            composeRule.onAllNodesWithTag("model-group-note-flagship-local").fetchSemanticsNodes().isNotEmpty() &&
                textOfTag("model-group-note-flagship-local") == "No model is downloaded on this server yet. Download one under Local AI."
        }
        gymShot("model-menu-local-empty")
        assertTrue(mock.chatReplies.none { it.second.credential?.provider == "flagship-local" })
    }
}
