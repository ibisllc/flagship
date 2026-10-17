// A caught error shown as a sentence is also logged (class, message, causes),
// and an unclassified one carries a short code that matches the log line
// (device bug 2026-10-16: "Something went wrong" and nothing in logcat).

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorLogTest {
    @Test fun theUnknownSentenceCarriesTheLoggedCode() {
        val e = IllegalStateException("mint refused")
        val code = NetworkErrorHumanizer.errorCode(e)
        assertEquals(4, code.length)
        assertEquals("Something went wrong (code $code). Please try again.", NetworkErrorHumanizer.humanize(e, "create-server"))
        assertTrue(ErrorLog.line("create-server", e, code).startsWith("[$code] create-server: java.lang.IllegalStateException: mint refused"))
    }

    @Test fun theLineFollowsCausesOnOneShortLine() {
        val e = RuntimeException("outer\nsecond line", IllegalArgumentException("x".repeat(500)))
        val line = ErrorLog.line("where", e, "ABCD")
        assertTrue(!line.contains("\n"))
        assertTrue(line.contains(" <- java.lang.IllegalArgumentException: "))
        assertTrue(line.length < 500)
    }
}
