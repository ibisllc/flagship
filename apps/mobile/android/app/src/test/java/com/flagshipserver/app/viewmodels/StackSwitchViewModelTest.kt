package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The server page's Container stack card: a signed dry run, then the same order sent for real. */
class StackSwitchViewModelTest {
    private val server = "home.bright-maple.flagship.services"
    private var t = 1_800_000_000_000L

    private fun vm(c: MockScreensClient) = StackSwitchViewModel(
        c, server, confirm = {}, signer = { com.google.crypto.tink.subtle.Ed25519Sign(ByteArray(32) { 0x22 }) }, now = { t },
    )

    private fun mock(blocked: Boolean = false) = MockScreensClient(simulatedLatencyMs = 0).also { it.stackFixture = it.classicStack(blocked) }

    @Test fun dryRunThenMoveSendsTheSameOrderOnce() = runTest {
        val c = mock()
        val m = vm(c)
        m.load()
        assertTrue(m.state.value.shows)
        m.prepare()
        val plan = m.state.value.review!!
        assertEquals(4, plan.steps.size)
        assertEquals(true, c.stackBodies.single().dryRun)
        m.confirmMove()
        assertEquals(2, c.stackBodies.size)
        val real = c.stackBodies.last()
        assertNull(real.dryRun)
        assertEquals(c.stackBodies.first().order, real.order)
        assertEquals("arch-v2", real.order.target)
        assertNull(m.state.value.review)
        assertEquals("The server is restarting for the move. This card shows how it goes.", m.state.value.notice)
        m.load()
        assertEquals("trial", m.state.value.status!!.switchRecord!!.state)
        assertEquals("arch-v2", m.state.value.status!!.stack)
    }

    @Test fun anOldDryRunIsSignedAgain() = runTest {
        val c = mock()
        val m = vm(c)
        m.load()
        m.prepare()
        t += 5 * 60_000
        m.confirmMove()
        assertTrue(c.stackBodies.first().order.nonce != c.stackBodies.last().order.nonce)
    }

    @Test fun aBlockedPlanCannotBeSent() = runTest {
        val c = mock(blocked = true)
        val m = vm(c)
        m.load()
        m.prepare()
        assertEquals("no-podman-room", m.state.value.review!!.blockers.single().code)
        m.confirmMove()
        assertEquals(1, c.stackBodies.size)
    }

    @Test fun anOlderBoxShowsNoCard() = runTest {
        val m = vm(MockScreensClient(simulatedLatencyMs = 0))
        m.load()
        assertFalse(m.state.value.shows)
    }
}
