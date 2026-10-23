package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PublisherTrust
import com.flagshipserver.app.core.SecuritySliverResponse
import com.flagshipserver.app.core.SliverLine
import com.flagshipserver.app.core.WaitingPublisherResponse
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SecuritySliverViewModelTest {
    private val seed = ByteArray(32) { 9 }
    private val trust = PublisherTrust("chess", "alice--chess", 1, "a".repeat(64), "b".repeat(64), 1, 0)

    private fun world(): Pair<MockScreensClient, SecuritySliverViewModel> {
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.sliver = SecuritySliverResponse(
            lines = listOf(
                SliverLine("sv1", "publisher-key:chess", "publisher-key", "high", "chess", "active", "A new key signed an update", 1, null, "Review"),
                SliverLine("sv2", "ca", "ca-expiry", "moderate", "server", "active", "CA lease ends soon", 1, 86_400_000, null),
            ),
        )
        mock.publisherStates["chess"] = WaitingPublisherResponse(waiting = WaitingPublisherResponse.Waiting("none", "aaaa", "bbbb", 1, false, trust))
        return mock to SecuritySliverViewModel(mock, signer = { Ed25519Sign(seed) }, now = { 1_760_000_000_000 })
    }

    @Test
    fun keepsEveryLineAndLoadsAWaitingCardOnlyForAPublisherKey() = runBlocking {
        val (_, vm) = world()
        vm.refresh()
        assertEquals(listOf("publisher-key:chess", "ca"), vm.lines.value.map { it.issueKey })
        assertEquals(setOf("chess"), vm.waiting.value.keys)
    }

    @Test
    fun trustingSignsExactlyThatServiceAndChange() = runBlocking {
        val (mock, vm) = world()
        vm.refresh()
        vm.trust("chess")
        val (service, sent, sigHex) = mock.trustCalls.single()
        assertEquals("chess", service)
        assertEquals(trust.oldKeyHex, sent.oldKeyHex)
        assertEquals(trust.newKeyHex, sent.newKeyHex)
        assertEquals(1_760_000_000_000, sent.issuedAt)
        Ed25519Verify(Ed25519Sign.KeyPair.newKeyPairFromSeed(seed).publicKey).verify(HexUtil.decode(sigHex)!!, sent.canonicalBytes())
        assertEquals(null, vm.error.value)
    }

    @Test
    fun rejectingPausesAndTrustingNothingWaitingSaysSo() = runBlocking {
        val (mock, vm) = world()
        vm.refresh()
        vm.reject("chess")
        assertEquals(listOf("chess"), mock.rejectCalls)
        vm.trust("not-waiting")
        assertEquals("No new key is waiting for this service.", vm.error.value)
        assertTrue(mock.trustCalls.isEmpty())
    }
}
