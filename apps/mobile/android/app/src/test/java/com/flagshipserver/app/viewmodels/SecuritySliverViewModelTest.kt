package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockScreensClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.PublisherTrust
import com.flagshipserver.app.core.RecoveryVetoEcho
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

    /** F9: right after this phone rejects a recovery, the box's line reads as resolved until the box catches up,
     *  for at most RecoveryVetoEcho.HOLD_MS; a line raised after the veto, or the hold running out, shows again. */
    @Test
    fun aJustRejectedRecoveryReadsResolvedForABoundedTime() = runBlocking {
        val t0 = 1_760_000_000_000
        var clock = t0
        val mock = MockScreensClient(simulatedLatencyMs = 0)
        mock.sliver = SecuritySliverResponse(
            lines = listOf(
                SliverLine("r1", RecoveryVetoEcho.RECOVERY_ISSUE_KEY, "recovery-attempt", "critical", "alice", "active", "Someone is recovering this account", t0 - 60_000, 2 * 86_400_000L, "Refuse"),
                SliverLine("sv2", "ca", "ca-expiry", "moderate", "server", "active", "CA lease ends soon", 1, 86_400_000, null),
            ),
        )
        val vm = SecuritySliverViewModel(mock, signer = { Ed25519Sign(seed) }, now = { clock })
        try {
            vm.refresh()
            assertTrue(vm.lines.value.first().isActive)
            RecoveryVetoEcho.record(t0)
            vm.refresh()
            assertEquals(listOf("resolved", "active"), vm.lines.value.map { it.state })
            clock = t0 + RecoveryVetoEcho.HOLD_MS + 1
            vm.refresh()
            assertEquals(listOf("active", "active"), vm.lines.value.map { it.state })
            clock = t0 + 1_000
            mock.sliver = mock.sliver.copy(lines = listOf(mock.sliver.lines.first().copy(eventId = "r2", updatedAt = t0 + 500)))
            vm.refresh()
            assertTrue(vm.lines.value.single().isActive)
        } finally {
            RecoveryVetoEcho.clear()
        }
    }
}
