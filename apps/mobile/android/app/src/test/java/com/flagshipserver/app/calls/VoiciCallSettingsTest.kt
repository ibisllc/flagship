// Calls settings, missed-call rows and the thread timeline (docs/voici-calls.md §6, §8). Mirrors iOS
// VoiciCallsViewModelTests.

package com.flagshipserver.app.calls

import com.flagshipserver.app.api.VoiciMissedCallItem
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.h
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.o
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.s
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class VoiciCallSettingsTest {
    @Test fun indexFieldsAreV2OnlyWhileOn() {
        assertEquals(1 to "signed-in", VoiciCallSettings.indexFields(true, "signed-in"))
        assertEquals(1 to "anyone", VoiciCallSettings.indexFields(true, "anyone"))
        assertEquals(1 to "callback", VoiciCallSettings.indexFields(true, "callback"))
        assertEquals(1 to "accepted", VoiciCallSettings.indexFields(true, "nobody"))
        assertEquals(null to null, VoiciCallSettings.indexFields(false, "signed-in"))
        assertEquals(false to "accepted", VoiciCallSettings.read(null, null))
        assertEquals(true to "signed-in", VoiciCallSettings.read(1, "signed-in"))
    }

    /** Owner decision 2026-11-16: the first publish's defaults, and the modes the Social page offers. */
    @Test fun firstPublishDefaultsAndTheModesOffered() {
        assertEquals(true to "signed-in", VoiciCallSettings.FIRST_PUBLISH)
        assertEquals(1, com.flagshipserver.app.core.voici.VoiciOwner.FIRST_PUBLISH_ACCEPTS_MESSAGES)
        assertEquals(1, com.flagshipserver.app.core.voici.VoiciOwner.emptyState("alice").acceptsMessages)
        assertEquals(listOf("signed-in", "anyone", "callback"), VoiciCallSettings.FROM_CHOICES)
    }

    @Test fun callHoursEditorFormRoundTripsAndRefusesWhatTheSettingWouldRefuse() {
        val h = VoiciCallSettings.CallHours(setOf(0, 1, 2, 3, 4), 9 * 60, 17 * 60 + 30, "Europe/Paris")
        assertEquals(com.flagshipserver.app.core.voici.VoiciCallHours("1111100", "0900", "1730", "Europe/Paris"), h.toHours())
        assertEquals(h, VoiciCallSettings.CallHours.from(h.toHours()))
        assertTrue(h.valid)
        assertFalse("no day", h.copy(days = emptySet()).valid)
        assertFalse("start equals end", h.copy(end = h.start).valid)
        assertFalse("unknown zone", h.copy(zone = "Mars/Olympus").valid)
        assertNull(VoiciCallSettings.CallHours.from(com.flagshipserver.app.core.voici.VoiciCallHours("1111111", "0900", "2400", "UTC")))
        assertEquals(setOf(0, 1, 2, 3, 4), VoiciCallSettings.CallHours.default("UTC").days)
    }

    @Test fun theRingingPhoneHoldsACallToTheOwnersHours() {
        val q = CallQuietHours(false, 0, 0)
        val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        val mondayTen = 1799053200000L // Monday 10:00 in Paris (09:00 UTC)
        val weekdays = com.flagshipserver.app.core.voici.VoiciCallHours("1111100", "0900", "1730", "Europe/Paris")
        assertTrue(VoiciCallCenter.shouldRing(mondayTen, mondayTen, q, utc, weekdays))
        val saturdayNoon = 1799492400000L
        assertFalse("outside the hours nothing rings (the call is missed)", VoiciCallCenter.shouldRing(saturdayNoon, saturdayNoon, q, utc, weekdays))
        assertTrue("no hours: always", VoiciCallCenter.shouldRing(saturdayNoon, saturdayNoon, q, utc, null))
    }

    @Test fun viewState() {
        VoiciCallSettings.viewState(isAdmin = true, isPublic = true, callsOn = true).let {
            assertTrue(it.canEdit); assertTrue(it.showsWho); assertNull(it.note)
        }
        VoiciCallSettings.viewState(isAdmin = true, isPublic = true, callsOn = false).let { assertTrue(it.canEdit); assertFalse(it.showsWho) }
        VoiciCallSettings.viewState(isAdmin = false, isPublic = true, callsOn = true).let {
            assertFalse(it.canEdit); assertEquals(VoiciCallSettings.Note.AdminOnly, it.note)
        }
        VoiciCallSettings.viewState(isAdmin = true, isPublic = false, callsOn = false).let {
            assertFalse(it.canEdit); assertEquals(VoiciCallSettings.Note.PublishFirst, it.note)
        }
    }

    @Test fun quietHoursAcrossMidnightSameDayAndAllDay() {
        val night = CallQuietHours(true, 22 * 60, 7 * 60)
        assertTrue(night.isQuiet(23 * 60)); assertTrue(night.isQuiet(0)); assertTrue(night.isQuiet(6 * 60 + 59))
        assertFalse(night.isQuiet(7 * 60)); assertFalse(night.isQuiet(12 * 60))
        assertFalse(night.copy(on = false).isQuiet(23 * 60))
        val day = CallQuietHours(true, 9 * 60, 17 * 60)
        assertTrue(day.isQuiet(12 * 60)); assertFalse(day.isQuiet(17 * 60)); assertFalse(day.isQuiet(8 * 60))
        assertTrue(CallQuietHours(true, 600, 600).isQuiet(5))
        assertEquals(1380, CallQuietHours(true, -60, 1500).normalized().startMinute)
    }

    @Test fun shouldRingRespectsQuietHoursAndTheRingWindow() {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.clear(); cal.set(2026, 10, 15, 23, 30)
        val lateNight = cal.timeInMillis
        val night = CallQuietHours(true, 22 * 60, 7 * 60)
        assertFalse(VoiciCallCenter.shouldRing(lateNight, lateNight, night, Calendar.getInstance(TimeZone.getTimeZone("UTC"))))
        assertTrue(VoiciCallCenter.shouldRing(lateNight, lateNight, night.copy(on = false), Calendar.getInstance(TimeZone.getTimeZone("UTC"))))
        assertFalse(VoiciCallCenter.shouldRing(lateNight - 46_000, lateNight, night.copy(on = false), Calendar.getInstance(TimeZone.getTimeZone("UTC"))))
    }

    private fun row(id: String, at: Long, conv: String = "c1", video: Boolean = false) = VoiciMissedCallRow(id, conv, "p", "no-answer", at, video)

    @Test fun timelinePutsEachMissedCallInTimeOrder() {
        data class M(val id: String, val at: Long)
        val entries = VoiciThreadEntry.timeline(
            listOf(M("a", 10), M("b", 30)), { it.id }, { it.at },
            listOf(row("late", 40), row("mid", 20), row("other", 15, conv = "c2"), row("first", 5)), "c1",
        )
        assertEquals(listOf("c:first", "m:a", "c:mid", "m:b", "c:late"), entries.map { it.key })
    }

    /** The shared vector's missed call opens and checks; a forged one and an unknown inbox key are dropped. */
    @Test fun missedCallsOpenFromTheSharedVector() {
        val v = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voici-calls/vectors.json").readText()).jsonObject
        val k = v.o("keys")
        val mc = v.o("missedCall")
        val callId = mc.o("entry").o("request").s("callId")
        val items = listOf(VoiciMissedCallItem("1", callId, mc.s("sealed"), 1), VoiciMissedCallItem("2", callId, mc.s("forgedSealed"), 2))
        val origin = v.o("constants").s("origin")
        val rows = VoiciMissedCalls.open(items, listOf(ByteArray(32) { 1 }, h(k.s("inboxSeed"))), k.s("pageId"), origin, listOf(k.s("caPub")))
        assertEquals(1, rows.size)
        assertEquals(k.s("conv"), rows[0].conv)
        assertEquals(k.s("pseudonymPub"), rows[0].pseudonymPub)
        assertEquals("no-answer", rows[0].reason)
        assertTrue(VoiciMissedCalls.open(items, listOf(ByteArray(32) { 1 }), k.s("pageId"), origin, listOf(k.s("caPub"))).isEmpty())
    }
}

class VoiciCallScreenModelTest {
    private fun ui(phase: VoiciCallCenter.Phase, end: String? = null, remote: String = "off") = VoiciCallCenter.Ui(phase = phase, endCode = end, remoteCamera = remote)

    @Test fun status() {
        assertEquals(com.flagshipserver.app.R.string.voici_call_unlock, VoiciCallScreenModel.status(ui(VoiciCallCenter.Phase.NeedsUnlock)))
        assertEquals(com.flagshipserver.app.R.string.voici_call_connected, VoiciCallScreenModel.status(ui(VoiciCallCenter.Phase.Connected)))
        assertEquals(com.flagshipserver.app.R.string.voici_call_answered_elsewhere, VoiciCallScreenModel.status(ui(VoiciCallCenter.Phase.Ended, "answered-elsewhere")))
        assertEquals(com.flagshipserver.app.R.string.voici_call_media_unavailable, VoiciCallScreenModel.status(ui(VoiciCallCenter.Phase.Ended, "media-unavailable")))
        assertEquals(com.flagshipserver.app.R.string.voici_call_limit, VoiciCallScreenModel.status(ui(VoiciCallCenter.Phase.Ended, "limit")))
        assertEquals(com.flagshipserver.app.R.string.voici_call_ended, VoiciCallScreenModel.status(ui(VoiciCallCenter.Phase.Ended, "no-answer")))
    }

    @Test fun remoteCameraOnlyWhileConnected() {
        assertNull(VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connecting, remote = "on")))
        assertEquals(VoiciCallScreenModel.RemoteCamera.On, VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connected, remote = "on")))
        assertEquals(VoiciCallScreenModel.RemoteCamera.Paused, VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connected, remote = "paused")))
        assertNull(VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connected)))
    }
}
