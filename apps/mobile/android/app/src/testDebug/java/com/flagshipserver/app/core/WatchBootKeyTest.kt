// The watch boot key (option (a), docs/watch-boot-approval-without-unlock.md): the owner's
// per-server opt-in deposits a copy of the disk key sealed to the boot-only key, attested by the
// account key; a watch Approve then answers without the account key, signed by the delegate,
// and a locked server is refused (423) so it is started from the phone.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.SignedSecretRequest
import com.flagshipserver.companion.ApproveCommand
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchBootKeyTest {
    private val user = "alice"
    private val domain = "kitchen.alice.flagship.services"
    private val now = 1_760_000_000_000L
    private val irkSeed = ByteArray(32) { 7 }
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(irkSeed)
    private val delegateKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 3 })
    private val delegatePubHex = HexUtil.encode(delegateKp.publicKey)
    private val stkSeed = ByteArray(32) { 5 }
    private val stkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(stkSeed)
    private val nonceHex = "cd".repeat(32)
    private val diskKey = ByteArray(64) { (it * 3).toByte() }

    /** The Keystore stand-in: the private key never leaves this object. */
    private class SoftStore : WatchBootKeyStore {
        private var priv: ByteArray? = null
        val copies = HashMap<String, WatchBootCopy>()
        override fun loadOrCreate(): BootDecryptKey {
            if (priv == null) priv = X25519.generatePrivateKey()
            return existing()!!
        }
        override fun existing(): BootDecryptKey? {
            val p = priv ?: return null
            return object : BootDecryptKey {
                override val publicKey = X25519.publicFromPrivate(p)
                override fun agree(peerPublicKey: ByteArray) = X25519.computeSharedSecret(p, peerPublicKey)
            }
        }
        override fun copies(): Map<String, WatchBootCopy> = copies.toMap()
        override fun setCopy(serverDomain: String, copy: WatchBootCopy?) {
            if (copy == null) copies.remove(serverDomain) else copies[serverDomain] = copy
        }
        override fun clear() { priv = null; copies.clear() }
    }

    private val irk = object : IrkAccess {
        override suspend fun resolve(reason: String) = IrkMaterial(Ed25519Sign(irkKp.privateKey), irkSeed, HexUtil.encode(irkKp.publicKey))
    }

    /** A request the box signed with [signer] naming [stkPub], as `.com` relays it. */
    private fun signed(
        signer: Ed25519Sign.KeyPair = stkKp,
        stkPub: ByteArray = signer.publicKey,
        expiresAt: Long = now + 600_000,
    ): SignedSecretRequest {
        val stkHex = HexUtil.encode(stkPub)
        val sig = Ed25519Sign(signer.privateKey).sign(SecretRequest.canonicalBytes(domain, stkHex, SecretPurpose.UNLOCK_KEY, nonceHex, now - 1_000))
        return SignedSecretRequest(domain, nonceHex, stkHex, "unlock-key", now - 1_000, HexUtil.encode(sig), expiresAt)
    }

    private fun mailbox() = MockSecretMailboxClient().apply {
        sealedLuksKeyHex = HexUtil.encode(SecretSeal.sealForEd25519Recipient(diskKey, irkKp.publicKey))
        signedRequests = listOf(signed())
    }

    private val forged = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })

    private fun header(auth: String) =
        Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(auth.removePrefix("Flagship-Boot-v1 ")))).jsonObject

    /** The phone's pinned server keys (docs/first-contact.md). */
    private class MemPins : ServerKeyPinStore {
        val map = HashMap<String, String>()
        override fun get(serverDomain: String) = map[serverDomain]
        override fun put(serverDomain: String, stkPubHex: String) { map[serverDomain] = stkPubHex }
        override fun remove(serverDomain: String) { map.remove(serverDomain) }
    }
    private val pinStore = MemPins()
    private val pins = ServerKeyPins(pinStore)
    /** The key the server's first blessing pinned on this phone (null: never blessed here). */
    private var blessedKey: String? = HexUtil.encode(stkKp.publicKey)

    /** The switch only reads the pin; the first blessing (an approval) records it. */
    private fun optIn(m: MockSecretMailboxClient, store: SoftStore): WatchBootOptIn {
        blessedKey?.let { pins.recordFirstSeen(domain, it) }
        return WatchBootOptIn(m, irk, store, pins, { "alice" }, now = { now }, nonceGen = { ByteArray(32) { 2 } })
    }

    private fun approver(m: MockSecretMailboxClient, store: SoftStore) = WatchBootApprover(
        m, { WatchDelegateSigner(Ed25519Sign(delegateKp.privateKey), delegatePubHex) }, store,
        ReadTokenStartUpSource(m, user), pins, now = { now }, nonceGen = { ByteArray(32) { 4 } },
    )

    @Test fun optInDepositsAnAttestedCopyThatOutlivesNeitherTheDelegateNorAWeek() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        val delegateEnds = now + 3 * 24 * 3_600_000L
        val ends = optIn(m, store).enable(domain, delegatePubHex, delegateEnds, "reason")
        val (dep, auth) = m.watchBootPuts.single()
        assertTrue(ends < delegateEnds)
        assertEquals(ends, dep.expiresAt)
        assertEquals(HexUtil.encode(store.existing()!!.publicKey), dep.decryptPubHex)
        assertEquals(delegatePubHex, dep.delegatePubHex)
        Ed25519Verify(irkKp.publicKey).verify(HexUtil.decode(dep.signatureHex)!!, WatchBootDelegate.canonicalBytes(dep.toDeposit().attestation))
        assertEquals("owner", header(auth)["role"]!!.jsonPrimitive.content)
        assertEquals("/api/boot/watch-key", header(auth)["path"]!!.jsonPrimitive.content)
        assertEquals(mapOf(domain to WatchBootCopy(ends)), store.copies)
        assertEquals(HexUtil.encode(stkKp.publicKey), pinStore.map[domain])

        val week = optIn(m, SoftStore()).enable(domain, delegatePubHex, now + 30L * 24 * 3_600_000, "reason")
        assertTrue(week - now <= WatchBootDelegate.MAX_MS)
    }

    @Test fun theWatchStartsTheServerWithoutTheAccountKey() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        assertTrue(approver(m, store).available(domain))
        assertEquals(WatchBootApprover.Outcome.Approved, approver(m, store).approve(domain, null))
        val (body, auth) = m.postedResponses.single()
        assertEquals(nonceHex, body.requestNonceHex)
        val h = header(auth)
        assertEquals("delegate", h["role"]!!.jsonPrimitive.content)
        assertEquals(delegatePubHex, h["pubKeyHex"]!!.jsonPrimitive.content)
        // Only the box opens it, and it is bound to this request.
        val framed = SecretSeal.openWithEd25519Seed(HexUtil.decode(body.sealed)!!, stkSeed)
        val ctx = SealedSecretResponse.context(nonceHex, SecretPurpose.UNLOCK_KEY)
        assertTrue(framed.copyOfRange(4, 4 + ctx.size).contentEquals(ctx))
        assertTrue(framed.copyOfRange(4 + ctx.size, framed.size).contentEquals(diskKey))
    }

    @Test fun aLockedServerIsLeftForThePhone() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        m.lockedDomains = setOf(domain)
        assertEquals(WatchBootApprover.Outcome.Locked, approver(m, store).approve(domain, null))
        assertTrue(m.postedResponses.isEmpty())

        val reply = WatchApprovalResponder(
            delegateEnrolled = { true },
            hasSessionKey = { false },
            makeSource = { error("no account-key path for a locked server") },
            bootApprover = { approver(m, store) },
        ).respond(ApproveCommand(serverFqdn = domain))
        assertFalse(reply.ok)
        assertEquals(WatchApprovalResponder.LOCKED, reply.errorMessage)
    }

    @Test fun theWatchApproveUsesTheBootKeyWithThePhoneLocked() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        val reply = WatchApprovalResponder(
            delegateEnrolled = { true },
            hasSessionKey = { false },
            makeSource = { error("the account key isn't needed") },
            bootApprover = { approver(m, store) },
        ).respond(ApproveCommand(serverFqdn = domain))
        assertTrue(reply.errorMessage, reply.ok)
        assertEquals(1, m.postedResponses.size)
    }

    @Test fun withoutACopyTheAccountKeyPathStillAnswers() = runBlocking {
        val m = mailbox()
        val store = SoftStore().apply { loadOrCreate(); setCopy(domain, WatchBootCopy(now + 60_000)) }
        pins.recordFirstSeen(domain, HexUtil.encode(stkKp.publicKey))
        assertEquals(WatchBootApprover.Outcome.NotAvailable, approver(m, store).approve(domain, null))
        assertTrue("a copy the worker doesn't hold is forgotten", store.copies.isEmpty())
        val reply = WatchApprovalResponder(
            delegateEnrolled = { true },
            hasSessionKey = { false },
            appInForeground = { false },
            makeSource = { null },
            bootApprover = { approver(m, store) },
        ).respond(ApproveCommand(serverFqdn = domain))
        assertEquals(WatchApprovalResponder.OPEN_AND_UNLOCK, reply.errorMessage)
    }

    /** `.com` naming another key for the box never gets the disk key sealed to it. */
    @Test fun aKeyFromDotComThatIsntThePinnedOneIsRefused() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        m.signedRequests = listOf(signed(signer = forged))
        assertEquals(WatchBootApprover.Outcome.KeyMismatch, approver(m, store).approve(domain, null))
        assertTrue(m.postedResponses.isEmpty())

        val reply = WatchApprovalResponder(
            delegateEnrolled = { true },
            hasSessionKey = { true },
            makeSource = { error("no fallback past a key that doesn't match") },
            bootApprover = { approver(m, store) },
        ).respond(ApproveCommand(serverFqdn = domain))
        assertFalse(reply.ok)
        assertEquals(WatchApprovalResponder.KEY_MISMATCH, reply.errorMessage)
        assertTrue(m.postedResponses.isEmpty())
    }

    /** Naming the pinned key is not enough: the box's signature must verify under it. */
    @Test fun aRequestThePinnedKeyDidntSignIsRefused() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        m.signedRequests = listOf(signed(signer = forged, stkPub = stkKp.publicKey))
        assertEquals(WatchBootApprover.Outcome.KeyMismatch, approver(m, store).approve(domain, null))
        assertTrue(m.postedResponses.isEmpty())
    }

    @Test fun anExpiredRequestIsNotAnswered() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        m.signedRequests = listOf(signed(expiresAt = now - 1))
        assertEquals(WatchBootApprover.Outcome.NotWaiting, approver(m, store).approve(domain, null))
        assertTrue(m.postedResponses.isEmpty())
    }

    /** The pinned key stays: a different key later is refused, never adopted. */
    @Test fun thePinIsRecordedOnceAndADifferentKeyLaterIsRefused() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        val first = pinStore.map[domain]
        blessedKey = HexUtil.encode(forged.publicKey)
        assertEquals(ServerKeyPins.Record.Mismatch, pins.recordFirstSeen(domain, blessedKey))
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        assertEquals(first, pinStore.map[domain])
        assertEquals("the copy is still made for the pinned server", 2, m.watchBootPuts.size)
        // A box now signing with that other key is refused.
        m.signedRequests = listOf(signed(signer = forged))
        assertEquals(WatchBootApprover.Outcome.KeyMismatch, approver(m, store).approve(domain, null))
        assertTrue(m.postedResponses.isEmpty())
        // Only an explicit re-trust lets a new key be recorded.
        pins.forget(domain)
        assertEquals(ServerKeyPins.Record.Recorded, pins.recordFirstSeen(domain, blessedKey))
    }

    @Test fun noKeyRecordedMeansNoWatchPath() = runBlocking {
        val m = mailbox()
        val store = SoftStore().apply { loadOrCreate(); setCopy(domain, WatchBootCopy(now + 60_000)) }
        assertEquals(WatchBootApprover.Outcome.NotAvailable, approver(m, store).approve(domain, null))
        blessedKey = null
        val refused = runCatching { optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason") }
        assertTrue(refused.exceptionOrNull() is ServerKeyNotPinnedException)
        assertTrue(m.watchBootPuts.isEmpty())
    }

    /** A real box's key is random, so nothing on the watch path may derive one from the account key. */
    @Test fun theWatchPathNeverDerivesAServerKey() {
        var dir = java.io.File(".").absoluteFile
        while (!java.io.File(dir, "app/src/main/java/com/flagshipserver/app").exists()) dir = dir.parentFile
        val src = java.io.File(dir, "app/src/main/java/com/flagshipserver/app")
        val watchPath = listOf(
            "core/WatchBootKey.kt", "core/ServerKeyPins.kt", "core/WatchDelegateRenewal.kt", "core/WatchApprovalResponder.kt",
            "keystore/WatchBootWiring.kt", "keystore/KeystoreWatchBootKeys.kt", "viewmodels/WatchBootViewModel.kt",
            "ui/screens/WatchQuickApproveCard.kt", "companion/CompanionSurfaces.kt",
        )
        for (f in watchPath) assertFalse(f, java.io.File(src, f).readText().contains("deriveStk"))
        val main = java.io.File(src, "MainActivity.kt").readText()
        val renewal = main.substring(main.indexOf("WatchDelegateRenewal("), main.indexOf("renewal.renewIfDue()"))
        assertFalse(renewal.contains("deriveStk"))
    }

    @Test fun aServerNotWaitingIsSaidSo() = runBlocking {
        val m = mailbox().apply { signedRequests = emptyList() }
        val store = SoftStore()
        optIn(m, store).enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        assertEquals(WatchBootApprover.Outcome.NotWaiting, approver(m, store).approve(domain, null))
    }

    @Test fun turningItOffTakesTheCopiesAway() = runBlocking {
        val m = mailbox()
        val store = SoftStore()
        val o = optIn(m, store)
        o.enable(domain, delegatePubHex, now + 7L * 24 * 3_600_000, "reason")
        o.disable(domain, "reason")
        val (d, auth) = m.watchBootDeletes.single()
        assertEquals(domain, d)
        assertEquals("/api/boot/watch-key/$domain", header(auth)["path"]!!.jsonPrimitive.content)
        assertTrue(m.watchBootKeys.isEmpty())
        assertTrue(o.live().isEmpty())
        assertFalse(approver(m, store).available(domain))
    }
}
