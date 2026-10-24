// A box keeps only its boot key on /boot: disk-key replies and auto-unlock leases go to it,
// adopted only through a binding the pinned STK signed (packages/protocol/test-vectors/boot-key,
// also read by the TypeScript side and the webapp).

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.flagshipserver.app.api.SecretMailboxClient
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class BootKeyTest {
    private val user = "alice"
    private val domain = "kitchen.alice.flagship.services"
    private val issuedAt = 1_750_000_000_000L
    private val irkSeed = ByteArray(32) { 7 }
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed)
    private val stkSeed = ByteArray(32) { 5 }
    private val stkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(stkSeed)
    private val stkPubHex = HexUtil.encode(stkKp.publicKey)
    private val bootSeed = ByteArray(32) { 0x1b }
    private val bootKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(bootSeed)
    private val bootPubHex = HexUtil.encode(bootKp.publicKey)
    private val otherSeed = ByteArray(32) { 0x0c }
    private val nonceHex = "ab".repeat(32)
    private val luksKey = ByteArray(64) { it.toByte() }

    // ── the shared vectors ───────────────────────────────────────────────────

    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/boot-key/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile; hops++
        }
        fail("could not locate $rel"); error("unreachable")
    }

    @Test fun everyBindingCaseOfTheSharedVectors() {
        val v = vectors()
        val b = v["binding"]!!.jsonObject
        val canon = BoxKeyPins.canonicalBootKeyBinding(
            v["serverDomain"]!!.jsonPrimitive.content, v["bootKeyPubHex"]!!.jsonPrimitive.content, 1_760_000_000_000L,
        )!!
        assertEquals(b["canonical"]!!.jsonPrimitive.content, String(canon))
        val cases = b["cases"]!!.jsonArray
        assertTrue(cases.size >= 8)
        for (c in cases) {
            val o = c.jsonObject
            val name = o["name"]!!.jsonPrimitive.content
            val wire = BootKey.parse(o["wire"]!!.toString())
            val expect = o["expect"]!!.jsonObject
            val want = o["bootKeyPubHex"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            val got = wire?.let {
                BootKey.verified(it, expect["stkPubHex"]!!.jsonPrimitive.content, expect["serverDomain"]!!.jsonPrimitive.content)
            }
            assertEquals(name, want, got)
        }
    }

    // ── the pin store and the share variant ──────────────────────────────────

    private fun binding(signer: ByteArray = stkSeed, boot: String = bootPubHex, at: Long = issuedAt): BootKeyBindingWire {
        val sig = Ed25519Sign(signer).sign(BoxKeyPins.canonicalBootKeyBinding(domain, boot, at)!!)
        return BootKeyBindingWire(BootKeyBindingWire.Binding(domain, boot, at), HexUtil.encode(sig))
    }

    private fun pinned(store: ServerKeyPins = ServerKeyPins(InMemoryServerKeyPinStore())) =
        BoxKeyPins(store).apply { repin(user, domain, stkPubHex) }

    @Test fun bootKeyForAdoptsOnlyWhatThePinnedStkBound() = runBlocking {
        val pins = pinned()
        assertNull("a box without one", BootKey.bootKeyFor(user, domain, { null }, pins))
        assertNull("signed by another key", BootKey.bootKeyFor(user, domain, { binding(signer = otherSeed) }, pins))
        assertNull("the STK itself", BootKey.bootKeyFor(user, domain, { binding(boot = stkPubHex) }, pins))
        assertEquals(bootPubHex, BootKey.bootKeyFor(user, domain, { binding() }, pins))
        assertEquals("kept when .com is down", bootPubHex, BootKey.bootKeyFor(user, domain, { throw java.io.IOException("down") }, pins))
        assertEquals("a forged one never replaces it", bootPubHex, BootKey.bootKeyFor(user, domain, { binding(signer = otherSeed, boot = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(otherSeed).publicKey)) }, pins))
        assertNull("no pin, no adoption", BootKey.bootKeyFor(user, domain, { binding() }, BoxKeyPins(ServerKeyPins(InMemoryServerKeyPinStore()))))
    }

    @Test fun sharedBootKeyForChecksTheOffersStk() = runBlocking {
        assertEquals(bootPubHex, BootKey.sharedBootKeyFor(domain, stkPubHex, { binding() }))
        assertNull(BootKey.sharedBootKeyFor(domain, stkPubHex, { binding(signer = otherSeed) }))
        assertNull(BootKey.sharedBootKeyFor(domain, stkPubHex, { null }))
    }

    // ── the coordinator ──────────────────────────────────────────────────────

    private fun request(signerSeed: ByteArray, purpose: SecretPurpose = SecretPurpose.UNLOCK_KEY): PendingSecretRequest {
        val pub = HexUtil.encode(Ed25519Sign.KeyPair.newKeyPairFromSeed(signerSeed).publicKey)
        val sig = Ed25519Sign(signerSeed).sign(SecretRequest.canonicalBytes(domain, pub, purpose, nonceHex, issuedAt))
        return PendingSecretRequest(
            serverDomain = domain, requestNonceHex = nonceHex, stkPub = pub,
            purpose = purpose.wire, issuedAt = issuedAt, requestSignature = HexUtil.encode(sig),
            postedAt = issuedAt, expiresAt = issuedAt + 600_000,
        )
    }

    private fun world(req: PendingSecretRequest) = MockSecretMailboxClient().apply {
        directory = listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = stkPubHex))
        pending = listOf(req)
        sealedLuksKeyHex = HexUtil.encode(SecretSeal.sealForEd25519Recipient(luksKey, irkKp.publicKey))
    }

    private fun withBinding(mock: MockSecretMailboxClient, served: BootKeyBindingWire?): SecretMailboxClient =
        object : SecretMailboxClient by mock {
            override suspend fun fetchBootKeyBinding(serverDomain: String): BootKeyBindingWire? = served
        }

    private val irkAccess = object : IrkAccess {
        override suspend fun resolve(reason: String) =
            IrkMaterial(Ed25519Sign(irkKp.privateKey), irkSeed, HexUtil.encode(irkKp.publicKey))
    }

    private fun coordinator(mailbox: SecretMailboxClient, pin: Boolean = true): SecretRequestCoordinator {
        val store = ServerKeyPins(InMemoryServerKeyPinStore())
        val pins = if (pin) pinned(store) else BoxKeyPins(store)
        return SecretRequestCoordinator(
            mailbox = mailbox, username = user, irk = irkAccess,
            now = { issuedAt }, nonceGen = { ByteArray(32) { 1 } },
            leaseRetryDelaysMs = listOf(0L, 0L), pins = pins,
            firstContact = FirstContact(store, null),
        )
    }

    private fun opensTo(sealed: ByteArray, seed: ByteArray): ByteArray? =
        runCatching { SecretSeal.openWithEd25519Seed(sealed, seed) }.getOrNull()

    @Test fun anUnlockSignedByTheBoundBootKeyIsSealedToIt() {
        val mock = world(request(bootSeed))
        val c = coordinator(withBinding(mock, binding()))
        val leaseId = runBlocking {
            val req = c.fetchVerifiedRequests().single()
            assertEquals(bootPubHex, req.recipientPubHex)
            assertEquals(stkPubHex, req.stkPubHex)
            c.confirmAndRespond(req, depositAutoLease = true)
        }
        assertNotNull(leaseId)
        val reply = HexUtil.decode(mock.postedResponses.single().first.sealed)!!
        assertArrayEquals(luksKey, opensTo(reply, bootSeed)!!.takeLast(64).toByteArray())
        assertNull("the STK can't open the reply", opensTo(reply, stkSeed))

        val lease = mock.deposited.single().first
        assertEquals("the lease names the boot key", bootPubHex, lease.stkPub)
        assertArrayEquals(luksKey, opensTo(HexUtil.decode(lease.sealedKey)!!, bootSeed))
        assertTrue("still IRK-signed", mock.secondBoot(domain))

        // The serve authorization stays bound to the STK.
        val ent = mock.entitlementDeposits.single().second.deposit
        assertEquals(stkPubHex, ent.stkPub)
    }

    @Test fun aFirstSightUnlockByTheBootKeyPinsTheStkOnApproveAndSealsToTheBootKey() {
        val mock = world(request(bootSeed))
        val c = coordinator(withBinding(mock, binding()), pin = false)
        runBlocking {
            val req = c.fetchRequests().single()
            assertEquals("the code is the STK's", stkPubHex, req.firstLook?.stkPubHex)
            assertEquals(bootPubHex, req.recipientPubHex)
            assertTrue(c.fetchVerifiedRequests().isEmpty())
            c.confirmAndRespond(req)
        }
        val reply = HexUtil.decode(mock.postedResponses.single().first.sealed)!!
        assertArrayEquals(luksKey, opensTo(reply, bootSeed)!!.takeLast(64).toByteArray())
    }

    @Test fun anUnpinnedServerNeverTakesABootKeyItsListedStkDidNotBind() = runBlocking {
        val req = coordinator(withBinding(world(request(bootSeed)), binding(signer = otherSeed)), pin = false).fetchRequests().single()
        assertEquals("a first sight of the signing key itself, never the listed STK", bootPubHex, req.firstLook?.stkPubHex)
    }

    @Test fun aBootKeyRequestWithoutAValidBindingIsDropped() = runBlocking {
        assertTrue(coordinator(withBinding(world(request(bootSeed)), null)).fetchVerifiedRequests().isEmpty())
        assertTrue(coordinator(withBinding(world(request(bootSeed)), binding(signer = otherSeed))).fetchVerifiedRequests().isEmpty())
        // Bound, but an entitlement must come from the STK.
        val ent = request(bootSeed, SecretPurpose.ENTITLEMENT)
        assertTrue(coordinator(withBinding(world(ent), binding())).fetchVerifiedRequests().isEmpty())
        // Another key claiming to be the bound boot key.
        assertTrue(coordinator(withBinding(world(request(otherSeed)), binding())).fetchVerifiedRequests().isEmpty())
    }

    @Test fun aBoxWithoutABootKeyStillGetsTheStk() {
        val mock = world(request(stkSeed))
        val c = coordinator(withBinding(mock, null))
        runBlocking {
            val req = c.fetchVerifiedRequests().single()
            assertEquals(stkPubHex, req.recipientPubHex)
            c.confirmAndRespond(req, depositAutoLease = true)
        }
        val reply = HexUtil.decode(mock.postedResponses.single().first.sealed)!!
        assertNotNull(opensTo(reply, stkSeed))
        assertEquals(stkPubHex, mock.deposited.single().first.stkPub)
    }
}
