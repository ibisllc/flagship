package com.flagshipserver.app.core

import com.flagshipserver.app.api.LocalAiGpu
import com.flagshipserver.app.api.LocalAiGpuHolder
import com.flagshipserver.app.api.LocalAiModelRow
import com.flagshipserver.app.api.LocalAiSpeed
import com.flagshipserver.app.api.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** "On this server" in the build model menu, and the Local AI screen's words. */
class LocalAiMenuTest {
    @Test fun theLocalGroupFollowsFlagshipInferenceAndSendsTheLocalCredential() {
        val keys = listOf(SavedAiKey("k1", "anthropic", "Work", "…1234"))
        val groups = ModelGroups.build(keys, flagshipUsable = true, currentProvider = null, includeLocal = true)
        assertEquals(listOf(ModelGroups.FLAGSHIP, ModelGroups.LOCAL, "k1"), groups.map { it.id })
        val local = groups[1]
        assertTrue(local.isLocal)
        assertEquals("flagship-local", local.provider)
        val c = ModelGroups.localCredential()
        assertEquals("flagship-local", c.provider)
        assertEquals("local", c.apiKey)
        assertEquals(false, c.relay)
        // A reopened chat on the box's model opens on this group, never on a saved key's.
        assertEquals(local, ModelGroups.forProvider(groups, "flagship-local"))
        assertEquals(local, ModelGroups.forCredential(groups, c))
        // Picking it sends its credential like any key; it is never swapped for another provider.
        assertEquals(MessageCredential.OWN_KEY, ModelGroups.messageCredential(local, picked = true, needsCredential = false))
    }

    @Test fun theLocalGroupIsOffByDefaultSoOtherMenusAreUnchanged() {
        assertTrue(ModelGroups.build(emptyList(), flagshipUsable = true, currentProvider = null).none { it.isLocal })
        // A chat already on it still shows it.
        assertTrue(ModelGroups.build(emptyList(), flagshipUsable = false, currentProvider = "flagship-local").any { it.isLocal })
        // And an unsaved "session key" group is never made for it.
        assertTrue(ModelGroups.build(emptyList(), true, "flagship-local", sessionKeyProvider = "flagship-local", includeLocal = true).none { it.id == ModelGroups.SESSION_KEY })
    }

    @Test fun theNoticeSaysWhenNothingIsDownloadedAndOtherwiseThePrivacyLine() {
        val g = ModelGroup(ModelGroups.LOCAL, "On this server", "flagship-local")
        val empty = ModelMenu.Own("flagship-local", listed = true, options = emptyList(), defaultModel = null, reason = null)
        assertEquals("No model is downloaded on this server yet. Download one under Local AI.", ModelGroups.localNotice(g, empty))
        val one = empty.copy(options = listOf(ModelOption("qwen2.5-0.5b-q4", "Qwen2.5 0.5B", tools = true, known = true)))
        assertEquals("Runs only on this server. Nothing is sent anywhere.", ModelGroups.localNotice(g, one))
        assertNull(ModelGroups.localNotice(ModelGroup("k1", "x", "openai"), one))
    }

    @Test fun theScreensWords() {
        val m = LocalAiModelRow("x", speed = LocalAiSpeed(4.25, measured = true, on = "gpu"))
        assertTrue(LocalAiCopy.speed(m).contains("measured"))
        assertTrue(LocalAiCopy.speed(m).contains("on the GPU"))
        assertEquals("On GPU 0, 1", LocalAiCopy.device("gpu", listOf("0", "1")))
        assertEquals("On the processor", LocalAiCopy.device("cpu", null))
        assertEquals("Number 2 in line", LocalAiCopy.queue(2))
        assertNull(LocalAiCopy.queue(null))
        assertEquals("Used by Local AI, Notes", LocalAiCopy.gpuHolders(LocalAiGpu("0", state = "in-use", holders = listOf(LocalAiGpuHolder("flagship-local-ai", "Local AI"), LocalAiGpuHolder("alice--notes", "Notes")))))
        assertEquals("Free: runs on this server", LocalAiCopy.COST)
    }
}
