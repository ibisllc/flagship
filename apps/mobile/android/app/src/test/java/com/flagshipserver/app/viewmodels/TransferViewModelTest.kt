// Transfer-a-box VM logic (Layer C, Android). Drives the giver + acquirer VMs
// against MockServerTransferClient + MockSecretMailboxClient, asserting the
// signed wire bodies the broker accepts + the phase machine. JVM-testable
// (injected signer/pub/seed — no Android keystore/biometric).

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.MockServerTransferClient
import com.flagshipserver.app.core.AdminRootTransfer
import com.flagshipserver.app.core.AdminRootTransferClaim
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
            signer = signer(giver), irkPubHex = pub(giver), orderSigner = { null }, irkSeed = { giver.privateKey }, now = { 1700 },
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
        // The QR is now the universal-link form; it decodes + parses back.
        assertTrue(vm.qrText!!.contains("/transfer?o="))
        val qr = ServerTransferFlow.parseQR(ServerTransferFlow.offerJsonFrom(vm.qrText!!)!!)
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
            signer = signer(giver), irkPubHex = pub(giver), orderSigner = { null }, irkSeed = { giver.privateKey }, now = { 1700 },
        )
        vm.start()
        val done = vm.pollOnce()
        assertTrue(done)
        assertEquals(TransferGiverPhase.Completed("home.bob.flagship.services"), vm.phase.value)
        assertEquals(1, client.diskKeyDeposits.size)
        // The deposited blob opens with the ACQUIRER IRK seed and yields the disk key.
        val opened = ServerTransferFlow.openDiskKey(client.diskKeyDeposits[0].second.sealedDiskKey, acquirer.privateKey)
        assertArrayEquals(diskKey, opened)
        // No admin root on the giver device ⇒ no hand-off deposit (silent skip).
        assertEquals(0, client.adminHandoffDeposits.size)
    }

    // ── §9.8: the giver hands the acquirer's admin root to the box ───────────

    private val giverAdmin = Ed25519Sign.KeyPair.newKeyPair()

    private fun giverVmWithAdminRoot(
        client: MockServerTransferClient,
        mailbox: MockSecretMailboxClient = MockSecretMailboxClient(),
    ) = TransferGiverViewModel(
        serverDomain = host, username = "alice", client = client, mailbox = mailbox,
        signer = signer(giver), irkPubHex = pub(giver),
        orderSigner = { Ed25519Sign(giverAdmin.privateKey) },
        orderKeyPubHex = { HexUtil.encode(giverAdmin.publicKey) },
        irkSeed = { giver.privateKey }, now = { 1700 },
    )

    @Test
    fun giverWithAdminRootDepositsSignedHandoff() = runTest {
        val acquirerAdminHex = "77".repeat(32)
        val client = MockServerTransferClient().apply {
            scriptedPoll = com.flagshipserver.app.api.TransferClaimPoll(
                newServerDomain = "home.bob.flagship.services",
                acquirerUsername = "bob",
                acquirerIrkPub = HexUtil.encode(acquirer.publicKey),
                acquirerAdminRootPub = acquirerAdminHex,
            )
        }
        val vm = giverVmWithAdminRoot(client)
        vm.start()
        assertTrue(vm.pollOnce())
        assertEquals(TransferGiverPhase.Completed("home.bob.flagship.services"), vm.phase.value)
        assertEquals(1, client.adminHandoffDeposits.size)
        val (domain, body) = client.adminHandoffDeposits[0]
        // Deposited against the box's OLD canonical, carrying the claim's values.
        assertEquals(host, domain)
        assertEquals(host, body.handoff.serverDomain)
        assertEquals("alice", body.handoff.giverUsername)
        assertEquals("bob", body.handoff.acquirerUsername)
        assertEquals(HexUtil.encode(giverAdmin.publicKey).lowercase(), body.handoff.oldAdminRootPub)
        assertEquals(acquirerAdminHex, body.handoff.newAdminRootPub)
        // Bound to the offer's transfer nonce.
        assertEquals(client.offers[0].second.offer.transferNonce, body.handoff.transferNonce)
        // The proof verifies under the GIVER's admin master root (the box's pin).
        val handoff = AdminRootTransfer(
            serverDomain = body.handoff.serverDomain,
            giverUsername = body.handoff.giverUsername,
            acquirerUsername = body.handoff.acquirerUsername,
            oldAdminRootPub = body.handoff.oldAdminRootPub,
            newAdminRootPub = body.handoff.newAdminRootPub,
            transferNonce = body.handoff.transferNonce,
            issuedAt = body.handoff.issuedAt,
        )
        assertTrue(AdminRootTransferClaim.verify(handoff, HexUtil.decode(body.signatureHex)!!, giverAdmin.publicKey))
    }

    @Test
    fun giverHandoffEmptyAcquirerRootMeansUnpin() = runTest {
        val client = MockServerTransferClient().apply {
            scriptedPoll = com.flagshipserver.app.api.TransferClaimPoll(
                newServerDomain = "home.bob.flagship.services",
                acquirerUsername = "bob",
                acquirerIrkPub = HexUtil.encode(acquirer.publicKey),
                acquirerAdminRootPub = null,
            )
        }
        val vm = giverVmWithAdminRoot(client)
        vm.start()
        assertTrue(vm.pollOnce())
        assertEquals(TransferGiverPhase.Completed("home.bob.flagship.services"), vm.phase.value)
        assertEquals("", client.adminHandoffDeposits[0].second.handoff.newAdminRootPub)
    }

    @Test
    fun giverHandoffDepositFailureDegradesToWarning_resealUnaffected() = runTest {
        val sealedForGiver = SecretSeal.sealForEd25519Recipient(ByteArray(32) { 0x42 }, giver.publicKey)
        val client = MockServerTransferClient().apply {
            scriptedPoll = com.flagshipserver.app.api.TransferClaimPoll(
                newServerDomain = "home.bob.flagship.services",
                acquirerUsername = "bob",
                acquirerIrkPub = HexUtil.encode(acquirer.publicKey),
                acquirerAdminRootPub = "77".repeat(32),
            )
            adminHandoffError = RuntimeException("boom")
        }
        val mailbox = MockSecretMailboxClient().apply { sealedLuksKeyHex = HexUtil.encode(sealedForGiver) }
        val vm = giverVmWithAdminRoot(client, mailbox)
        vm.start()
        // Ownership already moved ⇒ still terminal (true), but completed-with-warning.
        assertTrue(vm.pollOnce())
        val p = vm.phase.value as TransferGiverPhase.Failed
        assertTrue(p.message.contains("Ownership moved"))
        assertTrue(p.message.contains("re-homing"))
        // The disk-key re-seal already landed — unaffected by the hand-off failure.
        assertEquals(1, client.diskKeyDeposits.size)
        assertEquals(0, client.adminHandoffDeposits.size)
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
            username = "Bob", client = client, signer = signer(acquirer), irkPubHex = pub(acquirer),
            orderSigner = { null }, adminRootPubHex = { null }, now = { 1800 },
        )
        assertTrue(vm.ingest(qrText))
        vm.confirm()
        assertEquals(TransferAcquirerPhase.Claimed(host), vm.phase.value)
        assertEquals(1, client.claims.size)
        val body = client.claims[0].second
        assertEquals("bob", body.claim.acquirerUsername)
        // No admin root on this account ⇒ the v2 slot is "" (unpin at re-home).
        assertEquals("", body.claim.acquirerAdminRootPub)
        Ed25519Verify(acquirer.publicKey).verify(
            HexUtil.decode(body.claimSignature)!!,
            ServerTransferClaimOrder.canonicalBytes(host, body.claim.transferNonce, "bob", body.claim.acquirerIrkPub, "", 1800),
        )
    }

    @Test
    fun acquirerClaimCarriesAdminRootPubUnderV2Bytes() = runTest {
        val acquirerAdmin = Ed25519Sign.KeyPair.newKeyPair()
        val built = ServerTransferFlow.buildOffer(
            serverDomain = host, username = "alice", irk = Ed25519Sign(giver.privateKey),
            irkPubHex = HexUtil.encode(giver.publicKey), issuedAt = 1, ttlMs = 9_999_999_999_999,
            nonce = ByteArray(32) { 0xab.toByte() }, authNonce = ByteArray(32) { 1 },
        )
        val client = MockServerTransferClient()
        val vm = TransferAcquirerViewModel(
            username = "Bob", client = client, signer = signer(acquirer), irkPubHex = pub(acquirer),
            orderSigner = { Ed25519Sign(acquirerAdmin.privateKey) },
            adminRootPubHex = { HexUtil.encode(acquirerAdmin.publicKey) },
            now = { 1800 },
        )
        assertTrue(vm.ingest(ServerTransferFlow.encodeQR(built.qr)))
        vm.confirm()
        assertEquals(TransferAcquirerPhase.Claimed(host), vm.phase.value)
        val body = client.claims[0].second
        // The acquirer's admin root pub rides the wire...
        assertEquals(HexUtil.encode(acquirerAdmin.publicKey).lowercase(), body.claim.acquirerAdminRootPub)
        // ...INSIDE the v2 signed canonical (signed by the admin root).
        Ed25519Verify(acquirerAdmin.publicKey).verify(
            HexUtil.decode(body.claimSignature)!!,
            ServerTransferClaimOrder.canonicalBytes(
                host, body.claim.transferNonce, "bob", body.claim.acquirerIrkPub,
                body.claim.acquirerAdminRootPub, 1800,
            ),
        )
    }

    @Test
    fun acquirerRejectsNonTransferQR() {
        val vm = TransferAcquirerViewModel(username = "bob", client = MockServerTransferClient())
        assertFalse(vm.ingest("garbage"))
        assertTrue(vm.phase.value is TransferAcquirerPhase.Failed)
    }

    // ── Slice C: the acquirer VERIFIES the offer before it can claim ─────────

    private fun validOffer(ttlMs: Long = 9_999_999_999_999L) = ServerTransferFlow.buildOffer(
        serverDomain = host, username = "alice", irk = Ed25519Sign(giver.privateKey),
        irkPubHex = HexUtil.encode(giver.publicKey), issuedAt = 1, ttlMs = ttlMs,
        nonce = ByteArray(32) { 0xab.toByte() }, authNonce = ByteArray(32) { 1 },
    )

    @Test
    fun acquirerRejectsTamperedOffer() {
        // A valid offer whose serverDomain was swapped AFTER signing: the
        // signature no longer verifies over the canonical bytes.
        val tampered = validOffer().qr.copy(serverDomain = "evil.mallory.flagship.services")
        val vm = TransferAcquirerViewModel(username = "bob", client = MockServerTransferClient(), now = { 1800 })
        assertFalse(vm.ingest(ServerTransferFlow.encodeQR(tampered)))
        val p = vm.phase.value as TransferAcquirerPhase.Failed
        assertTrue(p.message.contains("verify"))
    }

    @Test
    fun acquirerRejectsExpiredOffer() {
        // Signature is valid, but expiresAt (101) is in the past relative to now.
        val expired = validOffer(ttlMs = 100)
        val vm = TransferAcquirerViewModel(username = "bob", client = MockServerTransferClient(), now = { 1800 })
        assertFalse(vm.ingest(ServerTransferFlow.encodeQR(expired.qr)))
        val p = vm.phase.value as TransferAcquirerPhase.Failed
        assertTrue(p.message.lowercase().contains("expired"))
    }

    @Test
    fun acquirerAcceptsUrlFormOffer() {
        // The giver's QR is the universal-link form; the acquirer ingests it.
        val url = ServerTransferFlow.offerUrl(validOffer().qr)
        val vm = TransferAcquirerViewModel(username = "bob", client = MockServerTransferClient(), now = { 1800 })
        assertTrue(vm.ingest(url))
        assertEquals(TransferAcquirerPhase.Scanned(host), vm.phase.value)
    }

    @Test
    fun acquirerNeverClaimsWithoutIngest() = runTest {
        val client = MockServerTransferClient()
        val vm = TransferAcquirerViewModel(username = "bob", client = client, now = { 1800 })
        vm.confirm()
        assertTrue(vm.phase.value is TransferAcquirerPhase.Failed)
        assertEquals(0, client.claims.size)
    }
}
