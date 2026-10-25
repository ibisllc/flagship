package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.AcceleratorHolder
import com.flagshipserver.app.api.AcceleratorsView
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.AcceleratorsCopy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The server page's GPU card: what it shows, when it hides, and Stop. */
class AcceleratorsViewModelTest {
    private fun mock(view: AcceleratorsView? = null) = MockScreensClient(simulatedLatencyMs = 0).also {
        it.acceleratorsFixture = view ?: it.defaultAccelerators()
    }

    @Test fun showsEachGpuItsHolderAndTheQueue() = runTest {
        val vm = AcceleratorsViewModel(mock())
        vm.load()
        val s = vm.state.value
        assertTrue(s.shows)
        val v = s.view!!
        assertEquals("GPU 0: NVIDIA GeForce RTX 4090", AcceleratorsCopy.device(v.devices[0]))
        assertEquals("Used by Plants", AcceleratorsCopy.holder(v.devices[0].holders.single()))
        assertEquals("Set aside after a fault", AcceleratorsCopy.state(v.devices[2].state))
        assertEquals("Wiki is waiting", AcceleratorsCopy.waiting(v.queue.single()))
    }

    @Test fun theWordsMatchTheOtherApps() {
        assertEquals("Plants", AcceleratorsCopy.appName("alice--plants"))
        assertEquals("My-Notes", AcceleratorsCopy.appName("alice--my-notes"))
        assertEquals("Local AI", AcceleratorsCopy.appName("flagship-local-ai"))
        assertEquals("Starting for Wiki", AcceleratorsCopy.holder(AcceleratorHolder("a--wiki", "x", "reserved")))
        assertEquals("Wiki is giving it back", AcceleratorsCopy.holder(AcceleratorHolder("a--wiki", "x", "releasing")))
        assertEquals("Wiki is waiting (3 jobs)", AcceleratorsCopy.waiting(com.flagshipserver.app.api.AcceleratorQueueEntry("a--wiki", 3)))
        assertEquals("Stop Plants using the GPU?", AcceleratorsCopy.stopTitle(AcceleratorHolder("a--plants", "x", "running")))
        assertEquals("Drives the screen, so apps can't use it", AcceleratorsCopy.state("display"))
        assertEquals("Not qualified on this server", AcceleratorsCopy.state("unqualified"))
    }

    @Test fun aBoxWithNoGpuOrNoGpuScreenShowsNoCard() = runTest {
        val none = AcceleratorsViewModel(mock(AcceleratorsView(available = false, reason = "no-gpu-service")))
        none.load()
        assertFalse(none.state.value.shows)
        val older = MockScreensClient(simulatedLatencyMs = 0)
        val vm = AcceleratorsViewModel(older)
        vm.load()
        assertTrue(vm.state.value.unsupported)
        assertFalse(vm.state.value.shows)
        val broken = AcceleratorsViewModel(mock(AcceleratorsView(available = false, reason = "failed")))
        broken.load()
        assertTrue("a GPU service that fails says so", broken.state.value.shows)
    }

    @Test fun stopFreesTheGpuForTheAppWaitingAndSaysSo() = runTest {
        val c = mock()
        val vm = AcceleratorsViewModel(c)
        vm.load()
        val h = vm.state.value.view!!.devices[0].holders.single()
        assertTrue(vm.stop(h))
        assertEquals(listOf("app-alice--plants-k1"), c.acceleratorStops)
        val s = vm.state.value
        assertEquals("Plants no longer has the GPU.", s.notice)
        assertNull(s.error)
        assertNull(s.busy)
        assertEquals("Starting for Wiki", AcceleratorsCopy.holder(s.view!!.devices[0].holders.single()))
        assertTrue(s.view!!.queue.isEmpty())
    }

    @Test fun aRefusedStopShowsTheBoxsSentence() = runTest {
        val c = mock()
        val vm = AcceleratorsViewModel(c)
        vm.load()
        assertFalse(vm.stop(AcceleratorHolder("alice--plants", "gone", "running")))
        assertEquals("That GPU job is not running.", vm.state.value.error)
        assertNull(vm.state.value.notice)
    }

    private val server = "home.bright-maple.flagship.services"

    private fun approvals(): MockScreensClient {
        val c = mock()
        val (pending, granted) = c.gpuApprovalsFixture()
        c.acceleratorsFixture = c.defaultAccelerators().copy(pendingApprovals = pending, approvals = granted)
        return c
    }

    private fun signing(c: MockScreensClient) = AcceleratorsViewModel(
        c, server, confirm = {}, signer = { com.google.crypto.tink.subtle.Ed25519Sign(ByteArray(32) { 0x22 }) }, now = { 1_800_000_000_000 },
    )

    @Test fun approveSignsTheListedTermsForThisServer() = runTest {
        val c = approvals()
        val vm = signing(c)
        vm.load()
        val render = vm.state.value.view!!.pendingApprovals.first { it.appId == "alice--render" }
        assertEquals("Render asks to use the GPU: 1 × NVIDIA GPU, computing, a GPU of its own, in the app sandbox, kept apart from other apps", AcceleratorsCopy.asks(render))
        assertTrue(vm.approve(render))
        val b = c.gpuApprovalBodies.single()
        assertEquals(server, b.server)
        assertEquals(1_800_000_000_000, b.issuedAt)
        assertEquals("Render can use the GPU.", vm.state.value.notice)
        assertTrue(vm.state.value.view!!.approvals.any { it.appId == "alice--render" })
    }

    @Test fun sharingIsApprovedWithATrustDomainAndConsent() = runTest {
        val c = approvals()
        val vm = signing(c)
        vm.load()
        assertTrue(vm.approve(vm.state.value.view!!.pendingApprovals.first { it.appId == "alice--stream" }))
        val b = c.gpuApprovalBodies.single()
        assertEquals("owner-apps", b.trustDomain)
        assertEquals("owner-consent-1800000000000", b.ownerConsent)
    }

    @Test fun declineSendsNothingAndHidesTheAsk() = runTest {
        val c = approvals()
        val vm = signing(c)
        vm.load()
        val train = vm.state.value.view!!.pendingApprovals.first { it.appId == "alice--train" }
        vm.decline(train)
        assertEquals("Train won't get a GPU.", vm.state.value.notice)
        assertTrue(c.gpuWithdrawBodies.isEmpty())
        assertFalse(vm.pending(vm.state.value.view!!).any { it.appId == "alice--train" })
    }

    @Test fun withdrawSignsTheWithdrawal() = runTest {
        val c = approvals()
        val vm = signing(c)
        vm.load()
        assertTrue(vm.withdraw(vm.state.value.view!!.approvals.single()))
        assertEquals("alice--photos", c.gpuWithdrawBodies.single().appId)
        assertEquals("Photos can no longer use the GPU.", vm.state.value.notice)
        assertTrue(vm.state.value.view!!.approvals.isEmpty())
    }

    @Test fun aRequestForAnotherServerIsNotSigned() = runTest {
        val c = approvals()
        val vm = AcceleratorsViewModel(c, "other.bright-maple.flagship.services", confirm = {}, signer = { error("must not sign") })
        vm.load()
        assertFalse(vm.approve(vm.state.value.view!!.pendingApprovals.first()))
        assertEquals("This request is for another server, so nothing was signed.", vm.state.value.error)
        assertTrue(c.gpuApprovalBodies.isEmpty())
    }
}
