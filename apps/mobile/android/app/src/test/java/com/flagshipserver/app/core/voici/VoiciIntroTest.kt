// The one-time voi.ci intro (core/voici/VoiciIntro.kt): who sees it, once, and the promo from `.com`.

package com.flagshipserver.app.core.voici

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class VoiciIntroTest {
    @Test fun showsOnceRightAfterCreation() {
        assertTrue(VoiciIntro.shouldShow(VoiciIntro.Path.Created, "alice", alreadyShown = false, canPublish = true))
        assertFalse("never twice for the same account", VoiciIntro.shouldShow(VoiciIntro.Path.Created, "alice", true, true))
        assertFalse(VoiciIntro.shouldShow(VoiciIntro.Path.Created, "", false, true))
        assertFalse(VoiciIntro.shouldShow(null, "alice", false, true))
    }

    /** "Turn on" runs the Public switch's steps, so a device that can't publish the page never sees the sheet. */
    @Test fun notOnADeviceThatCantPublish() {
        assertFalse(VoiciIntro.shouldShow(VoiciIntro.Path.Created, "alice", alreadyShown = false, canPublish = false))
    }

    @Test fun neverAfterJoinRecoveryOrDemo() {
        for (p in listOf(VoiciIntro.Path.Joined, VoiciIntro.Path.Recovered, VoiciIntro.Path.Demo)) {
            assertFalse(p.name, VoiciIntro.shouldShow(p, "alice", false, true))
        }
    }

    @Test fun theShownMarkIsPerAccount() {
        assertEquals("flagship.voici.intro.shown.alice", VoiciIntro.prefsKey("alice"))
        assertTrue(VoiciIntro.prefsKey("alice") != VoiciIntro.prefsKey("bob"))
    }

    @Test fun promoIsHiddenWhenNullEmptyOrMalformed() {
        assertNull(VoiciIntro.parsePromo("""{"promo":null}"""))
        assertNull(VoiciIntro.parsePromo("""{"promo":{"text":"  ","until":null}}"""))
        assertNull(VoiciIntro.parsePromo("""{"promo":{"text":3}}"""))
        assertNull(VoiciIntro.parsePromo("not json"))
        assertNull(VoiciIntro.parsePromo(null))
        assertEquals(VoiciIntro.Promo("Free Pro for a month", "2027-01-01T00:00:00Z"),
            VoiciIntro.parsePromo("""{"promo":{"text":" Free Pro for a month ","until":"2027-01-01T00:00:00Z"}}"""))
        assertEquals(VoiciIntro.Promo("Hi", null), VoiciIntro.parsePromo("""{"promo":{"text":"Hi","until":null}}"""))
    }

    @Test fun languageCodesMatchDotCom() {
        assertEquals("pt-BR", VoiciIntro.langCode(Locale.forLanguageTag("pt-BR")))
        assertEquals("zh-Hans", VoiciIntro.langCode(Locale.forLanguageTag("zh-Hans-CN")))
        assertEquals("fr", VoiciIntro.langCode(Locale.FRANCE))
        assertEquals("en", VoiciIntro.langCode(Locale.ROOT))
    }
}
