// "Edit this service": mirrors iOS EditServiceTests.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.api.AppDetailResponse
import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.VibeCodeStartRequest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditServiceTest {
    @Test fun theBoxsRefusalsBecomeTheRightPrompt() {
        val open = ScreensError.Http(409, """{"ok":false,"kind":"session","sessionId":"s1","name":"notes","error":"x"}""")
        assertEquals(EditStartRefusal.SessionOpen, EditStartRefusal.from(open))
        assertEquals("Already being changed", EditStartRefusal.SessionOpen.title)
        assertEquals(
            "A build session is already changing notes. Open it from Build sessions, or discard it there to start over.",
            EditStartRefusal.SessionOpen.message("notes"),
        )

        val tooBig = "\"notes\" is too big to change in the AI chat. Connect your IDE to change it instead."
        val big = EditStartRefusal.from(ScreensError.Http(413, """{"error":"\"notes\" is too big to change in the AI chat. Connect your IDE to change it instead."}"""))
        assertEquals(EditStartRefusal.TooBig(tooBig), big)
        assertEquals("Too big for the AI chat", big.title)
        assertEquals(tooBig, big.message("notes"))
        assertTrue(EditStartRefusal.from(ScreensError.Http(413, "")) is EditStartRefusal.TooBig)

        val gone = EditStartRefusal.from(ScreensError.Http(404, """{"error":"That service isn't installed."}"""))
        assertEquals(EditStartRefusal.Other("That service isn't installed."), gone)
        assertEquals("Couldn't start", gone.title)

        // A 409 that isn't an open session reads as the box's own words.
        assertEquals(EditStartRefusal.Other("nope"), EditStartRefusal.from(ScreensError.Http(409, """{"error":"nope"}""")))
        // No body: still plain words, never empty.
        val offline = EditStartRefusal.from(java.io.IOException("reset"))
        assertTrue(offline is EditStartRefusal.Other && offline.message.isNotBlank())
    }

    @Test fun theCopyMatchesIOS() {
        assertEquals("notes", EditService.slug("alice--notes"))
        assertEquals("my-notes", EditService.slug("alice--my-notes"))
        assertEquals("Edit notes", EditService.title("notes"))
        assertEquals(
            "Your editor's agent changes notes on your server, starting from its current code, using your own AI subscription. Deploying from the IDE replaces the running version; its address and data stay the same.",
            EditService.ideIntro("notes"),
        )
        assertFalse(EditService.canStart("  ", false))
        assertFalse(EditService.canStart("Add a due date", true))
        assertTrue(EditService.canStart("Add a due date", false))
    }

    @Test fun appDetailSaysWhetherItCanBeEdited() {
        val json = Json { ignoreUnknownKeys = true }
        val body = """{"app":{"serviceId":"alice--notes","creator":"alice","slug":"notes","urlLabel":"notes","summary":"","url":"https://notes","status":"running","version":"0.1.0","installedAt":0},"manifest":{},"dataLayerInstances":[],"members":[],"browserTabs":[],"recentLogs":[],"editable":true}"""
        assertEquals(true, json.decodeFromString(AppDetailResponse.serializer(), body).editable)
        val old = body.replace(""","editable":true""", "")
        assertNull(json.decodeFromString(AppDetailResponse.serializer(), old).editable)
    }

    @Test fun anEditStartCarriesTheServiceAndANewBuildDoesNot() {
        val json = Json { encodeDefaults = true; explicitNulls = false }
        val edit = json.encodeToString(VibeCodeStartRequest.serializer(), VibeCodeStartRequest(prompt = "x", editServiceId = "alice--notes"))
        assertTrue(edit.contains(""""editServiceId":"alice--notes""""))
        val fresh = json.encodeToString(VibeCodeStartRequest.serializer(), VibeCodeStartRequest(prompt = "x", name = "notes"))
        assertFalse(fresh.contains("editServiceId"))
    }

    @Test fun theMockSaysWhichServicesAreEditable() = runTest {
        val client = MockScreensClient(simulatedLatencyMs = 0)
        client.editableServiceIds = setOf("bright-maple--wiki")
        assertEquals(true, client.appDetail("bright-maple--wiki").editable)
        assertEquals(false, client.appDetail("bright-maple--plants").editable)
    }
}
