package com.flagshipserver.app.ui.shell.tabs

import org.junit.Assert.assertEquals
import org.junit.Test

class VibeSessionNavTest {
    @Test fun backFromASessionLandsOnTheChooser() {
        assertEquals(
            listOf("apps-list", "build/source", "vibe/generating/s1"),
            openVibeSessionStack(listOf("apps-list", "build/source", "vibe/key", "vibe/describe"), "vibe/generating/s1"),
        )
        assertEquals(
            listOf("apps-list", "build/source", "vibe-code-chat/s2"),
            openVibeSessionStack(listOf("apps-list", "build/source", "build/journal"), vibeSessionChatRoute("s2")),
        )
    }

    @Test fun aSessionOpenedFromElsewhereGetsTheChooserUnderIt() {
        assertEquals(
            listOf("apps-list", "app-detail/a", "build/source", "vibe-code-chat/s3"),
            openVibeSessionStack(listOf("apps-list", "app-detail/a"), vibeSessionChatRoute("s3")),
        )
    }

    @Test fun aTakenNameOpensTheSessionsListAboveTheChooser() {
        assertEquals(
            listOf("apps-list", "build/source", "build/journal"),
            openVibeSessionStack(listOf("apps-list", "build/source", "vibe/key", "vibe/describe"), BUILD_SESSIONS_ROUTE),
        )
    }
}

class OpenEditSessionNavTest {
    @Test fun backFromAnEditLandsOnTheServicePage() {
        assertEquals(
            listOf("apps-list", "app-detail/alice--notes", "vibe-code-chat/s1"),
            openEditSessionStack(
                listOf("apps-list", "app-detail/alice--notes", "edit-service/alice--notes", "edit/describe/alice--notes"),
                "s1",
                "alice--notes",
            ),
        )
    }

    @Test fun anotherServicesPageIsNotTheOneKept() {
        assertEquals(
            listOf("apps-list", "app-detail/alice--notes", "vibe-code-chat/s2"),
            openEditSessionStack(
                listOf("apps-list", "app-detail/alice--notes", "edit-service/alice--notes", "app-detail/alice--wiki"),
                "s2",
                "alice--notes",
            ),
        )
        // Not under its page at all: the session is just pushed.
        assertEquals(
            listOf("apps-list", "vibe-code-chat/s3"),
            openEditSessionStack(listOf("apps-list"), "s3", "alice--notes"),
        )
    }
}
