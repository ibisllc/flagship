// The ongoing setup notification follows the canonical phase ladder, never
// steps back when pushes and polls cross, and ends as a dismissable notice.

package com.flagshipserver.app.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvisionNoticeModelTest {
    private fun u(phase: String, serial: String? = "SER1", name: String? = "Office", detail: String? = null, fqdn: String? = null) =
        ProvisionUpdate(key = serial ?: "office.x.flagship.services", serial = serial, podName = name, phase = phase, detail = detail, serverDomain = fqdn)

    @Test fun runningPhasesAreOngoingWithProgress() {
        val n = ProvisionNoticeModel.notice(u("registering"))!!
        assertTrue(n.ongoing)
        assertEquals("Office", n.title)
        assertEquals("Registering with Flagship", n.text)
        assertTrue(n.progress in 1..99)
        assertNull(n.timeoutMs)
        assertEquals("https://flagshipserver.com/app/install-progress?serial=SER1", n.tapUrl)
    }

    @Test fun installedAsksToUnplug() {
        assertTrue(ProvisionNoticeModel.notice(u("installed"))!!.text.contains("unplug"))
    }

    @Test fun liveAndErrorEndTheNotification() {
        val live = ProvisionNoticeModel.notice(u("live", fqdn = "office.x.flagship.services"))!!
        assertFalse(live.ongoing)
        assertEquals("Your server is live at office.x.flagship.services", live.text)
        assertEquals(ProvisionNoticeModel.TERMINAL_TIMEOUT_MS, live.timeoutMs)
        val err = ProvisionNoticeModel.notice(u("error", detail = "Disk too small"))!!
        assertTrue(err.failed)
        assertEquals("Disk too small", err.text)
        assertEquals("Setup hit a problem", ProvisionNoticeModel.notice(u("error"))!!.text)
    }

    @Test fun unnamedAndSerialLessInstalls() {
        val n = ProvisionNoticeModel.notice(u("booting", serial = null, name = null))!!
        assertEquals(ProvisionNoticeModel.DEFAULT_TITLE, n.title)
        assertEquals("https://flagshipserver.com/app/install-progress", n.tapUrl)
        assertNull(ProvisionNoticeModel.notice(u("from-the-future")))
    }

    @Test fun neverStepsBack() {
        assertTrue(ProvisionNoticeModel.advances(null, "booting"))
        assertTrue(ProvisionNoticeModel.advances("booting", "installing"))
        assertFalse(ProvisionNoticeModel.advances("installing", "booting"))
        assertFalse(ProvisionNoticeModel.advances("installing", "installing"))
        assertTrue(ProvisionNoticeModel.advances("sealing", "error"))
        assertTrue(ProvisionNoticeModel.advances("pairing", "live"))
        assertFalse(ProvisionNoticeModel.advances("live", "pairing"))
        assertFalse(ProvisionNoticeModel.advances("live", "live"))
        assertTrue("a retry starts over", ProvisionNoticeModel.advances("error", "booting"))
        assertFalse(ProvisionNoticeModel.advances("booting", "from-the-future"))
        assertNotNull(ProvisionNoticeModel.notice(u("downloading")))
    }
}
