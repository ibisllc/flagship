package com.flagshipserver.app.core

import com.flagshipserver.app.api.BoxActivityEntry
import com.flagshipserver.app.viewmodels.ActivityItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxEventLabelsTest {
    @Test fun dropsGenericWritesAndNamesTheRest() {
        assertNull(BoxEventLabels.title(BoxActivityEntry(ts = 1, action = "post /api/screens/x")))
        assertEquals("Backup ready", BoxEventLabels.title(BoxActivityEntry(ts = 1, action = "server.backup.created", kind = "server.backup.created")))
        assertEquals("Server something new", BoxEventLabels.title(BoxActivityEntry(ts = 1, action = "x", kind = "server.something.new")))
    }

    @Test fun namesTheDebugAccessEntries() {
        val labels = mapOf(
            "server.debug-access.granted" to "Debug access turned on",
            "server.debug-access.renewed" to "Debug access renewed",
            "server.debug-access.expired" to "Debug access ended",
            "server.debug-access.revoked" to "Debug access turned off",
        )
        for ((kind, label) in labels) {
            assertEquals(label, BoxEventLabels.title(BoxActivityEntry(ts = 1, action = kind, kind = kind)))
        }
    }

    @Test fun corruptStateReadsAsAWarningWithTheBoxDetail() {
        val detail = "service-access.json couldn't be read and was set aside. Every app on this server is members-only until you open it again."
        val e = BoxActivityEntry(ts = 1, action = "server.state.corrupt", kind = "server.state.corrupt", detail = detail, ok = false)
        assertEquals("This server found a damaged settings file and locked it down", BoxEventLabels.title(e))
        val item = ActivityItem.BoxEvent(e)
        assertTrue(item.warning)
        assertEquals(detail, item.subtitle)
        assertFalse(ActivityItem.BoxEvent(BoxActivityEntry(ts = 1, action = "app.installed", kind = "app.installed")).warning)
    }
}
