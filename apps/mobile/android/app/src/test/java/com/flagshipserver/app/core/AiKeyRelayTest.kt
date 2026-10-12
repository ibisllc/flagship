// The per-key Flagship relay setting: on by default for new keys AND for keys
// saved before the setting existed, editable later, carried on every
// credential handed to a build, and the relay-failure detection behind
// "Turn the relay off for this key".

package com.flagshipserver.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.flagshipserver.app.viewmodels.AiKeysViewModel
import com.flagshipserver.app.viewmodels.PendingBuildCredential
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
class AiKeyRelayTest {

    private lateinit var prefs: android.content.SharedPreferences

    @Before
    fun setUp() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        prefs = ctx.getSharedPreferences("ai-keys-relay-test", Context.MODE_PRIVATE)
        AiKeyStore.attachForTest(prefs)
        AiKeyStore.clear()
        AiRelay.lastUsedKeyId = null
    }

    @After
    fun tearDown() {
        AiKeyStore.clear()
        AiRelay.lastUsedKeyId = null
        PendingBuildCredential.take()
    }

    @Test
    fun aKeySavedBeforeTheSettingExistedUsesTheRelay() {
        prefs.edit().putString(
            "entries",
            """[{"id":"old1","provider":"anthropic","label":"Old","apiKey":"sk-ant-old-1234567890"}]""",
        ).commit()
        val old = AiKeyStore.get("old1")!!
        assertTrue(old.relay)
        assertEquals(true, AiKeyStore.credentialFor("old1")?.relay)
        assertTrue(AiKeysViewModel().keys.value.single().relay)
    }

    @Test
    fun newKeysUseTheRelayUnlessTurnedOff() {
        val on = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "On")
        val off = AiKeyStore.add("openai", "sk-openai-xyz987654321", "Off", relay = false)
        assertTrue(on.relay)
        assertFalse(off.relay)
        assertFalse(AiKeyStore.get(off.id)!!.relay)
    }

    @Test
    fun theSettingIsEditableLaterAndPersists() {
        val vm = AiKeysViewModel()
        assertTrue(vm.add("anthropic", "sk-ant-abc123456789", "Personal", null))
        val id = vm.keys.value.single().id
        vm.setRelay(id, false)
        assertFalse(vm.keys.value.single().relay)
        assertFalse(AiKeyStore.list().single().relay)
        assertEquals(false, AiKeyStore.credentialFor(id)?.relay)
        vm.setRelay(id, true)
        assertTrue(AiKeyStore.list().single().relay)
        AiKeyStore.setRelay("missing", false)
        assertEquals(1, AiKeyStore.list().size)
    }

    @Test
    fun theFormsChoiceTravelsWithTheKey() {
        val vm = AiKeysViewModel()
        assertTrue(vm.addAndSelect("google", "AIzaSyAbCdEf123456789", "G", null, relay = false))
        val id = vm.activeId.value!!
        val cred = vm.choose(id)!!
        assertFalse(cred.relay)
        assertEquals(id, cred.keyId)

        val unsaved = vm.useEnteredKey("openai", "sk-openai-ephemeral-1", "T", null, save = false, relay = false)!!
        assertFalse(unsaved.relay)
        assertNull(unsaved.keyId)
    }

    @Test
    fun rowCaptions() {
        assertEquals("Through the Flagship relay", AiRelay.caption(true))
        assertEquals("Direct", AiRelay.caption(false))
        assertEquals("Send through the Flagship relay", AiRelay.TOGGLE_LABEL)
        assertEquals(
            "Better for your anonymity: the AI provider sees Flagship's address, not yours.",
            AiRelay.TOGGLE_NOTE,
        )
    }

    @Test
    fun relayFailuresAreRecognised() {
        assertTrue(AiRelay.isRelayFailure("the Flagship relay isn't reachable, so the AI call wasn't sent"))
        assertTrue(
            AiRelay.isRelayFailure(
                "adapt model call failed: the Flagship relay didn't connect to api.anthropic.com because it timed out, so the AI call wasn't sent",
            ),
        )
        assertTrue(AiRelay.isRelayFailure("relay-unavailable"))
        assertFalse(AiRelay.isRelayFailure("provider-error: 401 invalid x-api-key"))
        assertFalse(AiRelay.isRelayFailure(null))
    }

    @Test
    fun theActionTargetsTheKeyLastHandedToABuild() {
        val saved = AiKeyStore.add("anthropic", "sk-ant-abc123456789", "P")
        val msg = "the Flagship relay isn't reachable, so the AI call wasn't sent"
        assertNull(AiRelay.keyToTurnOff(msg))

        PendingBuildCredential.set(AiKeyStore.credentialFor(saved.id))
        assertEquals(saved.id, AiRelay.keyToTurnOff(msg))
        assertNull(AiRelay.keyToTurnOff("some other failure"))

        AiKeyStore.setRelay(saved.id, false)
        assertNull(AiRelay.keyToTurnOff(msg))

        // An unsaved key has nothing to switch.
        PendingBuildCredential.set(AiCredential("openai", "sk-1", relay = true))
        assertNull(AiRelay.keyToTurnOff(msg))
    }
}
