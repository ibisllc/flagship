// Create server starts with the address its preview shows (device bug M6:
// an empty field under a "home.<user>…" preview, then "Enter a subdomain.").

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerLabelFirstFreeTest {
    @Test fun aNewAccountStartsWithHome() {
        assertEquals("home", ServerLabel.firstFree(emptyList()))
        assertTrue(ServerLabel.isValid(ServerLabel.firstFree(emptyList())))
    }

    @Test fun takenLabelsAreSkipped() {
        assertEquals("home2", ServerLabel.firstFree(listOf("home")))
        assertEquals("home4", ServerLabel.firstFree(listOf("Home", "home2", "home3", "office")))
    }
}
