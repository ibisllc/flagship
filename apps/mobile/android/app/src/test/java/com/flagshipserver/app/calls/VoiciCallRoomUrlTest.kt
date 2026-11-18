package com.flagshipserver.app.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Privacy policy §2.12: the device's call-room URL names only the call, never the account. */
class VoiciCallRoomUrlTest {
    @Test
    fun theRoomUrlNamesOnlyTheCall() {
        val callId = "0123456789abcdef0123456789abcdef"
        val url = VoiciCallSession.roomUrl("flagshipserver.com", callId)
        assertEquals("wss://flagshipserver.com/api/voici/calls/$callId/device", url)
        assertFalse(url.contains("?"))
    }
}
