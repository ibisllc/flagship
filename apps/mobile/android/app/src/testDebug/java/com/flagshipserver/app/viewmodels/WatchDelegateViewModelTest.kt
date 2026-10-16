// Phase Android-C — the "Quick approve from watch" toggle orchestration.
// All crypto + local-store side effects are injected so the test never
// touches the real Keystore; the Mock server captures the wire so we can
// assert the VM minted with the delegate key + the right scope/TTL.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.WatchDelegateMintRequest
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchDelegateViewModelTest {

    private val username = "dani"
    private fun irk() = Ed25519Sign(ByteArray(32) { 1 })
    private val delegateSeed = ByteArray(32) { 5 }
    private fun delegatePubHex() =
        HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(delegateSeed).publicKey)

    private class GrantBox { var value: String? = null }

    private fun mock(): MockFlagshipServerClient =
        MockFlagshipServerClient(simulatedLatencyMs = 0).apply { nowMs = { 1_000_000L } }

    private fun vm(server: MockFlagshipServerClient, box: GrantBox) = WatchDelegateViewModel(
        server = server,
        username = { username },
        signer = { irk() },
        provisionDelegatePubHex = { delegatePubHex() },
        loadGrantId = { box.value },
        saveGrantId = { box.value = it },
        now = { 1_000_000L },
        grantIdGen = { "grant-fixed-1" },
    )

    @Test
    fun enable_mintsDelegate_andPersistsGrantId() = runTest {
        val s = mock(); val box = GrantBox()
        val model = vm(s, box)
        model.enable()

        assertTrue(model.isEnabled.value)
        assertEquals("grant-fixed-1", box.value)
        assertEquals(1_000_000L + WatchDelegateViewModel.DEFAULT_TTL_MS, model.expiresAt.value)
        val stored = s.watchDelegatesByUser["dani"] ?: emptyList()
        assertEquals(1, stored.size)
        assertEquals(listOf("boot-approval"), stored[0].scopes)
        assertEquals(delegatePubHex(), stored[0].delegatePubKey)
    }

    @Test
    fun disable_revokes_andClearsLocal() = runTest {
        val s = mock(); val box = GrantBox()
        val model = vm(s, box)
        model.enable()
        assertTrue(model.isEnabled.value)

        model.disable()
        assertFalse(model.isEnabled.value)
        assertNull(box.value)
        assertEquals(0, s.listWatchDelegates("dani").delegates.size)
    }

    @Test
    fun load_reflectsActiveDelegate() = runTest {
        val s = mock(); val box = GrantBox()
        s.mintWatchDelegate("dani", WatchDelegateMintRequest(
            grant = WatchDelegateMintRequest.Grant(
                grantId = "seed", username = "dani", delegatePubKey = "aa".repeat(32),
                scopes = listOf("boot-approval"), issuedAt = 0, expiresAt = 9_000_000,
            ),
            signature = "bb".repeat(64),
        ))
        val model = vm(s, box)
        model.load()
        assertTrue(model.isEnabled.value)
        assertEquals(9_000_000L, model.expiresAt.value)
    }

    @Test
    fun load_emptyServer_isDisabled() = runTest {
        val s = mock(); val box = GrantBox()
        val model = vm(s, box)
        model.load()
        assertFalse(model.isEnabled.value)
    }

    @Test
    fun disable_withoutGrantId_isNoOp_butClearsLocal() = runTest {
        val s = mock(); val box = GrantBox()
        val model = vm(s, box)
        model.disable()
        assertFalse(model.isEnabled.value)
        assertNull(box.value)
    }
}
