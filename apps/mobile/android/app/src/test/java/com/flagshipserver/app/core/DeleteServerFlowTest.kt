package com.flagshipserver.app.core

import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.api.MockFlagshipServerClient
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.ReleaseServerNameRequest
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeleteServerFlowTest {

    private val fqdn = "home2.harry.flagship.services"
    private val stk = "ab".repeat(32)
    private val now = 1_700_000_000_000L
    private val orderPair = Ed25519Sign.KeyPair.newKeyPair()
    private val irkPair = Ed25519Sign.KeyPair.newKeyPair()

    private fun pod(identity: String = stk) = PodInfo(
        podId = PodInfo.podId(fqdn), name = "Home 2", fqdn = fqdn,
        status = PodInfo.Status.OFFLINE, identityPubKeyHex = identity,
    )

    private suspend fun run(
        pod: PodInfo,
        server: FlagshipServerClient,
        mailbox: MockSecretMailboxClient,
        orderKeyCalls: MutableList<String> = mutableListOf(),
    ) = DeleteServerFlow.run(
        pod = pod,
        username = "harry",
        server = server,
        mailbox = mailbox,
        orderKey = { orderKeyCalls += it; Ed25519Sign(orderPair.privateKey) },
        mailboxKey = { Ed25519Sign(irkPair.privateKey) },
        mailboxPubHex = { HexUtil.encode(irkPair.publicKey) },
        now = { now },
    )

    @Test fun typedNameGate_matchesServerLabelTrimmedCaseInsensitive() {
        val p = pod()
        assertEquals("home2", p.serverLabel)
        assertTrue(DeleteServerFlow.confirmationMatches("home2", p))
        assertTrue(DeleteServerFlow.confirmationMatches("  HOME2 ", p))
        assertFalse(DeleteServerFlow.confirmationMatches("", p))
        assertFalse(DeleteServerFlow.confirmationMatches("Home 2", p))
        assertFalse(DeleteServerFlow.confirmationMatches(fqdn, p))
    }

    @Test fun registeredServer_depositsWipeNowThenReleases_oneKeyFetch() = runTest {
        val mailbox = MockSecretMailboxClient()
        val depositsAtRelease = mutableListOf<Int>()
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val server = object : FlagshipServerClient by mock {
            override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
                depositsAtRelease += mailbox.decommissionDeposits.size
                mock.releaseServerName(req)
            }
        }
        val keyCalls = mutableListOf<String>()

        val outcome = run(pod(), server, mailbox, keyCalls)

        assertEquals(DeleteServerFlow.Outcome.Deleted(erasureRequested = true), outcome)
        assertEquals(1, keyCalls.size)
        assertEquals(listOf(1), depositsAtRelease)

        val (domain, body) = mailbox.decommissionDeposits.single()
        assertEquals(fqdn, domain)
        assertEquals(fqdn, body.order.podCanonical)
        assertEquals(stk, body.order.retiredStkPubHex)
        assertFalse(body.order.finalBackup)
        assertEquals("wipe-now", body.order.diskDisposition)
        assertEquals(0L, body.order.backupEpoch)
        assertEquals(64, body.order.nonce.length)
        assertEquals(now, body.order.issuedAt)
        Ed25519Verify(orderPair.publicKey).verify(
            HexUtil.decode(body.signature)!!,
            ServerDecommissionOrder.canonicalBytes(
                fqdn, stk, false, "wipe-now", 0L, body.order.nonce, now,
            ),
        )

        val release = mock.releasedServerNames.single()
        assertEquals(ReleaseServerNameRequest.Inner("harry", fqdn, now), release.request)
        Ed25519Verify(orderPair.publicKey).verify(
            HexUtil.decode(release.signature)!!,
            ReleaseServerName.canonicalBytes("harry", fqdn, now),
        )
    }

    @Test fun depositFailure_stillReleases_andSaysSo() = runTest {
        val mailbox = MockSecretMailboxClient().apply { nextDecommissionError = HttpException(503, "down") }
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)

        val outcome = run(pod(), mock, mailbox)

        assertEquals(DeleteServerFlow.Outcome.Deleted(erasureRequested = false), outcome)
        assertEquals(1, mock.releasedServerNames.size)
        assertEquals(
            "Deleted Home 2. It couldn't be asked to erase itself.",
            DeleteServerFlow.deletedMessage("Home 2", erasureRequested = false),
        )
        assertEquals(
            "Deleted Home 2. If it's online it will erase itself and power off.",
            DeleteServerFlow.deletedMessage("Home 2", erasureRequested = true),
        )
    }

    @Test fun neverRegistered_skipsTheDeposit() = runTest {
        val mailbox = MockSecretMailboxClient()
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)

        val outcome = run(pod(identity = ""), mock, mailbox)

        assertEquals(DeleteServerFlow.Outcome.Deleted(erasureRequested = false), outcome)
        assertTrue(mailbox.decommissionDeposits.isEmpty())
        assertEquals(1, mock.releasedServerNames.size)
    }

    @Test fun releaseFailure_aborts() = runTest {
        val mailbox = MockSecretMailboxClient()
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)
        val server = object : FlagshipServerClient by mock {
            override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
                throw HttpException(500, "boom")
            }
        }

        val outcome = run(pod(), server, mailbox)

        assertTrue(outcome is DeleteServerFlow.Outcome.Failed)
        assertTrue((outcome as DeleteServerFlow.Outcome.Failed).message.contains("still reserved"))
    }

    @Test fun keyFailure_touchesNothing() = runTest {
        val mailbox = MockSecretMailboxClient()
        val mock = MockFlagshipServerClient(simulatedLatencyMs = 0)

        val outcome = DeleteServerFlow.run(
            pod = pod(), username = "harry", server = mock, mailbox = mailbox,
            orderKey = { throw IllegalStateException("cancelled") },
            mailboxKey = { Ed25519Sign(irkPair.privateKey) },
            mailboxPubHex = { HexUtil.encode(irkPair.publicKey) },
        )

        assertTrue(outcome is DeleteServerFlow.Outcome.Failed)
        assertTrue(mailbox.decommissionDeposits.isEmpty())
        assertTrue(mock.releasedServerNames.isEmpty())
    }
}
