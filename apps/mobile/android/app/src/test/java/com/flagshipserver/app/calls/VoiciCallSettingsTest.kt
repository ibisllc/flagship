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

    /** Owner decisions 2026-11-16 and 2026-11-20: the first publish's defaults, and the modes the Social page offers. */
    @Test fun firstPublishDefaultsAndTheModesOffered() {
        assertEquals(true to "callback", VoiciCallSettings.FIRST_PUBLISH)
        assertEquals(1, com.flagshipserver.app.core.voici.VoiciOwner.FIRST_PUBLISH_ACCEPTS_MESSAGES)
        assertEquals(1, com.flagshipserver.app.core.voici.VoiciOwner.emptyState("alice").acceptsMessages)
        assertEquals(listOf("anyone", "callback"), VoiciCallSettings.FROM_CHOICES)
        assertFalse("no \"Anyone signed in with Flagship\" in the picker", "signed-in" in VoiciCallSettings.FROM_CHOICES)
    }

    /** An index an older app published with "signed-in" (or "accepted") shows as callback, and the next publish writes it. */
    @Test fun aSignedInIndexReadsAsCallback() {
        assertEquals("callback", VoiciCallSettings.mode("signed-in"))
        assertEquals("callback", VoiciCallSettings.mode("accepted"))
        assertEquals("callback", VoiciCallSettings.mode(null))
        assertEquals("anyone", VoiciCallSettings.mode("anyone"))
        assertEquals("callback", VoiciCallSettings.carried("signed-in"))
        assertEquals("anyone", VoiciCallSettings.carried("anyone"))
        assertTrue("old indexes stay readable", "signed-in" in VoiciCallSettings.FROM_VALUES)
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
        val mondayTen = 1799053200000L // Monday 10:00 in Paris (09:00 UTC)
        val weekdays = com.flagshipserver.app.core.voici.VoiciCallHours("1111100", "0900", "1730", "Europe/Paris")
        assertTrue(VoiciCallCenter.shouldRing(mondayTen, mondayTen, weekdays))
        val saturdayNoon = 1799492400000L
        assertFalse("outside the hours nothing rings (the call is missed)", VoiciCallCenter.shouldRing(saturdayNoon, saturdayNoon, weekdays))
        assertTrue("no hours: always", VoiciCallCenter.shouldRing(saturdayNoon, saturdayNoon, null))
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

    /** The app has no Do Not Disturb of its own: only the ring window and the owner's hours decide. */
    @Test fun shouldRingKeepsOnlyTheRingWindow() {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.clear(); cal.set(2026, 10, 15, 23, 30)
        val lateNight = cal.timeInMillis
        assertTrue(VoiciCallCenter.shouldRing(lateNight, lateNight))
        assertFalse(VoiciCallCenter.shouldRing(lateNight - 46_000, lateNight))
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

    @Test fun connectingSteps() {
        val c = VoiciCallCenter.Phase.Connecting
        assertEquals(com.flagshipserver.app.R.string.voici_call_connecting, VoiciCallScreenModel.status(ui(c)))
        assertEquals(com.flagshipserver.app.R.string.voici_call_step_route, VoiciCallScreenModel.status(VoiciCallCenter.Ui(phase = c, step = VoiciCallConnectStep.Route)))
        assertEquals(com.flagshipserver.app.R.string.voici_call_step_secure, VoiciCallScreenModel.status(VoiciCallCenter.Ui(phase = c, step = VoiciCallConnectStep.Secure)))
        assertEquals(com.flagshipserver.app.R.string.voici_call_step_path, VoiciCallScreenModel.status(VoiciCallCenter.Ui(phase = c, step = VoiciCallConnectStep.Path)))
        assertEquals(com.flagshipserver.app.R.string.voici_call_step_audio, VoiciCallScreenModel.status(VoiciCallCenter.Ui(phase = c, step = VoiciCallConnectStep.Audio)))
        val s = VoiciCallConnectSteps()
        assertTrue(s.advance(VoiciCallConnectStep.Route))
        assertTrue(s.advance(VoiciCallConnectStep.Path))
        assertFalse(s.advance(VoiciCallConnectStep.Secure))
        assertFalse(s.advance(VoiciCallConnectStep.Path))
        assertTrue(s.advance(VoiciCallConnectStep.Audio))
        assertEquals(20_000L, VoiciCallConnectSteps.SLOW_MS)
        assertEquals(45_000L, VoiciCallConnectSteps.LIMIT_MS)
    }

    @Test fun remoteCameraOnlyWhileConnected() {
        assertNull(VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connecting, remote = "on")))
        assertEquals(VoiciCallScreenModel.RemoteCamera.On, VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connected, remote = "on")))
        assertEquals(VoiciCallScreenModel.RemoteCamera.Paused, VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connected, remote = "paused")))
        assertNull(VoiciCallScreenModel.remoteCamera(ui(VoiciCallCenter.Phase.Connected)))
    }
}
