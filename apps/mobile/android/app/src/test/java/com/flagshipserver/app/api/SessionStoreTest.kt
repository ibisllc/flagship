// Exercises the InMemorySessionStore + the StateFlow surface — both
// are pure Kotlin so no Robolectric needed.

package com.flagshipserver.app.api

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionStoreTest {
    @Test fun emptyStoreReturnsNulls() = runTest {
        val s = InMemorySessionStore()
        assertNull(s.podBaseUrl.first())
        assertNull(s.sessionToken.first())
    }

    @Test fun setAndClear() = runTest {
        val s = InMemorySessionStore()
        s.setPodBaseUrl("https://home.harry.flagship.services")
        s.setSessionToken("deadbeef".repeat(8))
        assertEquals("https://home.harry.flagship.services", s.podBaseUrl.first())
        assertEquals("deadbeef".repeat(8), s.sessionToken.first())
        s.clear()
        assertNull(s.podBaseUrl.first())
        assertNull(s.sessionToken.first())
    }
}
