package com.flagshipserver.app.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/** docs/first-contact.md: the first blessing's decision, against the shared enrollment vectors. */
class FirstContactTest {
    private val v: JsonObject by lazy {
        val rel = "packages/protocol/test-vectors/enrollment/vectors.json"
        var dir: File? = File(System.getProperty("user.dir")!!).absoluteFile
        while (dir != null) {
            val f = File(dir, rel)
            if (f.isFile) return@lazy Json.parseToJsonElement(f.readText()).jsonObject
            dir = dir.parentFile
        }
        fail("vectors.json not found"); throw IllegalStateException()
    }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private val first get() = v["proofs"]!!.jsonArray[0].jsonObject
    private val st get() = first["statement"]!!.jsonObject
    private val domain get() = st.s("serverDomain")
    private val key get() = st.s("stkPubHex")
    private val serial get() = st.s("authCodeSerial")

    private val pinStore = InMemoryServerKeyPinStore()
    private val pins = ServerKeyPins(pinStore)
    private val secrets = InMemoryEnrollmentSecretStore()
    private var seen: List<ServerSeen> = emptyList()
    private val fc = FirstContact(pins, secrets, studioSeen = { seen })

    /** The vector keys have no private half: the request's own signature check is stubbed here. */
    private fun judge(
        stk: String = key,
        purpose: SecretPurpose = SecretPurpose.ENTITLEMENT,
        proof: String? = first.s("proofHex"),
        signed: Boolean = true,
    ) = runBlocking { fc.judge(domain, stk, purpose, { _, _ -> signed }, proof) }

    private fun created(studioKeyHex: String? = null) =
        secrets.put(domain, EnrollmentRecord(v.s("secretHex"), serial, studioKeyHex))

    @Test fun theCodeIsComputedHereFromTheKeyLikeTheVectors() {
        for (c in v["codes"]!!.jsonArray) {
            assertEquals(c.jsonObject.s("code"), Enrollment.serverCode(c.jsonObject.s("stkPubHex")))
        }
        val look = (judge() as FirstContact.Verdict.FirstSight).look
        assertEquals(Enrollment.serverCode(key), look.code)
        assertEquals(look.code.substring(0, 3) + " " + look.code.substring(3), look.spacedCode)
    }

    @Test fun theCreatingDevicePinsOnlyWithAProofThatVerifies() {
        created()
        val sight = judge() as FirstContact.Verdict.FirstSight
        assertTrue(sight.look.proven)
        assertTrue(sight.pinOnApprove)
        assertNull("nothing is pinned before Approve", pins.pinnedHex(domain))
        fc.pin(sight.look)
        assertEquals(key, pins.pinnedHex(domain))
        assertNull("the secret is deleted once pinned", secrets.get(domain))
        assertEquals(FirstContact.Verdict.Pinned(key), judge())
    }

    @Test fun aMissingOrWrongProofIsRefusedWhenThisDeviceHoldsTheSecret() {
        created()
        assertEquals(FirstContactRefusal.NOT_FROM_RECIPE, (judge(proof = null) as FirstContact.Verdict.Refused).reason)
        val firstProof = first.s("proofHex")
        // The first proof presented for each invalid statement (another server, key or install code).
        for (bad in v["invalid"]!!.jsonArray) {
            val s = bad.jsonObject["statement"]!!.jsonObject
            val store = InMemoryEnrollmentSecretStore().apply { put(s.s("serverDomain"), EnrollmentRecord(v.s("secretHex"), s.s("authCodeSerial"))) }
            val r = runBlocking {
                FirstContact(ServerKeyPins(InMemoryServerKeyPinStore()), store) { emptyList() }
                    .judge(s.s("serverDomain"), s.s("stkPubHex"), SecretPurpose.ENTITLEMENT, { _, _ -> true }, firstProof)
            }
            assertEquals(bad.jsonObject.s("name"), FirstContactRefusal.NOT_FROM_RECIPE, (r as FirstContact.Verdict.Refused).reason)
        }
        assertEquals(FirstContactRefusal.NOT_FROM_RECIPE, (judge(proof = "00".repeat(32)) as FirstContact.Verdict.Refused).reason)
        assertNull(pins.pinnedHex(domain))
        assertTrue("the secret is kept until a real proof", secrets.get(domain) != null)
    }

    @Test fun aDeviceWithoutTheSecretPinsOnFirstSightWithTheCode() {
        val sight = judge(proof = null) as FirstContact.Verdict.FirstSight
        assertFalse(sight.look.proven)
        assertTrue(sight.pinOnApprove)
        val unlock = judge(purpose = SecretPurpose.UNLOCK_KEY, proof = null) as FirstContact.Verdict.FirstSight
        assertTrue("an existing server pins at its next approval, an unlock too", unlock.pinOnApprove)
    }

    @Test fun anUnlockFromAServerThisDeviceCreatedWaitsForTheProof() {
        created()
        val sight = judge(purpose = SecretPurpose.UNLOCK_KEY, proof = null) as FirstContact.Verdict.FirstSight
        assertFalse("its entitlement request carries the proof and pins", sight.pinOnApprove)
    }

    @Test fun afterThePinAnotherKeyIsRefusedAndThePinStays() {
        pins.recordFirstSeen(domain, key)
        val other = "cd".repeat(32)
        val r = judge(stk = other) as FirstContact.Verdict.Refused
        assertEquals(FirstContactRefusal.KEY_CHANGED, r.reason)
        assertEquals("This server's key changed. If you did not rebuild it, do not approve anything for it.", r.reason.message())
        assertEquals(key, pins.pinnedHex(domain))
        val look = FirstLook(domain.lowercase(), other, Enrollment.serverCode(other)!!, false, false)
        assertTrue(runCatching { fc.pin(look) }.exceptionOrNull() is ServerKeyChangedException)
        assertEquals(ServerKeyPins.Record.AlreadyPinned, pins.recordFirstSeen(domain, key))
        pins.forget(domain)
        assertEquals(ServerKeyPins.Record.Recorded, pins.recordFirstSeen(domain, other))
    }

    @Test fun aRequestNotSignedByTheKeyItNamesIsDropped() {
        assertEquals(FirstContact.Verdict.Invalid, judge(signed = false))
        pins.recordFirstSeen(domain, key)
        assertEquals(FirstContact.Verdict.Invalid, judge(signed = false))
        assertEquals(FirstContact.Verdict.Invalid, judge(stk = "zz"))
    }

    @Test fun studioConfirmsOnlyTheKeyItSawUnderTheKeptKey() {
        val sk = ByteArray(32) { 0x51 }
        created(HexUtil.encode(sk))
        seen = listOf(ServerSeen(key, StudioConfirm.macHex(sk, domain, key)!!))
        assertTrue((judge() as FirstContact.Verdict.FirstSight).look.studioConfirmed)
        // Upper-case domain and key in the report are the same statement.
        assertEquals(StudioConfirm.macHex(sk, domain.uppercase(), key), StudioConfirm.macHex(sk, domain.lowercase(), key))
        seen = listOf(ServerSeen(key, "00".repeat(32)))
        assertFalse("a wrong MAC is ignored", (judge() as FirstContact.Verdict.FirstSight).look.studioConfirmed)
        val other = "cd".repeat(32)
        seen = listOf(ServerSeen(other, StudioConfirm.macHex(sk, domain, other)!!))
        assertFalse("Studio saw another key", (judge() as FirstContact.Verdict.FirstSight).look.studioConfirmed)
        seen = listOf(ServerSeen(key, StudioConfirm.macHex(ByteArray(32) { 1 }, domain, key)!!))
        assertFalse("not under the kept key", (judge() as FirstContact.Verdict.FirstSight).look.studioConfirmed)
        // Up to 4 reports, newest last: any one that verifies and names this key confirms it.
        seen = listOf(
            ServerSeen(other, StudioConfirm.macHex(sk, domain, other)!!),
            ServerSeen(key, "00".repeat(32)),
            ServerSeen(key, StudioConfirm.macHex(sk, domain, key)!!),
        )
        assertTrue((judge() as FirstContact.Verdict.FirstSight).look.studioConfirmed)
    }

    @Test fun studioMacIsHmacOfTheTaggedStatement() {
        val k = ByteArray(32) { 0x51 }
        val mac = javax.crypto.Mac.getInstance("HmacSHA256").apply { init(javax.crypto.spec.SecretKeySpec(k, "HmacSHA256")) }
        val want = HexUtil.encode(mac.doFinal("flagship/server-code-seen/v1|home.alice.flagship.services|$key".toByteArray()))
        assertEquals(want, StudioConfirm.macHex(k, "Home.Alice.flagship.services", key))
        assertNull(StudioConfirm.macHex(k, "a|b", key))
        assertNull(StudioConfirm.macHex(ByteArray(31), domain, key))
    }

    @Test fun aNewRecipeKeepsAFreshSecretAndStudioKey() {
        val store = InMemoryEnrollmentSecretStore()
        val a = FirstContact.newEnrollment(store, "home.alice.flagship.services", "AC-1", withStudioKey = true)
        val b = FirstContact.newEnrollment(store, "home.alice.flagship.services", "AC-2", withStudioKey = false)
        assertTrue(a.secretHex != b.secretHex)
        assertEquals(64, a.secretHex.length)
        assertEquals(64, a.studioConfirmKeyHex!!.length)
        assertNull(b.studioConfirmKeyHex)
        assertEquals(b, store.get("Home.Alice.flagship.services"))
    }
}
