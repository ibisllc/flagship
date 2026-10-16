// SessionServerFinder: the twin of the webapp's findSessionServer cases.

package com.flagshipserver.app.core

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionServerFinderTest {

    @Test fun theHintAnswersFirst() = runTest {
        val asked = mutableListOf<String>()
        val hit = SessionServerFinder.find("s1", first = listOf("Office.H.flagship.services", "home.h.flagship.services"), more = { error("not read") }) {
            asked += it
            true
        }
        assertEquals("office.h.flagship.services", hit)
        assertEquals(listOf("office.h.flagship.services"), asked)
    }

    @Test fun otherServersAreAskedOnlyWhenTheFirstMiss() = runTest {
        val asked = mutableListOf<String>()
        val hit = SessionServerFinder.find(
            "s1",
            first = listOf(null, "home.h.flagship.services"),
            more = { listOf("home.h.flagship.services", "music.h.flagship.services", "office.h.flagship.services") },
        ) {
            asked += it
            if (it.startsWith("music")) throw java.io.IOException("offline")
            it.startsWith("office")
        }
        assertEquals("office.h.flagship.services", hit)
        assertEquals("each asked once", listOf("home.h.flagship.services", "music.h.flagship.services", "office.h.flagship.services"), asked)
    }

    @Test fun noneHoldsIt() = runTest {
        assertNull(SessionServerFinder.find("s1", first = listOf("a"), more = { throw java.io.IOException("x") }) { false })
        assertNull(SessionServerFinder.find("", first = listOf("a")) { true })
    }
}
