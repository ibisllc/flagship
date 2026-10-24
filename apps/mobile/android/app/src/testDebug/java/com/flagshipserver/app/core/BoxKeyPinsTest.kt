package com.flagshipserver.app.core

import com.flagshipserver.app.api.MockSecretMailboxClient
import com.flagshipserver.app.api.PendingSecretRequest
import com.flagshipserver.app.api.PodDirectoryEntry
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

// Pins BoxKeyPins to packages/protocol/test-vectors/box-key-pin/vectors.json
// (also read by the TS reference, the webapp and iOS).
class BoxKeyPinsTest {
    private val user = "plucky-avocet"

    private fun vectors(): JsonObject {
        val rel = "packages/protocol/test-vectors/box-key-pin/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        var hops = 0
        while (dir != null && hops < 14) {
            val f = File(dir, rel)
            if (f.isFile) return Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile; hops++
        }
        fail("could not locate $rel"); error("unreachable")
    }

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun decisionsMatchTheVectors() {
        for (d in vectors()["decisions"]!!.jsonArray) {
            val o = d.jsonObject
            val pinned = o["pinned"].takeIf { it != null && it != JsonNull }?.jsonPrimitive?.content
            assertEquals(o.toString(), o.s("verdict"), BoxKeyPins.decide(pinned, o.s("reported")).name.lowercase())
        }
    }

    @Test fun bootKeyBindingVerifiesOnlyUnderThePinnedStk() {
        val v = vectors()
        val b = v["bootKeyBinding"]!!.jsonObject
        val binding = b["binding"]!!.jsonObject
        val expect = b["expect"]!!.jsonObject
        val domain = binding.s("serverDomain")
        val boot = binding.s("bootPubHex")
        val issuedAt = binding["issuedAt"]!!.jsonPrimitive.long
        assertEquals(b.s("canonical"), String(BoxKeyPins.canonicalBootKeyBinding(domain, boot, issuedAt)!!, Charsets.UTF_8))
        val stk = HexUtil.decode(v.s("stkPubHex"))!!
        val other = HexUtil.decode(v.s("otherPubHex"))!!
        val sig = HexUtil.decode(b.s("signatureHex"))!!
        val forged = HexUtil.decode(b.s("signedByOtherKeyHex"))!!
        fun check(s: ByteArray, k: ByteArray, server: String) = BoxKeyPins.verifyBootKeyBinding(domain, boot, issuedAt, s, k, server)
        assertEquals(expect["signatureUnderPinnedStk"]!!.jsonPrimitive.boolean, check(sig, stk, domain))
        assertEquals(expect["signedByOtherKeyUnderPinnedStk"]!!.jsonPrimitive.boolean, check(forged, stk, domain))
        assertEquals(expect["signatureUnderOtherKey"]!!.jsonPrimitive.boolean, check(sig, other, domain))
        assertEquals(expect["signatureForOtherServer"]!!.jsonPrimitive.boolean, check(sig, stk, expect.s("otherServerDomain")))
    }

    private fun fresh(): Pair<ServerKeyPins, BoxKeyPins> {
        val store = ServerKeyPins(InMemoryServerKeyPinStore())
        return store to BoxKeyPins(store)
    }

    @Test fun firstSightNeverPinsAndASubstitutedKeyIsRefused() {
        val v = vectors()
        val (store, pins) = fresh()
        val domain = v.s("serverDomain")
        try {
            pins.require(user, domain, v.s("stkPubHex"))
            fail("a key nobody blessed was pinned")
        } catch (_: ServerKeyNotPinnedException) {}
        assertNull(pins.pinned(user, domain))
        assertEquals(emptyList<String>(), pins.observe(user, listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = v.s("stkPubHex")))))
        assertNull("the directory never pins", pins.pinned(user, domain))
        store.recordFirstSeen(domain, v.s("stkPubHex"))
        assertEquals(v.s("stkPubHex"), pins.require(user, domain, v.s("stkPubHex")))
        assertEquals(v.s("stkPubHex"), pins.require(user, domain.uppercase(), v.s("stkPubHex").uppercase()))
        try {
            pins.require(user, domain, v.s("otherPubHex"))
            fail("a substituted key passed")
        } catch (e: BoxKeyChangedException) {
            assertEquals(v.s("otherPubHex"), e.reportedHex)
            assertEquals(v.s("stkPubHex"), e.pinnedHex)
            assertTrue(e.message!!.contains("key changed"))
        }
        assertEquals(listOf(domain.lowercase()), pins.observe(user, listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = v.s("otherPubHex")))))
        assertEquals(v.s("stkPubHex"), pins.pinned(user, domain))
    }

    @Test fun repinAfterAReinstallMovesThePinAndDropsTheBootKey() {
        val v = vectors()
        val (store, pins) = fresh()
        val domain = v.s("serverDomain")
        val b = v["bootKeyBinding"]!!.jsonObject
        val binding = b["binding"]!!.jsonObject
        val boot = binding.s("bootPubHex")
        val at = binding["issuedAt"]!!.jsonPrimitive.long
        assertNull(pins.acceptBootKeyBinding(user, domain, boot, at, b.s("signatureHex")))
        store.recordFirstSeen(domain, v.s("stkPubHex"))
        assertNull(pins.acceptBootKeyBinding(user, domain, boot, at, b.s("signedByOtherKeyHex")))
        assertEquals(boot, pins.acceptBootKeyBinding(user, domain, boot, at, b.s("signatureHex")))
        assertEquals("the boot key lives in the one pin store", boot, store.record(domain)?.boot)
        store.recordFirstSeen(domain, v.s("stkPubHex"))
        assertEquals("pinning the same key again keeps what it bound", boot, pins.pinnedBootKey(user, domain))
        pins.repin(user, domain, v.s("otherPubHex"))
        assertNull(pins.pinnedBootKey(user, domain))
        assertEquals(v.s("otherPubHex"), pins.require(user, domain, v.s("otherPubHex")))
        try { pins.require(user, domain, v.s("stkPubHex")); fail() } catch (_: BoxKeyChangedException) {}
        pins.forget(user, domain)
        assertNull(store.pinnedHex(domain))
        try { pins.require(user, domain, v.s("stkPubHex")); fail() } catch (_: ServerKeyNotPinnedException) {}
    }

    @Test fun theRelayResponderSealsNothingToASubstitutedKey() {
        val domain = "kitchen.alice.flagship.services"
        val issuedAt = 1_750_000_000_000L
        val real = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 5 })
        val rogue = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 6 })
        val rogueHex = HexUtil.encode(rogue.publicKey)
        val nonceHex = "ab".repeat(32)
        val (store, pins) = fresh()
        store.recordFirstSeen(domain, HexUtil.encode(real.publicKey))
        val sig = HexUtil.encode(Ed25519Sign(rogue.privateKey).sign(
            SecretRequest.canonicalBytes(domain, rogueHex, SecretPurpose.UNLOCK_KEY, nonceHex, issuedAt)))
        val mock = MockSecretMailboxClient().apply {
            directory = listOf(PodDirectoryEntry(serverDomain = domain, identityPubKey = rogueHex))
            pending = listOf(PendingSecretRequest(
                serverDomain = domain, requestNonceHex = nonceHex, stkPub = rogueHex, purpose = "unlock-key",
                issuedAt = issuedAt, requestSignature = sig, postedAt = issuedAt, expiresAt = issuedAt + 600_000))
            sealedLuksKeyHex = "00"
        }
        val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 7 })
        var unlockPrompts = 0
        val irk = object : IrkAccess {
            override suspend fun resolve(reason: String): IrkMaterial {
                if (reason.contains("boot secret")) unlockPrompts++
                return IrkMaterial(Ed25519Sign(irkKp.privateKey), ByteArray(32) { 7 }, HexUtil.encode(irkKp.publicKey))
            }
        }
        val c = SecretRequestCoordinator(
            mailbox = mock, username = "alice", irk = irk, now = { issuedAt }, pins = pins,
            firstContact = FirstContact(store, null),
        )
        assertTrue(runBlocking { c.fetchVerifiedRequests() }.isEmpty())
        val req = runBlocking { c.fetchRequests() }.single()
        assertEquals(FirstContactRefusal.KEY_CHANGED, req.refusal)
        try {
            runBlocking { c.confirmAndRespond(req) }
            fail("sealed to a substituted key")
        } catch (e: SecretRequestCoordinator.CoordinatorException.Refused) {
            assertEquals(FirstContactRefusal.KEY_CHANGED, e.reason)
        }
        assertEquals(0, unlockPrompts)
        assertTrue(mock.postedResponses.isEmpty())
        assertFalse(mock.secondBoot(domain))
    }
}
