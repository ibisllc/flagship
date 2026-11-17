// The call screen's pure parts (docs/voici-calls.md "Call screen"): the timer, the initial, when the screen sleeps
// against the ear, where the corner tile snaps, and the audio routes Telecom reports.

package com.flagshipserver.app.calls

import android.telecom.CallAudioState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class VoiciCallStageTest {
    @Test fun theTimerIsMinutesAndSecondsThenHours() {
        assertEquals("0:00", CallStageModel.elapsed(0, Locale.US))
        assertEquals("0:07", CallStageModel.elapsed(7_900, Locale.US))
        assertEquals("12:05", CallStageModel.elapsed(725_000, Locale.US))
        assertEquals("1:00:00", CallStageModel.elapsed(3_600_000, Locale.US))
        assertEquals("1:02:03", CallStageModel.elapsed(3_723_000, Locale.US))
        assertEquals("0:00", CallStageModel.elapsed(-5_000, Locale.US))
    }

    @Test fun theInitialIsTheFirstLetter() {
        assertEquals("V", CallStageModel.initial("voi.ci/ana"))
        assertEquals("A", CallStageModel.initial("  ana"))
        assertEquals("?", CallStageModel.initial(""))
        assertEquals("?", CallStageModel.initial("  · "))
    }

    @Test fun theScreenSleepsOnlyInAConnectedAudioCallOnTheEarpiece() {
        assertTrue(CallStageModel.proximity(videoMode = false, over = false, connected = true, route = CallAudioRoute.Earpiece))
        assertFalse(CallStageModel.proximity(videoMode = true, over = false, connected = true, route = CallAudioRoute.Earpiece))
        assertFalse(CallStageModel.proximity(videoMode = false, over = true, connected = true, route = CallAudioRoute.Earpiece))
        assertFalse(CallStageModel.proximity(videoMode = false, over = false, connected = false, route = CallAudioRoute.Earpiece))
        assertFalse(CallStageModel.proximity(videoMode = false, over = false, connected = true, route = CallAudioRoute.Speaker))
        assertFalse(CallStageModel.proximity(videoMode = false, over = false, connected = true, route = CallAudioRoute.Bluetooth))
    }

    @Test fun theTileSnapsToTheNearestCorner() {
        assertEquals(CallStageModel.Corner.TopStart, CallStageModel.nearestCorner(10f, 10f, 400f, 800f))
        assertEquals(CallStageModel.Corner.TopEnd, CallStageModel.nearestCorner(390f, 100f, 400f, 800f))
        assertEquals(CallStageModel.Corner.BottomStart, CallStageModel.nearestCorner(50f, 700f, 400f, 800f))
        assertEquals(CallStageModel.Corner.BottomEnd, CallStageModel.nearestCorner(300f, 500f, 400f, 800f))
    }

    @Test fun telecomRoutesBecomeTheAudioButton() {
        val builtIn = CallAudioRouter.fromTelecom(CallAudioState.ROUTE_EARPIECE, CallAudioState.ROUTE_EARPIECE or CallAudioState.ROUTE_SPEAKER)
        assertEquals(CallAudioRoute.Earpiece, builtIn.current)
        assertEquals(listOf(CallAudioRoute.Earpiece, CallAudioRoute.Speaker), builtIn.available)
        assertFalse(builtIn.needsMenu)
        assertEquals(CallAudioRoute.Speaker, builtIn.toggled)

        val speaker = CallAudioRouter.fromTelecom(CallAudioState.ROUTE_SPEAKER, CallAudioState.ROUTE_EARPIECE or CallAudioState.ROUTE_SPEAKER)
        assertEquals(CallAudioRoute.Speaker, speaker.current)
        assertEquals(CallAudioRoute.Earpiece, speaker.toggled)

        val headset = CallAudioRouter.fromTelecom(CallAudioState.ROUTE_BLUETOOTH, CallAudioState.ROUTE_EARPIECE or CallAudioState.ROUTE_SPEAKER or CallAudioState.ROUTE_BLUETOOTH)
        assertEquals(CallAudioRoute.Bluetooth, headset.current)
        assertTrue(headset.needsMenu)
        assertEquals(listOf(CallAudioRoute.Earpiece, CallAudioRoute.Bluetooth, CallAudioRoute.Speaker), headset.available)
    }
}
