// The bare-name endpoint's demux for a call's TURN stream (docs/voici-calls.md §4). Mirrors iOS CallTurnGateTests.

package com.flagshipserver.app.phoneroute

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CallTurnGateTest {
    private class Echo : CallTurnConnection {
        var closed = false
        override fun onClientBytes(data: ByteArray) = listOf(data)
        override fun close() { closed = true }
    }

    @After fun reset() {
        CallTurnGate.disarm()
        CallTurnGate.factory = null
    }

    @Test fun firstByteRule() {
        // A STUN Allocate starts 0x00 0x03; HTTP methods and ChannelData (0x40-0x4F) never choose TURN.
        assertEquals(CallTurnGate.Route.Turn, CallTurnGate.route(0x00, true))
        assertEquals(CallTurnGate.Route.Close, CallTurnGate.route(0x01, false))
        assertEquals(CallTurnGate.Route.Http, CallTurnGate.route('G'.code.toByte(), true))
        assertEquals(CallTurnGate.Route.Http, CallTurnGate.route(0x40, true))
    }

    @Test fun turnOnlyWhileArmedOnceAndLinked() {
        assertEquals(CallTurnGate.Route.Close, CallTurnGate.open(0x00).first)
        CallTurnGate.arm(CallTurnGate.Credential("u".repeat(32), "s".repeat(64)))
        assertEquals("no responder linked: closed", CallTurnGate.Route.Close, CallTurnGate.open(0x00).first)
        var made: CallTurnGate.Credential? = null
        CallTurnGate.factory = { made = it; Echo() }
        val (r, conn) = CallTurnGate.open(0x00)
        assertEquals(CallTurnGate.Route.Turn, r)
        assertNotNull(conn)
        assertEquals("u".repeat(32), made?.user)
        assertEquals("one TURN connection per call", CallTurnGate.Route.Close, CallTurnGate.open(0x00).first)
        assertEquals(CallTurnGate.Route.Http, CallTurnGate.open('P'.code.toByte()).first)
        CallTurnGate.disarm()
        assertEquals(CallTurnGate.Route.Close, CallTurnGate.open(0x00).first)
        assertNull(CallTurnGate.open(0x00).second)
    }
}
