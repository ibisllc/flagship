// docs/revocation-ui.md: "Remove from account" ends in Removed, or in the real reason a person reads.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.core.HttpException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.UnknownHostException

class RemoveDeviceFromAccountTest {
    private val fallback = "Check your connection and try again."

    @Test fun aRemovalThatGoesThroughIsRemoved() = runBlocking {
        var called = false
        assertEquals(TrustedDevicesViewModel.RemoveOutcome.Removed, TrustedDevicesViewModel.removing(fallback) { called = true })
        assertTrue(called)
    }

    @Test fun aRefusalCarriesTheRealReasonNotAGenericLine() = runBlocking {
        val out = TrustedDevicesViewModel.removing(fallback) { throw HttpException(403, """{"error":"not authorized"}""") }
        assertTrue(out is TrustedDevicesViewModel.RemoveOutcome.Failed)
        val reason = (out as TrustedDevicesViewModel.RemoveOutcome.Failed).reason
        assertEquals("This device isn't allowed to do that.", reason)
        assertTrue("no status line or JSON reaches the screen: $reason", !reason.contains("403") && !reason.contains("{"))
    }

    @Test fun beingOfflineSaysSo() = runBlocking {
        val out = TrustedDevicesViewModel.removing(fallback) { throw UnknownHostException("flagshipserver.com") }
        val reason = (out as TrustedDevicesViewModel.RemoveOutcome.Failed).reason
        assertTrue(reason, !reason.contains("flagshipserver.com"))
        assertTrue(reason, reason.isNotBlank())
    }
}
