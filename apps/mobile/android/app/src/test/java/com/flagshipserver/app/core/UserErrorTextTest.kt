// Device report 2026-10-18: the Services tab showed "connection closed", the
// Peer-backup page "Couldn't load / connection closed" and Trusted devices
// "HTTP 503: error code: 1102". Every failure is one plain sentence.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.ScreensError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.EOFException
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class UserErrorTextTest {

    private val rawBits = listOf(
        "HTTP", "1102", "error code", "closed", "Exception", "resolve host", "timeout", "timed out",
        "okhttp", "java.", "line ", "EOF", "{", "null",
    )

    private fun assertPlain(s: String) {
        rawBits.forEach { assertFalse("\"$s\" leaks \"$it\"", s.contains(it, ignoreCase = true)) }
    }

    @Test fun connectionClosedIsADroppedConnection() {
        assertEquals(UserErrorText.DROPPED, UserErrorText.of(IOException("connection closed")))
        assertEquals(UserErrorText.DROPPED, UserErrorText.of(IOException("closed")))
        assertEquals(UserErrorText.DROPPED, UserErrorText.of(EOFException()))
        assertEquals(UserErrorText.DROPPED, UserErrorText.of(IOException("unexpected end of stream on https://x/")))
        assertEquals(UserErrorText.DROPPED, UserErrorText.ofRaw("connection closed"))
        assertPlain(UserErrorText.DROPPED)
    }

    @Test fun http5xxIsATemporaryServerProblemWhateverTheBody() {
        listOf(
            HttpException(503, "error code: 1102"),
            HttpException(502, "Bad gateway"),
            ScreensError.Http(500, "{\"error\":\"boom\"}"),
        ).forEach {
            assertEquals(UserErrorText.SERVER_PROBLEM, UserErrorText.of(it))
        }
        assertEquals(UserErrorText.SERVER_PROBLEM, UserErrorText.ofRaw("HTTP 503: error code: 1102"))
        assertPlain(UserErrorText.SERVER_PROBLEM)
    }

    @Test fun timeoutsAndUnknownHostsAreSaidInPlainWords() {
        assertEquals(UserErrorText.TIMEOUT, UserErrorText.of(SocketTimeoutException("timeout")))
        assertEquals(UserErrorText.TIMEOUT, UserErrorText.of(IOException("Read timed out")))
        assertEquals(UserErrorText.TIMEOUT, UserErrorText.of(HttpException(408, "")))
        assertEquals(UserErrorText.OFFLINE, UserErrorText.of(UnknownHostException("Unable to resolve host \"flagshipserver.com\": No address associated with hostname")))
        assertEquals(UserErrorText.OFFLINE, UserErrorText.of(IOException("Failed to connect to /10.0.0.1:443")))
        assertEquals(UserErrorText.OFFLINE, UserErrorText.of(IOException("something odd")))
        assertEquals(UserErrorText.TIMEOUT, UserErrorText.ofRaw("timeout"))
        assertEquals(UserErrorText.OFFLINE, UserErrorText.ofRaw("Unable to resolve host \"x\""))
        assertPlain(UserErrorText.TIMEOUT)
        assertPlain(UserErrorText.OFFLINE)
    }

    @Test fun aBoxSentenceInARefusalIsShownAsTheBoxWroteIt() {
        val refused = ScreensError.Http(403, "{\"error\":\"Only an admin device of this account can do that.\"}")
        assertEquals("Only an admin device of this account can do that.", UserErrorText.of(refused))
    }

    @Test fun aDeveloperReasonFromComBecomesASentence() {
        val e = HttpException(409, "{\"error\":\"subdomain already controlled by a different RCK\"}")
        val s = UserErrorText.of(e)
        assertTrue(s, s.startsWith("That name is still held by an earlier, unfinished order"))
        assertFalse(s.contains("RCK"))
        // An unknown lowercase reason is not shown, only the generic refusal.
        assertEquals(UserErrorText.REFUSED, UserErrorText.of(HttpException(400, "{\"error\":\"malformed body\"}")))
        assertEquals("Try later.", UserErrorText.of(HttpException(400, "x"), fallback = "Try later."))
    }

    @Test fun anAuthoredMessageStaysAndAShellLineNumberGoes() {
        assertEquals("Pick a name first.", UserErrorText.of(IllegalStateException("Pick a name first.")))
        assertEquals(
            "Setup stopped while Expanding the disk to 68 GB",
            UserErrorText.ofRaw("Setup stopped while Expanding the disk to 68 GB (line 66)"),
        )
        assertEquals("Setup stopped while Writing the key", UserErrorText.stripInternals("Setup stopped while Writing the key (line 78)"))
    }

    @Test fun anythingRawBecomesTheFallbackOrTheGenericSentence() {
        assertEquals("Couldn't load services.", UserErrorText.ofRaw("noSessionToken", "Couldn't load services."))
        assertTrue(UserErrorText.of(NullPointerException()).startsWith("Something went wrong (code "))
        assertEquals(UserErrorText.GENERIC, UserErrorText.ofRaw(null))
        assertEquals(UserErrorText.GENERIC, UserErrorText.ofRaw("kotlinx.serialization.SerializationException: bad"))
        assertEquals("Couldn't load.", UserErrorText.of(RuntimeException("java.lang.IllegalStateException: x"), "Couldn't load."))
        assertPlain(UserErrorText.GENERIC)
    }

    @Test fun anAuthoredSentenceAboutATimeoutIsNotRewritten() {
        assertEquals("The pairing session timed out.", UserErrorText.ofRaw("The pairing session timed out."))
        assertEquals("The window closed before the check finished.", UserErrorText.of(IllegalStateException("The window closed before the check finished.")))
    }
}
