// ServiceAccessViewModel — loads the true mode from the box, toggles
// open/restricted (owner-IRK envelope verifies against the canonical bytes),
// mints invites (deterministic inviteId + sealed bundle, signed create to .com),
// lists+decrypts, revokes. Pins the wire shapes + endpoints + phases.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceAccessViewModelTest {
    private val server = "home.alice.flagship.services"
    private val serviceRef = "alice-notes"
    private val username = "alice"

    // Deterministic author keys: IRK seed 9×32, AID derived from a UMK seed.
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val umkSeed = ByteArray(32) { 0x0b }
    private val aidPub = ServerKeys.deriveAccountIdPub(umkSeed)
    private val household = ServerKeys.deriveHouseholdKey(umkSeed)
    private val devicePub = irkKp.publicKey

    private fun makeVM(client: ServiceAccessClient, now: () -> Long = { 1700 }, counter: () -> Int = { 0 }) =
        ServiceAccessViewModel(
            serverDomain = server, serviceRef = serviceRef, username = username, client = client,
            irkSigner = { Ed25519Sign(irkKp.privateKey) },
            devicePubHex = { HexUtil.encode(devicePub) },
            aidPubHex = { HexUtil.encode(aidPub) },
            householdKey = { household },
            now = now, counter = counter,
        )

    @Test fun load_readsTrueMode() = runTest {
        val t = FakeTransport(getJsonByUrl = mapOf("service-access" to """{"mode":"restricted","allowCount":3}"""))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        vm.load()
        assertTrue(vm.phase.value is ServiceAccessPhase.Ready)
        assertTrue(vm.restricted.value)
        assertEquals(3, vm.allowCount.value)
    }

    @Test fun setMode_signsValidEnvelope() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        val ok = vm.setMode(restricted = true)
        assertTrue(ok)
        assertTrue(vm.restricted.value)
        assertEquals("https://$server/api/service-access", t.lastPostUrl)
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        assertEquals(serviceRef, req["serviceRef"]!!.jsonPrimitive.content)
        assertEquals("restricted", req["mode"]!!.jsonPrimitive.content)
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        val bytes = ServiceInvite.canonicalSetAccessMode(server, serviceRef, "restricted", 1700)
        assertTrue(ServiceInvite.verify(sig, bytes, irkKp.publicKey))
    }

    @Test fun addPerson_sealsSignsAndReturnsLink() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 }, counter = { 0 })
        val link = vm.addPerson("Alex", null)
        assertNotNull(link)
        assertTrue(link!!.startsWith("https://$server/invite#"))
        val frag = link.substringAfter("#")
        assertEquals(64, frag.length)
        assertNotNull(HexUtil.decode(frag))

        assertTrue(t.lastPostUrl!!.endsWith("/api/users/$username/service-invites"))
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        val expectedId = ServiceInvite.inviteId(aidPub, devicePub, 0)
        assertEquals(expectedId, req["inviteId"]!!.jsonPrimitive.content)
        assertEquals(HexUtil.encode(aidPub), req["authorAID"]!!.jsonPrimitive.content)
        assertEquals(serviceRef, req["serviceRef"]!!.jsonPrimitive.content)
        assertEquals(ServiceInvite.secretHash(HexUtil.decode(frag)!!), req["secretHash"]!!.jsonPrimitive.content)
        val encBundle = req["encryptedBundle"]!!.jsonPrimitive.content
        // create sig verifies under the IRK over the exact canonical bytes.
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        val bytes = ServiceInvite.canonicalCreate(expectedId, aidPub, serviceRef, req["secretHash"]!!.jsonPrimitive.content, encBundle, 1700)
        assertTrue(ServiceInvite.verify(sig, bytes, irkKp.publicKey))
        // the sealed bundle opens back to the name under the household key.
        val opened = ServiceInvite.openBundle(encBundle, household, expectedId)
        assertEquals("Alex", opened.name)
        assertNull(opened.photo)
    }

    @Test fun listPeople_decryptsAndFiltersRevoked() = runTest {
        val id1 = "aa" + "0".repeat(62)
        val id2 = "bb" + "0".repeat(62)
        val b1 = ServiceInvite.sealBundle(ServiceInvite.Bundle("Alex"), household, id1)
        val b2 = ServiceInvite.sealBundle(ServiceInvite.Bundle("Sam"), household, id2)
        val listJson = """{"invites":[
            {"inviteId":"$id1","serviceRef":"$serviceRef","encryptedBundle":"$b1","boundAID":"ff","boundAt":1,"createdAt":1},
            {"inviteId":"$id2","serviceRef":"$serviceRef","encryptedBundle":"$b2","createdAt":2,"revokedAt":99}
        ]}"""
        val t = FakeTransport(getJsonByUrl = mapOf(
            "service-access" to """{"mode":"restricted","allowCount":1}""",
            "service-invites" to listJson,
        ))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        vm.load()
        assertEquals(1, vm.people.value.size)
        assertEquals("Alex", vm.people.value[0].name)
        assertTrue(vm.people.value[0].bound)
    }

    @Test fun remove_signsRevoke() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.remove("deadbeef")
        assertTrue(t.lastPostUrl!!.endsWith("/api/users/$username/service-invites/revoke"))
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        assertEquals("deadbeef", req["inviteId"]!!.jsonPrimitive.content)
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        assertTrue(ServiceInvite.verify(sig, ServiceInvite.canonicalRevoke("deadbeef", 1700), irkKp.publicKey))
    }

    @Test fun setMode_failureSurfaces() = runTest {
        val t = FakeTransport(failPost = RuntimeException("403"))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        val ok = vm.setMode(restricted = true)
        assertFalse(ok)
        assertTrue(vm.phase.value is ServiceAccessPhase.Failed)
    }

    /** Records the last POST url+body; serves canned GET JSON keyed by a url
     *  substring; can fail POSTs. */
    class FakeTransport(
        private val getJsonByUrl: Map<String, String> = emptyMap(),
        private val failPost: Throwable? = null,
        private val postStatus: Int = 200,
        private val postBody: String = "{}",
    ) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        var lastPostUrl: String? = null
        var lastPostBody: String? = null
        fun lastBodyJson(): JsonObject? = lastPostBody?.let { json.parseToJsonElement(it).jsonObject }

        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            if (method == "GET") {
                val canned = getJsonByUrl.entries.firstOrNull { url.contains(it.key) }?.value ?: "{}"
                return HttpResponse(200, canned.toByteArray(), emptyMap())
            }
            failPost?.let { throw it }
            lastPostUrl = url
            lastPostBody = body?.let { String(it, Charsets.UTF_8) }
            return HttpResponse(postStatus, postBody.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
