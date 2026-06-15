// AiKeysViewModel — drives the build-flow key step + Settings AI-keys manager.
// Verifies add/list/delete reflect through state, recall returns the full
// credential, save-vs-in-memory behavior, and that exposed rows carry masked
// slugs only.

package com.flagshipserver.app.viewmodels

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.core.AiKeyStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AiKeysViewModelTest {

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        AiKeyStore.attachForTest(ctx.getSharedPreferences("ai-keys-vm-test", Context.MODE_PRIVATE))
        AiKeyStore.clear()
    }

    @After
    fun tearDown() {
        AiKeyStore.clear()
    }

    @Test
    fun startsEmpty() {
        val vm = AiKeysViewModel()
        assertTrue(vm.keys.value.isEmpty())
        assertNull(vm.activeId.value)
    }

    @Test
    fun addReflectsInStateAsMaskedRows() {
        val vm = AiKeysViewModel()
        assertTrue(vm.add("anthropic", "sk-ant-abc123456789", "Personal", null))
        val rows = vm.keys.value
        assertEquals(1, rows.size)
        assertEquals("anthropic · Personal · sk-…6789", rows.first().maskedSlug)
        // The masked row never carries the full key.
        assertFalse(rows.first().maskedSlug.contains("abc123"))
        assertEquals(rows.first().id, vm.activeId.value)
    }

    @Test
    fun deleteRemovesRow() {
        val vm = AiKeysViewModel()
        vm.add("openai", "sk-openai-987654321", "Work", null)
        val id = vm.keys.value.first().id
        vm.delete(id)
        assertTrue(vm.keys.value.isEmpty())
        assertNull(vm.activeId.value)
    }

    @Test
    fun credentialForReturnsFullKey() {
        val vm = AiKeysViewModel()
        vm.add("google", "AIza-secret-123456789", "Gemini", "https://g")
        val id = vm.keys.value.first().id
        val cred = vm.credentialFor(id)!!
        assertEquals("google", cred.provider)
        assertEquals("AIza-secret-123456789", cred.apiKey)
        assertEquals("https://g", cred.baseUrl)
    }

    @Test
    fun useEnteredKeySavesWhenAsked() {
        val vm = AiKeysViewModel()
        val cred = vm.useEnteredKey("anthropic", "sk-ant-save-12345678", "Saved", null, save = true)
        assertNotNull(cred)
        assertEquals("sk-ant-save-12345678", cred!!.apiKey)
        // Persisted — shows up in the list.
        assertEquals(1, vm.keys.value.size)
    }

    @Test
    fun useEnteredKeyDoesNotPersistWhenSaveFalse() {
        val vm = AiKeysViewModel()
        val cred = vm.useEnteredKey("openai", "sk-openai-ephemeral-1", "Temp", null, save = false)
        assertNotNull(cred)
        assertEquals("sk-openai-ephemeral-1", cred!!.apiKey)
        // NOT persisted — list stays empty.
        assertTrue(vm.keys.value.isEmpty())
    }

    @Test
    fun useEnteredKeyRejectsBlank() {
        val vm = AiKeysViewModel()
        assertNull(vm.useEnteredKey("anthropic", "   ", "L", null, save = true))
        assertNull(vm.useEnteredKey("", "sk-abc12345", "L", null, save = true))
        assertTrue(vm.keys.value.isEmpty())
    }

    @Test
    fun pendingBuildCredentialIsOneShot() {
        val c = com.flagshipserver.app.core.AiCredential("anthropic", "sk-1", null)
        PendingBuildCredential.set(c)
        assertEquals("sk-1", PendingBuildCredential.peek()?.apiKey)
        assertEquals("sk-1", PendingBuildCredential.take()?.apiKey)
        // Taken once, then gone.
        assertNull(PendingBuildCredential.take())
    }
}
