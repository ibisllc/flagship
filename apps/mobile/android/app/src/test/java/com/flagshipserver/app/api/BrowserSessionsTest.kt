// Regression: the box lists the session each of the account's own devices
// paired itself with next to Remote browsers, and Settings → Browser sessions
// showed this phone there instead of only under Trusted devices. Browser
// sessions keeps only the sessions the box marks "remote".

package com.flagshipserver.app.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserSessionsTest {
    @Test fun onlyRemoteSessionsAreBrowserSessions() {
        assertTrue(PairedSessionSummary("r", 0, current = false, kind = "remote").isBrowserSession)
        assertFalse(PairedSessionSummary("d", 0, current = true, kind = "device").isBrowserSession)
        assertFalse(PairedSessionSummary("o", 0, current = false, kind = "device").isBrowserSession)
    }

    @Test fun olderBoxWithoutKindStillLeavesThisDeviceOut() {
        assertFalse(PairedSessionSummary("me", 0, current = true).isBrowserSession)
        assertTrue(PairedSessionSummary("x", 0, current = false).isBrowserSession)
    }

    @Test fun decodesKindAndToleratesItsAbsence() {
        val body = """{"sessions":[{"tokenPrefix":"a","addedAt":1,"current":true,"kind":"device"},""" +
            """{"tokenPrefix":"b","addedAt":2,"current":false,"kind":"remote","expiresAt":9},""" +
            """{"tokenPrefix":"c","addedAt":3,"current":false}]}"""
        val r = Json { ignoreUnknownKeys = true }.decodeFromString(PairedSessionsListResponse.serializer(), body)
        assertEquals(listOf("device", "remote", null), r.sessions.map { it.kind })
        assertEquals(9L, r.sessions[1].expiresAt)
    }

    @Test fun theMockShowsThisPhoneAsADeviceNotABrowser() = runTest {
        val sessions = MockScreensClient(simulatedLatencyMs = 0).pairedSessionsList().sessions
        assertEquals(listOf("f9e8d7c6"), sessions.filter { it.isBrowserSession }.map { it.tokenPrefix })
    }
}
