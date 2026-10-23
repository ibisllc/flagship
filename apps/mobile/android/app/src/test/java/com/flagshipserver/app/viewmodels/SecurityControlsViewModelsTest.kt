package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.AppAccessOrders
import com.flagshipserver.app.core.CompanionDelegation
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.RestoredAccessDraft
import com.flagshipserver.app.core.SecurityControlWords
import com.flagshipserver.app.core.UpdateModeState
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecurityControlsViewModelsTest {
    private val seed = ByteArray(32) { 3 }
    private val signer: suspend (String) -> Ed25519Sign = { Ed25519Sign(seed) }
    private val pub = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey
    private val at = 1_760_000_000_000L

    @Test
    fun approvingRestoredPermissionsSignsThatAppAndThatDraft() = runBlocking {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val sha = "ab".repeat(32)
        mock.restoredDrafts += RestoredAccessDraft("alice--chess", sha, 2, "restricted", 1)
        mock.restoredDrafts += RestoredAccessDraft("alice--other", "cd".repeat(32), 1, "open", 1)
        val vm = RestoredAccessViewModel("alice--chess", mock, signer, { at })
        vm.load()
        assertEquals(2, vm.draft.value?.people)
        vm.approve()
        val sent = mock.restoredApprovals.single()
        assertEquals("alice--chess", sent.request.serviceRef)
        assertEquals(sha, sent.request.draftSha256)
        val bytes = AppAccessOrders.canonicalBytes(AppAccessOrders.RestoredApprove("alice--chess", sha, at))
        Ed25519Verify(pub).verify(HexUtil.decode(sent.signature)!!, bytes)
        assertNull(vm.draft.value)
        assertEquals(listOf("alice--other"), mock.restoredDrafts.map { it.serviceRef })
    }

    @Test
    fun discardingApprovesNothing() = runBlocking {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.restoredDrafts += RestoredAccessDraft("alice--chess", "ab".repeat(32), 1, "restricted", 1)
        val vm = RestoredAccessViewModel("alice--chess", mock, signer, { at })
        vm.load()
        vm.discard()
        assertEquals(listOf("alice--chess"), mock.restoredDiscards)
        assertTrue(mock.restoredApprovals.isEmpty())
        assertNull(vm.draft.value)
    }

    @Test
    fun updateModeIsReadAndChangedAndAnOlderBoxShowsNothing() = runBlocking {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.updateModes["alice--chess"] = UpdateModeState("manual", listOf("manual", "staged", "auto", "frozen"), 7)
        val vm = UpdateModeViewModel("alice--chess", mock)
        vm.load()
        assertEquals("manual", vm.state.value?.mode)
        vm.choose("staged")
        assertEquals("alice--chess" to "staged", mock.updateModeSets.single())
        assertEquals("staged", vm.state.value?.mode)
        val none = UpdateModeViewModel("nobody", mock)
        none.load()
        assertNull(none.state.value)
        assertEquals("Ask me each time", SecurityControlWords.updateLabel("manual"))
        assertNull(SecurityControlWords.updateLabel("weekly"))
    }

    @Test
    fun delegationSignsThisSessionAppOperationsAndWindowCappedAtADay() = runBlocking {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDelegationViewModel("0123456789abcdef", mock, signer, { at })
        vm.allow("alice--chess", listOf("deploy", "build"), 10L * 24 * 3_600_000)
        val sent = mock.delegationGrants.single()
        assertEquals(listOf("build", "deploy"), sent.delegation.ops)
        assertEquals(at + CompanionDelegation.MAX_MS, sent.delegation.expiresAt)
        val bytes = CompanionDelegation.canonicalBytes(CompanionDelegation.Order("0123456789abcdef", "alice--chess", listOf("build", "deploy"), at, at + CompanionDelegation.MAX_MS))
        Ed25519Verify(pub).verify(HexUtil.decode(sent.signature)!!, bytes)
        assertEquals(listOf("alice--chess"), vm.rows.value.map { it.serviceRef })
        vm.end("alice--chess")
        assertEquals("0123456789abcdef" to "alice--chess", mock.delegationEnds.single())
        assertTrue(vm.rows.value.isEmpty())
    }

    @Test
    fun aMalformedDelegationIsNeverSignedOrSent() = runBlocking {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        val vm = CompanionDelegationViewModel("short", mock, signer, { at })
        vm.allow("alice--chess", listOf("build"), 60_000)
        assertTrue(mock.delegationGrants.isEmpty())
        assertNotNull(vm.error.value)
    }
}
