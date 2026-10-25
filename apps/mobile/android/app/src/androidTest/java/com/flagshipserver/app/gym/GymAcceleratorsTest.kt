// GYM Android mock tier — the server page's GPUs (packages/server-daemon/src/gpu/http.ts), twins of
// iOS GymRelease03Tests' accelerator scenarios: each GPU with its model, memory and state, the app
// that holds it, the apps waiting; Stop asks first, Cancel sends nothing, Stop frees the GPU and the
// app waiting gets it; a box with no GPU shows no card. NO BACKEND: the mock box answers like
// gpu/http.ts and records what it received.

package com.flagshipserver.app.gym

import com.flagshipserver.app.api.AcceleratorsView
import com.flagshipserver.app.api.MockScreensClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GymAcceleratorsTest : GymBase() {

    private val mock: MockScreensClient get() = MockScreensClient.smokeInstance!!

    private fun openServer(view: AcceleratorsView?, adminRoot: Boolean = false) {
        launch(tab = "home", adminRoot = adminRoot)
        mock.acceleratorsFixture = view
        mock.acceleratorStops.clear()
        openServerFromHome("Living-room mini-PC")
    }

    @After fun noGpus() {
        MockScreensClient.smokeInstance?.acceleratorsFixture = null
    }

    /** android-gpus-card: each GPU, its holder with Stop, the queue and a pause. */
    @Test
    fun gpusCardShowsWhoHoldsEachGpu() {
        openServer(mock.defaultAccelerators().copy(admissionPaused = "maintenance"))
        waitUntilExists("accelerators-card", 20_000)
        assertEquals("GPU 0: NVIDIA GeForce RTX 4090", textOfTag("accelerator-name-0"))
        assertEquals("Used by Plants", textOfTag("accelerator-holder-0"))
        assertTrue(textOfTag("accelerator-state-0").endsWith("In use"))
        assertTrue(textOfTag("accelerator-state-1").endsWith("Free"))
        assertTrue(textOfTag("accelerator-state-2").endsWith("Set aside after a fault"))
        assertEquals(0, tagCount("accelerator-holder-1"))
        assertEquals("Wiki is waiting", textOfTag("accelerator-queue-alice--wiki"))
        waitUntilExists("accelerators-paused")
        assertEquals(1, tagCount("accelerator-stop-app-alice--plants-k1"))
        gymShot("gpus-card")
    }

    /** android-gpus-stop: Stop asks; Cancel sends nothing; Stop frees the GPU for Wiki. */
    @Test
    fun gpuStopAsksThenFreesTheGpu() {
        openServer(mock.defaultAccelerators())
        tap("accelerator-stop-app-alice--plants-k1", 20_000)
        waitText("Stop Plants using the GPU?")
        tap("accelerator-stop-cancel")
        waitTextGone("Stop Plants using the GPU?")
        assertTrue(mock.acceleratorStops.isEmpty())
        tap("accelerator-stop-app-alice--plants-k1")
        waitText("Stop Plants using the GPU?")
        gymShot("gpus-stop-ask")
        tap("accelerator-stop-confirm")
        eventually(what = "the stop") { mock.acceleratorStops == listOf("app-alice--plants-k1") }
        eventually(what = "the notice") { tagCount("accelerators-notice") == 1 && textOfTag("accelerators-notice") == "Plants no longer has the GPU." }
        eventually(what = "Wiki gets the GPU") { textOfTag("accelerator-holder-0") == "Starting for Wiki" }
        waitGone("accelerator-queue-alice--wiki")
        gymShot("gpus-stopped")
    }

    private fun withApprovals(): AcceleratorsView {
        val (pending, granted) = mock.gpuApprovalsFixture()
        return mock.defaultAccelerators().copy(pendingApprovals = pending, approvals = granted)
    }

    /** android-gpus-approve: Render's request with its exact terms; Approve signs flagship/gpu-approval/v1 with the
     *  admin root; Decline on Train hides it and sends nothing; Stream's sharing request is approved with a trust
     *  domain and consent; Withdraw on Photos signs flagship/gpu-approval-withdraw/v1. */
    @Test
    fun gpuApprovalApproveDeclineWithdraw() {
        openServer(withApprovals(), adminRoot = true)
        mock.gpuApprovalBodies.clear()
        mock.gpuWithdrawBodies.clear()
        waitUntilExists("gpu-approval-ask-alice--render", 20_000)
        assertEquals(
            "Render asks to use the GPU: 1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps",
            textOfTag("gpu-approval-ask-alice--render"),
        )
        gymShot("gpu-approval-pending")
        tap("gpu-approval-approve-alice--render")
        assertSigned("gpu-approval", "admin")
        eventually(what = "the approval") { mock.gpuApprovalBodies.firstOrNull()?.appId == "alice--render" }
        eventually(what = "the notice") { tagCount("accelerators-notice") == 1 && textOfTag("accelerators-notice") == "Render can use the GPU." }
        waitUntilExists("gpu-approval-allowed-alice--render")
        // Decline sends nothing (the box keeps no refusal) and hides the ask.
        tap("gpu-approval-decline-alice--train")
        eventually(what = "Train declined") { textOfTag("accelerators-notice") == "Train won't get a GPU." }
        waitGone("gpu-approval-ask-alice--train")
        assertTrue(mock.gpuWithdrawBodies.isEmpty())
        // Sharing a GPU: the owner's approval names a trust domain and consent.
        tap("gpu-approval-approve-alice--stream")
        eventually(what = "Stream approved") { mock.gpuApprovalBodies.any { it.appId == "alice--stream" && it.trustDomain == "owner-apps" && it.ownerConsent != null } }
        tap("gpu-approval-withdraw-alice--photos")
        assertSigned("gpu-approval-withdraw", "admin")
        eventually(what = "Photos withdrawn") { mock.gpuWithdrawBodies.any { it.appId == "alice--photos" } && textOfTag("accelerators-notice") == "Photos can no longer use the GPU." }
        waitGone("gpu-approval-allowed-alice--photos")
        gymShot("gpu-approval-answered")
    }

    /** android-gpus-approval-read-only: without the admin root the requests show with the admin-only line, no buttons. */
    @Test
    fun gpuApprovalReadOnlyOnANonAdminDevice() {
        openServer(withApprovals(), adminRoot = false)
        waitUntilExists("gpu-approval-ask-alice--render", 20_000)
        if (tagCount("gpu-approval-approve-alice--render") > 0) {
            // A demo account may sign from any device (AddServerGate); the gym account is not one.
            error("a device without the admin root offered Approve")
        }
        waitUntilExists("gpu-approval-admin-only")
        assertEquals(0, tagCount("gpu-approval-withdraw-alice--photos"))
        gymShot("gpu-approval-read-only")
    }

    /** android-gpus-none: no GPU (or an older box without the screen) shows no card. */
    @Test
    fun noGpuShowsNoCard() {
        openServer(AcceleratorsView(available = false, reason = "no-gpu-service"))
        waitUntilExists("sd-local-ai", 20_000)
        composeRule.waitForIdle()
        assertEquals(0, tagCount("accelerators-card"))
        mock.acceleratorsFixture = null
        assertEquals(0, tagCount("accelerators-card"))
        gymShot("gpus-none")
    }
}
