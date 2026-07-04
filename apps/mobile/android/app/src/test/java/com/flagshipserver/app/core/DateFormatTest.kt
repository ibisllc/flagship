package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import java.util.TimeZone

/**
 * Deterministic contract for [FlagshipDateFormat] — the twin of the iOS
 * `DateFlagshipFormatTests` + webapp `dateFormat` test. Pins UTC + en_US so
 * the spec S2 rules assert byte-exactly regardless of the CI machine's locale.
 */
class DateFormatTest {
    private val utc = TimeZone.getTimeZone("UTC")
    private val enUS = Locale.US
    // 2024-07-04 12:00:00 UTC
    private val now = 1_720_094_400_000L

    private fun fmt(epochMs: Long, includeTime: Boolean = false): String =
        FlagshipDateFormat.format(epochMs, nowMs = now, includeTime = includeTime, locale = enUS, timeZone = utc)

    @Test fun justNow() {
        assertEquals("just now", fmt(now - 30_000L))
        assertEquals("just now", fmt(now - 59_000L))
    }

    @Test fun minutesAgo() {
        assertEquals("5m ago", fmt(now - 5 * 60_000L))
        assertEquals("59m ago", fmt(now - 59 * 60_000L))
    }

    @Test fun hoursAgo() {
        assertEquals("3h ago", fmt(now - 3 * 3_600_000L))
        assertEquals("23h ago", fmt(now - 23 * 3_600_000L))
    }

    @Test fun sameYearOmitsYear() {
        // 40 days earlier — still 2024, so no year in the string.
        val s = fmt(now - 40L * 86_400_000L)
        assertTrue(s, s.contains("May"))
        assertFalse(s, s.contains("2024"))
    }

    @Test fun olderIncludesYear() {
        val s = fmt(now - 400L * 86_400_000L)
        assertTrue(s, s.contains("2023"))
    }

    @Test fun includeTimeSameYearHasClock() {
        val s = fmt(now - 40L * 86_400_000L, includeTime = true)
        assertTrue(s, s.contains("May"))
        assertTrue(s, s.contains(":"))
    }

    @Test fun futureFallsToAbsolute() {
        // A future timestamp must never read "just now" / "-1m ago".
        val s = fmt(now + 5L * 86_400_000L)
        assertFalse(s, s.contains("ago"))
        assertFalse(s, s.contains("just now"))
        assertTrue(s, s.contains("Jul"))
    }
}
