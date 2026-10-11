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
}
