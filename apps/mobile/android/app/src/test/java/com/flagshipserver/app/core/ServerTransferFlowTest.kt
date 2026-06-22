package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockServerTransferClient
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Exercises the pure transfer-a-box flow builders (Layer C). The giver builds +
 * signs the offer + QR; the acquirer parses the QR + signs the claim; the giver
 * re-seals the disk key to the acquirer IRK + the acquirer opens it. Plus the
 * Mock client wire shape. JVM-testable (no Compose/Android runtime).
 */
class ServerTransferFlowTest {
    private val host = "home.alice.flagship.services"

    private fun keypair(): Ed25519Sign.KeyPair = Ed25519Sign.KeyPair.newKeyPair()

    @Test
    fun buildOfferSignsUnderGiverIrkAndEncodesQR() {
        val kp = keypair()
        val signer = Ed25519Sign(kp.privateKey)
        val pubHex = HexUtil.encode(kp.publicKey)
        val built = ServerTransferFlow.buildOffer(
            serverDomain = host, username = "alice", irk = signer, irkPubHex = pubHex,
            issuedAt = 1700, ttlMs = 900_000,
            nonce = ByteArray(32) { 0xab.toByte() }, authNonce = ByteArray(32) { 1 },
        )
        // The offer signature verifies under the giver IRK over the canonical bytes.
        val verifier = Ed25519Verify(kp.publicKey)
        verifier.verify(
            HexUtil.decode(built.body.offerSignature)!!,
            ServerTransferOfferOrder.canonicalBytes(host, built.body.offer.transferNonce, 1700, 1700 + 900_000),
        )
        assertEquals(pubHex, built.body.auth.phoneIrkPub)
        assertEquals("flagship-transfer-offer", built.qr.kind)
        // The QR round-trips through encode/parse.
        val reparsed = ServerTransferFlow.parseQR(ServerTransferFlow.encodeQR(built.qr))
        assertEquals(built.qr.serverDomain, reparsed.serverDomain)
        assertEquals(built.qr.transferNonce, reparsed.transferNonce)
    }

    @Test
    fun parseQRRejectsNonTransfer() {
        try { ServerTransferFlow.parseQR("{}"); fail() } catch (_: ServerTransferFlow.TransferException) {}
        try { ServerTransferFlow.parseQR("garbage"); fail() } catch (_: ServerTransferFlow.TransferException) {}
    }

    @Test
    fun buildClaimSignsUnderAcquirerIrk() {
        val acq = keypair()
        val signer = Ed25519Sign(acq.privateKey)
        val pubHex = HexUtil.encode(acq.publicKey)
        val qr = ServerTransferFlow.OfferQR(
            serverDomain = host, transferNonce = "cd".repeat(32), giverIrkPub = "00".repeat(32),
            issuedAt = 1, expiresAt = 9_999_999_999_999, offerSignature = "00".repeat(64),
        )
        val body = ServerTransferFlow.buildClaim(qr, "Bob", signer, pubHex, 1800)
        assertEquals("bob", body.claim.acquirerUsername)
        Ed25519Verify(acq.publicKey).verify(
            HexUtil.decode(body.claimSignature)!!,
            ServerTransferClaimOrder.canonicalBytes(host, qr.transferNonce, "bob", body.claim.acquirerIrkPub, 1800),
        )
    }

    @Test
    fun buildClaimRejectsExpiredOffer() {
        val acq = keypair()
        val qr = ServerTransferFlow.OfferQR(
            serverDomain = host, transferNonce = "cd".repeat(32), giverIrkPub = "00",
            issuedAt = 1, expiresAt = 5, offerSignature = "00",
        )
        try {
            ServerTransferFlow.buildClaim(qr, "bob", Ed25519Sign(acq.privateKey), HexUtil.encode(acq.publicKey), 1000)
            fail()
        } catch (e: ServerTransferFlow.TransferException) {
            assertEquals("expired", e.message)
        }
    }

    @Test
    fun diskKeyReSealRoundTripsToAcquirer() {
        val giver = keypair()
        val acquirer = keypair()
        val diskKey = ByteArray(32) { 0x42 }
        val deposit = ServerTransferFlow.buildDiskKeyDeposit(
            serverDomain = host, username = "alice", irk = Ed25519Sign(giver.privateKey),
            irkPubHex = HexUtil.encode(giver.publicKey), diskKey = diskKey,
            acquirerIrkPubHex = HexUtil.encode(acquirer.publicKey), issuedAt = 1000,
            authNonce = ByteArray(32) { 2 },
        )
        // The acquirer opens it with their IRK seed.
        val opened = ServerTransferFlow.openDiskKey(deposit.sealedDiskKey, acquirer.privateKey)
        assertArrayEquals(diskKey, opened)
        assertEquals("alice", deposit.auth.username)
    }

    @Test
    fun mockClientRecordsOfferAndServesScriptedPoll() = runBlocking {
        val client = MockServerTransferClient()
        val giver = keypair()
        val built = ServerTransferFlow.buildOffer(
            host, "alice", Ed25519Sign(giver.privateKey), HexUtil.encode(giver.publicKey), 1, nonce = ByteArray(32), authNonce = ByteArray(32),
        )
        client.postOffer(host, built.body)
        assertEquals(1, client.offers.size)
        // Poll returns null until scripted.
        val auth = ServerTransferFlow.buildMailboxAuth("alice", Ed25519Sign(giver.privateKey), HexUtil.encode(giver.publicKey), 1)
        assertNull(client.pollClaim(host, auth))
        client.scriptedPoll = com.flagshipserver.app.api.TransferClaimPoll(
            newServerDomain = "home.bob.flagship.services", acquirerUsername = "bob", acquirerIrkPub = "cd".repeat(32),
        )
        assertNotNull(client.pollClaim(host, auth))
        assertTrue(true)
    }
}
