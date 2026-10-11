// Unique build names on the describe form: mirrors iOS VibeCodeNameTests.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.api.BuildDeployResponse
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.VibeCodeNameCheck
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VibeCodeDescribeTest {
    @Test fun aStartRefusedForATakenNameIsReadAsAConflict() {
        val body = """{"ok":false,"kind":"session","sessionId":"abcd","message":"A build session already uses the name \"garden\".","error":"x"}"""
        val c = VibeCodeNameCheck.conflict(ScreensError.Http(409, body))
        assertEquals("session", c?.kind)
        assertEquals("abcd", c?.sessionId)
        assertNull(VibeCodeNameCheck.conflict(ScreensError.Http(502, body)))
        assertNull(VibeCodeNameCheck.conflict(ScreensError.Http(409, "not json")))
        assertNull(VibeCodeNameCheck.conflict(ScreensError.Http(409, """{"ok":true,"name":"x"}""")))
        assertNull(VibeCodeNameCheck.conflict(IllegalStateException("x")))
    }

    @Test fun theWarningSendsSessionClashesToTheListAndAppClashesToAnotherName() {
        val session = VibeCodeNameCheck(ok = false, name = "garden", kind = "session", sessionId = "abcd")
        assertEquals(
            "A build session already uses \"garden\". To use the name for a new build, open Build sessions and discard that one first.",
            VibeCodeDescribe.conflictMessage(session, "garden"),
        )
        val app = VibeCodeNameCheck(ok = false, kind = "app", serviceId = "alice--notes")
        assertEquals(
            "You already have a service called \"notes\". Pick another name.",
            VibeCodeDescribe.conflictMessage(app, "notes"),
        )
        val invalid = VibeCodeNameCheck(ok = false, kind = "invalid", message = "Use lowercase letters.")
        assertEquals("Use lowercase letters.", VibeCodeDescribe.warning(invalid, "-x"))
        assertNull(VibeCodeDescribe.warning(VibeCodeNameCheck(ok = true, name = "x"), "x"))
        assertNull(VibeCodeDescribe.warning(null, "x"))
    }

    @Test fun buildNeedsANameADescriptionAndAValidName() {
        assertFalse(VibeCodeDescribe.canBuild("", "a thing", null, false))
        assertFalse(VibeCodeDescribe.canBuild("garden", "  ", null, false))
        assertFalse(VibeCodeDescribe.canBuild("garden", "a thing", VibeCodeNameCheck(ok = false, kind = "invalid"), false))
        assertFalse(VibeCodeDescribe.canBuild("garden", "a thing", null, true))
        assertTrue(VibeCodeDescribe.canBuild("garden", "a thing", null, false))
        // A taken name still lets Build be tapped: the tap shows the pop-up.
        assertTrue(VibeCodeDescribe.canBuild("garden", "a thing", VibeCodeNameCheck(ok = false, kind = "app"), false))
    }

    @Test fun theSlugKeepsOnlyAddressCharacters() {
        assertEquals("my-plants2", VibeCodeDescribe.slug("My Plants2!".replace(" ", "-")))
        assertEquals("garden", VibeCodeDescribe.slug("Garden"))
    }

    @Test fun accessDefaultsToInviteOnlyAndExplainsItself() {
        assertEquals("just-me", VibeCodeDescribe.INVITE_ONLY)
        assertEquals(listOf("Invite only", "Anyone with the link"), VibeCodeDescribe.visibilities.map { it.second })
        assertEquals("Only you and the people you invite on Flagship can open it.", VibeCodeDescribe.explanation("just-me"))
        assertEquals(
            "Anyone with the address can open it. Where it needs to know who someone is, they sign in with Flagship.",
            VibeCodeDescribe.explanation("link"),
        )
        assertEquals("Habit tracker", VibeCodeDescribe.examples.first().first)
    }

    @Test fun deploysDecodeWhetherTheBoxMadeItInviteOnly() {
        val json = Json { ignoreUnknownKeys = true }
        assertNull(json.decodeFromString(BuildDeployResponse.serializer(), """{"ok":true,"serviceId":"a--x","url":"https://x"}""").inviteOnly)
        assertEquals(false, json.decodeFromString(BuildDeployResponse.serializer(), """{"ok":true,"serviceId":"a--x","url":"https://x","inviteOnly":false}""").inviteOnly)
    }

    @Test fun theKeyStepCopyMatchesIos() {
        assertEquals("AI Key", AiKeyStep.TITLE)
        assertEquals("The keys are stored safely in your mobile app and your own servers.", AiKeyStep.SECURITY_NOTE)
        assertEquals(
            "Work will be removed from this phone. Builds that are already running keep working.",
            AiKeyStep.deleteMessage("Work"),
        )
    }

    @Test fun savedKeysListTheLastUsedFirst() {
        val rows = listOf("a", "b", "c").map {
            com.flagshipserver.app.viewmodels.SavedKeyRow(id = it, provider = "openai", label = it, maskedSlug = it)
        }
        assertEquals(listOf("b", "a", "c"), com.flagshipserver.app.viewmodels.AiKeysViewModel.ordered(rows, "b").map { it.id })
        assertEquals(listOf("a", "b", "c"), com.flagshipserver.app.viewmodels.AiKeysViewModel.ordered(rows, null).map { it.id })
        assertEquals(listOf("a", "b", "c"), com.flagshipserver.app.viewmodels.AiKeysViewModel.ordered(rows, "gone").map { it.id })
    }
}
