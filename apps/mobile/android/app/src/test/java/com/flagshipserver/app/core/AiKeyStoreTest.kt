// AiKeyStore — device-local saved AI-provider keys. Mirrors the webapp
// providers.js multi-key store. Robolectric runs SharedPreferences in-memory
// so the add/list/delete/persist + masking paths are exercised.

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AiKeyStoreTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        AiKeyStore.attachForTest(ctx.getSharedPreferences("ai-keys-test", Context.MODE_PRIVATE))
        AiKeyStore.clear()
    }

    @After
    fun tearDown() {
        AiKeyStore.clear()
    }

    @Test
    fun emptyByDefault() {
        assertTrue(AiKeyStore.list().isEmpty())
        assertNull(AiKeyStore.active())
        assertNull(AiKeyStore.activeId())
    }

    @Test
    fun setActiveOverridesTheLastAddedDefault() {
        val a = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "Personal")
        val b = AiKeyStore.add("openai", "sk-openai-xyz987654321", "Work")
        // Most-recently-added is the implicit default.
        assertEquals(b.id, AiKeyStore.activeId())
        // An explicit "make default" pick wins.
        AiKeyStore.setActive(a.id)
        assertEquals(a.id, AiKeyStore.activeId())
        assertEquals(a.id, AiKeyStore.active()?.id)
    }

    @Test
    fun deletingTheActiveEntryFallsBackToLastAdded() {
        val a = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "Personal")
        val b = AiKeyStore.add("openai", "sk-openai-xyz987654321", "Work")
        AiKeyStore.setActive(a.id)
        assertEquals(a.id, AiKeyStore.activeId())
        // Removing the pinned-active entry drops the dangling pointer; the
        // default reverts to the most-recently-added survivor.
        AiKeyStore.delete(a.id)
        assertEquals(b.id, AiKeyStore.activeId())
    }

    @Test
    fun setActiveIgnoresUnknownId() {
        val a = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "Personal")
        AiKeyStore.setActive("not-a-real-id")
        // A stale tap can't orphan the pointer — active stays the real entry.
        assertEquals(a.id, AiKeyStore.activeId())
    }

    @Test
    fun addListGetDelete() {
        val a = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "Personal")
        assertEquals(1, AiKeyStore.list().size)
        assertEquals("anthropic", a.provider)
        assertEquals("Personal", a.label)

        val b = AiKeyStore.add("openai", "sk-openai-xyz987654321", "Work", "https://proxy.example.com/v1")
        assertEquals(2, AiKeyStore.list().size)
        assertEquals("https://proxy.example.com/v1", AiKeyStore.get(b.id)?.baseUrl)

        // Most-recently-added is active.
        assertEquals(b.id, AiKeyStore.active()?.id)

        AiKeyStore.delete(a.id)
        assertEquals(1, AiKeyStore.list().size)
        assertNull(AiKeyStore.get(a.id))
        assertEquals(b.id, AiKeyStore.list().first().id)
    }

    @Test
    fun persistsAcrossInstances() {
        val a = AiKeyStore.add("google", "AIzaSyAbCdEf123456789", "Gemini")
        // A fresh read (same backing prefs) sees the persisted entry.
        val reread = AiKeyStore.list()
        assertEquals(1, reread.size)
        assertEquals(a.id, reread.first().id)
        assertEquals("AIzaSyAbCdEf123456789", reread.first().apiKey)
    }

    @Test
    fun credentialForReturnsFullKey() {
        val a = AiKeyStore.add("anthropic", "sk-ant-secret-value-12345", "P", "https://x")
        val cred = AiKeyStore.credentialFor(a.id)!!
        assertEquals("anthropic", cred.provider)
        assertEquals("sk-ant-secret-value-12345", cred.apiKey)
        assertEquals("https://x", cred.baseUrl)
        assertNull(AiKeyStore.credentialFor("nope"))
    }

    @Test
    fun blankLabelFallsBackToProvider() {
        val a = AiKeyStore.add("openrouter", "sk-or-12345678", "   ")
        assertEquals("openrouter", a.label)
    }

    @Test
    fun blankBaseUrlNormalizesToNull() {
        val a = AiKeyStore.add("ollama", "local-key-12345678", "Local", "  ")
        assertNull(a.baseUrl)
    }

    @Test
    fun rejectsBlankProviderOrKey() {
        var threw = false
        try { AiKeyStore.add("", "sk-abc12345", "L") } catch (_: IllegalArgumentException) { threw = true }
        assertTrue(threw)
        threw = false
        try { AiKeyStore.add("anthropic", "  ", "L") } catch (_: IllegalArgumentException) { threw = true }
        assertTrue(threw)
    }

    @Test
    fun maskingNeverLeaksMiddle() {
        // last-4 + 3-char prefix only.
        assertEquals("sk-…6789", AiKeyStore.maskKey("sk-ant-abc123456789"))
        // short keys fully masked.
        assertEquals("…", AiKeyStore.maskKey("short"))
        assertEquals("—", AiKeyStore.maskKey(""))
    }

    @Test
    fun maskedSlugFormat() {
        val a = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "Personal")
        val slug = AiKeyStore.maskedSlug(a)
        assertEquals("anthropic · Personal · sk-…6789", slug)
        // The full key is never in the slug.
        assertFalse(slug.contains("abc123"))
    }

    @Test
    fun clearEmptiesEverything() {
        AiKeyStore.add("anthropic", "sk-ant-abc123456789", "A")
        AiKeyStore.add("openai", "sk-openai-987654321", "B")
        AiKeyStore.clear()
        assertTrue(AiKeyStore.list().isEmpty())
    }
}
