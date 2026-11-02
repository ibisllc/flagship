package com.flagshipserver.app.api

import org.junit.Assert.assertEquals
import org.junit.Test

class AppDisplayNameTest {
    @Test fun slugReadsAsWords() {
        assertEquals("Chess Club", AppDisplayName.fromSlug("chess-club"))
        assertEquals("Notes", AppDisplayName.fromSlug("notes"))
        assertEquals("My App 2", AppDisplayName.fromSlug("my_app-2"))
        assertEquals("-", AppDisplayName.fromSlug("-"))
        assertEquals("Chess Club", AppDisplayName.fromServiceId("river-otter--chess-club"))
        assertEquals("Budget", AppDisplayName.fromServiceId("budget"))
    }

    @Test fun boxNameWinsOverTheSlug() {
        val app = AppSummary(serviceId = "a--chess-club", creator = "a", slug = "chess-club", urlLabel = "x", url = "https://x", status = "running", installedAt = 0)
        assertEquals("Chess Club", app.displayName)
        assertEquals("Club d'échecs", app.copy(name = "Club d'échecs").displayName)
        assertEquals("Chess Club", app.copy(name = "  ").displayName)
    }
}
