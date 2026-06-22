// Transfer-a-box VM logic (Layer C, Android). Drives the giver + acquirer VMs
// against MockServerTransferClient + MockSecretMailboxClient, asserting the
// signed wire bodies the broker accepts + the phase machine. JVM-testable
// (injected signer/pub/seed — no Android keystore/biometric).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.MockServerTransferClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.SecretSeal
import com.flagshipserver.app.core.ServerTransferClaimOrder
import com.flagshipserver.app.core.ServerTransferFlow
import com.flagshipserver.app.core.ServerTransferOfferOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TransferViewModelTest {
    private val host = "home.alice.flagship.services"
    private val giver = Ed25519Sign.KeyPair.newKeyPair()
    private val acquirer = Ed25519Sign.KeyPair.newKeyPair()

    private fun signer(kp: Ed25519Sign.KeyPair): suspend (String) -> Ed25519Sign = { Ed25519Sign(kp.privateKey) }
    private fun pub(kp: Ed25519Sign.KeyPair): suspend () -> String = { HexUtil.encode(kp.publicKey) }

    @Test
    fun giverStartSignsOffersAndExposesQR() = runTest {
        val client = MockServerTransferClient()
        val vm = TransferGiverViewModel(
            serverDomain = host, username = "alice", client = client, mailbox = MockSecretMailboxClient(),
            signer = signer(giver), irkPubHex = pub(giver), irkSeed = { giver.privateKey }, now = { 1700 },
        )
        vm.start()
        assertEquals(TransferGiverPhase.AwaitingClaim, vm.phase.value)
        assertNotNull(vm.qrText)
        assertEquals(1, client.offers.size)
        val body = client.offers[0].second
        Ed25519Verify(giver.publicKey).verify(
            HexUtil.decode(body.offerSignature)!!,
            ServerTransferOfferOrder.canonicalBytes(host, body.offer.transferNonce, body.offer.issuedAt, body.offer.expiresAt),
        )
        // QR parses back.
        val qr = ServerTransferFlow.parseQR(vm.qrText!!)
        assertEquals(host, qr.serverDomain)
    }

    @Test
    fun giverPollResealsDiskKeyOnClaim() = runTest {
        // The box's disk key, sealed FOR the giver IRK at install.
        val diskKey = ByteArray(32) { 0x42 }
        val sealedForGiver = SecretSeal.sealForEd25519Recipient(diskKey, giver.publicKey)
        val client = MockServerTransferClient().apply {
            scriptedPoll = com.flagshipserver.app.api.TransferClaimPoll(
                newServerDomain = "home.bob.flagship.services",
                acquirerUsername = "bob",
                acquirerIrkPub = HexUtil.encode(acquirer.publicKey),
            )
        }
        val mailbox = MockSecretMailboxClient().apply {
            sealedLuksKeyHex = HexUtil.encode(sealedForGiver)
        }
        val vm = TransferGiverViewModel(
            serverDomain = host, username = "alice", client = client, mailbox = mailbox,
            signer = signer(giver), irkPubHex = pub(giver), irkSeed = { giver.privateKey }, now = { 1700 },
        )
        vm.start()
        val done = vm.pollOnce()
        assertTrue(done)
        assertEquals(TransferGiverPhase.Completed("home.bob.flagship.services"), vm.phase.value)
        assertEquals(1, client.diskKeyDeposits.size)
        // The deposited blob opens with the ACQUIRER IRK seed and yields the disk key.
        val opened = ServerTransferFlow.openDiskKey(client.diskKeyDeposits[0].second.sealedDiskKey, acquirer.privateKey)
        assertArrayEquals(diskKey, opened)
    }

    @Test
    fun acquirerIngestThenClaimSignsUnderAcquirerIrk() = runTest {
        val built = ServerTransferFlow.buildOffer(
            serverDomain = host, username = "alice", irk = Ed25519Sign(giver.privateKey),
            irkPubHex = HexUtil.encode(giver.publicKey), issuedAt = 1, ttlMs = 9_999_999_999_999,
            nonce = ByteArray(32) { 0xab.toByte() }, authNonce = ByteArray(32) { 1 },
        )
        val qrText = ServerTransferFlow.encodeQR(built.qr)
        val client = MockServerTransferClient()
        val vm = TransferAcquirerViewModel(
            username = "Bob", client = client, signer = signer(acquirer), irkPubHex = pub(acquirer), now = { 1800 },
        )
        assertTrue(vm.ingest(qrText))
        vm.confirm()
        assertEquals(TransferAcquirerPhase.Claimed(host), vm.phase.value)
        assertEquals(1, client.claims.size)
        val body = client.claims[0].second
        assertEquals("bob", body.claim.acquirerUsername)
        Ed25519Verify(acquirer.publicKey).verify(
            HexUtil.decode(body.claimSignature)!!,
            ServerTransferClaimOrder.canonicalBytes(host, body.claim.transferNonce, "bob", body.claim.acquirerIrkPub, 1800),
        )
    }

    @Test
    fun acquirerRejectsNonTransferQR() {
        val vm = TransferAcquirerViewModel(username = "bob", client = MockServerTransferClient())
        assertFalse(vm.ingest("garbage"))
        assertTrue(vm.phase.value is TransferAcquirerPhase.Failed)
    }
}
