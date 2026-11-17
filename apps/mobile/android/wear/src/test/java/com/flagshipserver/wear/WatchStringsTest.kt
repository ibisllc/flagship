// The tile's, complication's and app's words come from the watch's own resources, in the watch's
// language (the phone sends only data): English, and German as one translated language.

package com.flagshipserver.wear

import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.companion.WatchProjection
import com.flagshipserver.companion.WatchText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class WatchStringsTest {
    private val ctx get() = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun englishTileAndComplicationText() {
        assertEquals("2/3 up", WatchStrings.text(ctx, WatchText.Up(2, 3)))
        assertEquals("1 waiting", WatchStrings.text(ctx, WatchText.Waiting(1)))
        assertEquals("3 waiting", WatchStrings.text(ctx, WatchText.Waiting(3)))
        assertEquals("Leader: Home", WatchStrings.text(ctx, WatchText.Leader("Home")))
        assertEquals("Sealing", WatchStrings.text(ctx, WatchText.Phase("sealing")))
        assertEquals("Setup", WatchStrings.text(ctx, WatchText.Phase("something-new")))
        assertEquals("Open Flagship on your phone", WatchStrings.text(ctx, WatchText.OpenPhone))
        assertEquals("Open phone", WatchStrings.short(ctx, WatchText.OpenPhone))
        assertEquals("Open Flagship on your phone to see your servers here.", WatchStrings.description(ctx, WatchText.OpenPhone))
        assertEquals("Flagship: 2/3 up", WatchStrings.description(ctx, WatchText.Up(2, 3)))
        assertEquals("Add one in Flagship on your phone", WatchStrings.text(ctx, WatchText.AddOnPhone))
        assertEquals("Cabin", WatchStrings.text(ctx, WatchText.Name("Cabin")))
        assertEquals("Sealing your disk key", WatchStrings.phaseTitle(ctx, "sealing"))
        assertEquals("Added device", WatchStrings.eventLabel(ctx, "device-added"))
        assertEquals("Something new", WatchStrings.eventLabel(ctx, "something-new"))
    }

    @Test
    fun everyKnownPhaseAndEventHasItsOwnWords() {
        val genericShort = WatchStrings.text(ctx, WatchText.Phase("?"))
        val genericTitle = WatchStrings.phaseTitle(ctx, "?")
        for (p in WatchProjection.PHASES) {
            assertNotEquals(p, genericShort, WatchStrings.text(ctx, WatchText.Phase(p)))
            assertNotEquals(p, genericTitle, WatchStrings.phaseTitle(ctx, p))
        }
        for (k in WatchProjection.EVENT_KINDS) assertNotEquals(k, WatchProjection.unknownEventLabel(k), WatchStrings.eventLabel(ctx, k))
    }

    @Test
    @Config(qualifiers = "de")
    fun theWatchsLanguageNotThePhones() {
        assertEquals("2/3 online", WatchStrings.text(ctx, WatchText.Up(2, 3)))
        assertEquals("1 wartet", WatchStrings.text(ctx, WatchText.Waiting(1)))
        assertEquals("2 warten", WatchStrings.text(ctx, WatchText.Waiting(2)))
        assertEquals("Öffne Flagship auf deinem Telefon", WatchStrings.text(ctx, WatchText.OpenPhone))
        assertEquals("Gerät hinzugefügt", WatchStrings.eventLabel(ctx, "device-added"))
        RuntimeEnvironment.setQualifiers("en")
        assertEquals("2/3 up", WatchStrings.text(ctx, WatchText.Up(2, 3)))
    }
}
