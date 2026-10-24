package com.flagshipserver.app.core

import com.flagshipserver.app.api.DeviceInfoHint
import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** docs/first-contact.md through the approval ceremony: pin at the first blessing, refuse
 *  anything else, seal only to the pin, and sign the app-name grant in the same session. */
class FirstContactCoordinatorTest {
    private val user = "alice"
    private val domain = "home.alice.flagship.services"
    private val issuedAt = 1_760_000_000_000L
    private val irkSeed = ByteArray(32) { 7 }
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed)
    private val adminKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val stkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
    private val stkHex = HexUtil.encode(stkKp.publicKey)
    private val otherKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 6 })
    private val otherHex = HexUtil.encode(otherKp.publicKey)
    private val serial = "AC-7Q2M-91XZ"
    private val secret = ByteArray(32) { 0x77 }
    private val luksKey = ByteArray(64) { it.toByte() }

    private val pins = ServerKeyPins(InMemoryServerKeyPinStore())
    private val secrets = InMemoryEnrollmentSecretStore()
    private val delivered = mutableListOf<Triple<String, Long, String>>()
    private val outbox = InMemoryWildcardGrantOutbox()

    @Before fun wire() {
        WildcardGrants.outbox = outbox
        WildcardGrants.deliver = { d, at, sig -> delivered += Triple(d, at, sig); true }
    }

    @After fun unwire() {
        WildcardGrants.outbox = InMemoryWildcardGrantOutbox()
        WildcardGrants.deliver = { _, _, _ -> false }
    }

    private fun request(
        purpose: SecretPurpose,
        signer: Ed25519Sign.KeyPair = stkKp,
        proof: String? = null,
        nonce: String = "ab".repeat(32),
    ): PendingSecretRequest {
        val named = HexUtil.encode(signer.publicKey)
        val sig = Ed25519Sign(signer.privateKey).sign(SecretRequest.canonicalBytes(domain, named, purpose, nonce, issuedAt))
        return PendingSecretRequest(
            serverDomain = domain, requestNonceHex = nonce, stkPub = named, purpose = purpose.wire,
            issuedAt = issuedAt, requestSignature = HexUtil.encode(sig),
            deviceInfo = proof?.let { DeviceInfoHint(enrollmentProof = it) },
            postedAt = issuedAt, expiresAt = issuedAt + 600_000,
        )
    }

    private fun mailbox(vararg reqs: PendingSecretRequest, listed: String = otherHex) = MockSecretMailboxClient().apply {
        // `.com`'s list names some key: it is never what the phone trusts.
        directory = listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = listed))
        pending = reqs.toList()
        sealedLuksKeyHex = HexUtil.encode(SecretSeal.sealForEd25519Recipient(luksKey, irkKp.publicKey))
    }

    private fun coordinator(m: MockSecretMailboxClient) = SecretRequestCoordinator(
        mailbox = m,
        username = user,
        irk = object : IrkAccess {
            override suspend fun resolve(reason: String) = IrkMaterial(Ed25519Sign(irkKp.privateKey), irkSeed, HexUtil.encode(irkKp.publicKey))
        },
        adminSigner = { Ed25519Sign(adminKp.privateKey) },
        firstContact = FirstContact(pins, secrets) { emptyList() },
        now = { issuedAt },
        nonceGen = { ByteArray(32) { 1 } },
    )

    private fun proof(stk: String = stkHex) = Enrollment.proofHex(secret, domain, stk, serial)!!

    private fun createdHere() = secrets.put(domain, EnrollmentRecord(HexUtil.encode(secret), serial))

    @Test fun theFirstBlessingShowsTheCodeThenPinsAndSignsTheGrant() = runBlocking {
        createdHere()
        val m = mailbox(request(SecretPurpose.ENTITLEMENT, proof = proof()))
        val c = coordinator(m)
        val listed = c.fetchRequests().single()
        val look = assertNotNullOf(listed.firstLook)
        assertEquals(stkHex, look.stkPubHex)
        assertEquals(Enrollment.serverCode(stkHex), look.code)
        assertTrue(look.proven)
        // The one-tap card needs the owner to have seen this key's code first.
        val needs = runCatching { c.approvePendingEntitlement(domain) }.exceptionOrNull()
        assertTrue(needs is SecretRequestCoordinator.CoordinatorException.FirstLookRequired)
        assertTrue(m.postedResponses.isEmpty())
        assertNull(pins.pinnedHex(domain))

        c.approvePendingEntitlement(domain, acceptFirstSightKey = stkHex)
        assertEquals(1, m.postedResponses.size)
        assertEquals(stkHex, pins.pinnedHex(domain))
        assertNull("the enrollment secret is gone once pinned", secrets.get(domain))
        // The grant: the admin root over the PINNED key, handed to the box, nothing left waiting.
        val (d, at, sig) = delivered.single()
        assertEquals(domain, d)
        Ed25519Verify(adminKp.publicKey).verify(HexUtil.decode(sig)!!, ServerWildcardGrant.canonicalBytes(user, domain, stkHex, at))
        assertNull(outbox.get(domain))
        // The entitlement names the pinned key too.
        val carrier = String(HexUtil.decode(m.postedResponses.single().first.sealed)!!)
        assertTrue(carrier.contains(stkHex))
    }

    @Test fun aGrantTheBoxCantTakeYetWaitsInTheOutbox() = runBlocking {
        WildcardGrants.deliver = { _, _, _ -> false }
        val m = mailbox(request(SecretPurpose.ENTITLEMENT))
        val c = coordinator(m)
        c.confirmAndRespond(c.fetchRequests().single(), depositAutoLease = false)
        val waiting = assertNotNullOf(outbox.get(domain))
        assertEquals(stkHex, waiting.stkPubHex)
    }

    @Test fun aMissingOrWrongProofIsRefusedWhenThisDeviceHoldsTheSecret() = runBlocking {
        createdHere()
        for (p in listOf(null, proof(otherHex), "00".repeat(32))) {
            val m = mailbox(request(SecretPurpose.ENTITLEMENT, proof = p))
            val c = coordinator(m)
            val r = c.fetchRequests().single()
            assertEquals(FirstContactRefusal.NOT_FROM_RECIPE, r.refusal)
            assertTrue(c.fetchVerifiedRequests().isEmpty())
            val thrown = runCatching { c.confirmAndRespond(r) }.exceptionOrNull()
            assertEquals("This server was not built from your recipe. Do not approve it.", thrown?.message)
            assertTrue(runCatching { c.approvePendingEntitlement(domain, stkHex) }.exceptionOrNull() is SecretRequestCoordinator.CoordinatorException.Refused)
            assertTrue(m.postedResponses.isEmpty())
        }
        assertNull(pins.pinnedHex(domain))
    }

    @Test fun aChangedKeyIsRefusedAndNothingIsSealedToIt() = runBlocking {
        pins.recordFirstSeen(domain, stkHex)
        // The box (or `.com`) now names another key, and `.com`'s list agrees with it.
        val m = mailbox(request(SecretPurpose.UNLOCK_KEY, signer = otherKp), listed = otherHex)
        val c = coordinator(m)
        assertEquals(FirstContactRefusal.KEY_CHANGED, c.fetchRequests().single().refusal)
        val thrown = runCatching { c.approvePendingUnlock(domain) }.exceptionOrNull()
        assertEquals("This server's key changed. If you did not rebuild it, do not approve anything for it.", thrown?.message)
        assertTrue(m.postedResponses.isEmpty())
        assertEquals(stkHex, pins.pinnedHex(domain))
    }

    @Test fun afterThePinTheReplyIsSealedToThePinNotToTheList() = runBlocking {
        pins.recordFirstSeen(domain, stkHex)
        val m = mailbox(request(SecretPurpose.UNLOCK_KEY), listed = otherHex)
        val c = coordinator(m)
        val r = c.fetchVerifiedRequests().single()
        assertNull(r.firstLook)
        c.confirmAndRespond(r)
        val sealed = HexUtil.decode(m.postedResponses.single().first.sealed)!!
        // Only the pinned key's holder opens it.
        val payload = SecretSeal.openWithEd25519Seed(sealed, ByteArray(32) { 5 })
        val ctx = SealedSecretResponse.context("ab".repeat(32), SecretPurpose.UNLOCK_KEY)
        assertTrue(payload.copyOfRange(4 + ctx.size, payload.size).contentEquals(luksKey))
        assertTrue("no grant: this was not a first blessing", delivered.isEmpty())
    }

    @Test fun anUnlockFromAServerCreatedHereDoesNotPinOrHandOutAnEntitlement() = runBlocking {
        createdHere()
        val m = mailbox(request(SecretPurpose.UNLOCK_KEY))
        val c = coordinator(m)
        val r = c.fetchRequests().single()
        assertNotNull(r.firstLook)
        c.approvePendingUnlock(domain, acceptFirstSightKey = stkHex)
        assertEquals(1, m.postedResponses.size)
        assertNull("the proof comes with the entitlement request", pins.pinnedHex(domain))
        assertTrue("the box asks for its entitlement with the proof", m.entitlementDeposits.isEmpty())
        assertTrue(secrets.get(domain) != null)
    }

    @Test fun anExistingServerPinsOnFirstSightAtItsNextApprovalOnce() = runBlocking {
        val m = mailbox(request(SecretPurpose.UNLOCK_KEY))
        val c = coordinator(m)
        c.approvePendingUnlock(domain, acceptFirstSightKey = stkHex)
        assertEquals(stkHex, pins.pinnedHex(domain))
        assertEquals(1, m.entitlementDeposits.size)
        assertEquals(1, delivered.size)
        // A second request from the same key is simply pinned now: no code box, no second grant.
        val m2 = mailbox(request(SecretPurpose.UNLOCK_KEY, nonce = "cd".repeat(32)))
        val again = coordinator(m2).fetchRequests().single()
        assertNull(again.firstLook)
        assertEquals(ServerKeyPins.Record.AlreadyPinned, pins.recordFirstSeen(domain, stkHex))
    }

    @Test fun approvingAKeyOtherThanTheOneShownIsAFreshLook() = runBlocking {
        val m = mailbox(request(SecretPurpose.UNLOCK_KEY))
        val thrown = runCatching { coordinator(m).approvePendingUnlock(domain, acceptFirstSightKey = otherHex) }.exceptionOrNull()
        assertTrue(thrown is SecretRequestCoordinator.CoordinatorException.FirstLookRequired)
        assertTrue(m.postedResponses.isEmpty())
        assertNull(pins.pinnedHex(domain))
    }

    private fun <T> assertNotNullOf(v: T?): T {
        assertNotNull(v)
        return v!!
    }
}
