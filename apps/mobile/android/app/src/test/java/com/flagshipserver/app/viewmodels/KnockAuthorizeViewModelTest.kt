// KnockAuthorizeViewModel — AID-signs a KnockAuthorization binding the browser's
// pageId, POSTs it to the box's /api/service-access/knock/authorize, maps
// 200/401/403/404, and persists a SecuredSession on success.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.SecuredSession
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KnockAuthorizeViewModelTest {
    private val serverId = "home.alice.flagship.services"
    private val svc = "notes"
    private val serviceRef = "alice--notes"
    private val pageId = "cb2421036efeb738c6017d8ee92e7b89"
    private val umkSeed = ByteArray(32) { 0x16 }
    private val aidKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ServerKeys.deriveAccountIdSeed(umkSeed))
    private val aidPub = ServerKeys.deriveAccountIdPub(umkSeed)

    private val persisted = ArrayList<SecuredSession>()

    private fun makeVM(t: JsonHttpTransport, now: () -> Long = { 1700004000000L }) =
        KnockAuthorizeViewModel(
            serverId = serverId, svc = svc, serviceRef = serviceRef, pageId = pageId,
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            aidSigner = { Ed25519Sign(aidKp.privateKey) },
            aidPubHex = { HexUtil.encode(aidPub) },
            now = now,
            persist = { persisted.add(it) },
        )

    @Test fun authorize_signsPageIdBoundEnvelope_andPersistsSession() = runTest {
        val t = KnockTransport(
            status = 200,
            respBody = """{"authorized":true,"secretId":"${"ab".repeat(32)}","serviceRef":"alice--notes","browserAgent":"Firefox","startedAt":1700004000000,"expiresAt":1700004000000}""",
        )
        val vm = makeVM(t)
        vm.authorize()
        val p = vm.phase.value
        assertTrue(p is KnockAuthorizePhase.Done)
        p as KnockAuthorizePhase.Done
        assertEquals("alice--notes", p.serviceRef)
        assertEquals("Firefox", p.browserAgent)
        // POSTed to the box's knock authorize endpoint.
        assertTrue(t.lastUrl!!.endsWith("/api/service-access/knock/authorize"))
        val body = t.lastBodyJson()!!
        val auth = body["authorization"]!!.jsonObject
        assertEquals(serverId, auth["serverId"]!!.jsonPrimitive.content)
        assertEquals(serviceRef, auth["serviceRef"]!!.jsonPrimitive.content)
        assertEquals(pageId, auth["pageId"]!!.jsonPrimitive.content)
        assertEquals(HexUtil.encode(aidPub), auth["visitorAID"]!!.jsonPrimitive.content)
        // The signature verifies over the EXACT canonical knock bytes.
        val sig = HexUtil.decode(body["signature"]!!.jsonPrimitive.content)!!
        val canonical = ServiceInvite.canonicalKnock(serverId, serviceRef, pageId, aidPub, 1700004000000L)
        Ed25519Verify(aidPub).verify(sig, canonical) // throws on mismatch
        // SecuredSession persisted with the box-returned secretId + derived URL.
        assertEquals(1, persisted.size)
        assertEquals("ab".repeat(32), persisted[0].secretId)
        assertEquals("https://notes.$serverId", persisted[0].serviceUrl)
        assertEquals("Firefox", persisted[0].browserAgent)
    }

    @Test fun notAllowed401() = runTest {
        val vm = makeVM(KnockTransport(status = 401))
        vm.authorize()
        val p = vm.phase.value
        assertTrue(p is KnockAuthorizePhase.Failed)
        assertTrue((p as KnockAuthorizePhase.Failed).message.contains("don't have access"))
        assertTrue(persisted.isEmpty())
    }

    @Test fun refused403() = runTest {
        val vm = makeVM(KnockTransport(status = 403))
        vm.authorize()
        assertTrue((vm.phase.value as KnockAuthorizePhase.Failed).message.contains("refreshing"))
    }

    @Test fun pageExpired404() = runTest {
        val vm = makeVM(KnockTransport(status = 404))
        vm.authorize()
        assertTrue((vm.phase.value as KnockAuthorizePhase.Failed).message.contains("expired"))
    }

    @Test fun emptyPageId_rejectedBeforeNetwork() = runTest {
        val t = KnockTransport(status = 200)
        val vm = KnockAuthorizeViewModel(
            serverId = serverId, svc = svc, serviceRef = serviceRef, pageId = "",
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            aidSigner = { Ed25519Sign(aidKp.privateKey) },
            aidPubHex = { HexUtil.encode(aidPub) },
            persist = { persisted.add(it) },
        )
        vm.authorize()
        assertTrue(vm.phase.value is KnockAuthorizePhase.Failed)
        assertNull(t.lastUrl)
    }

    @Test fun target_apexServiceHasNoLabel() = runTest {
        val t = KnockTransport(status = 200, respBody = """{"secretId":"${"cd".repeat(32)}","serviceRef":"alice--notes","browserAgent":"","startedAt":0,"expiresAt":0}""")
        val vm = KnockAuthorizeViewModel(
            serverId = serverId, svc = "", serviceRef = serviceRef, pageId = pageId,
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            aidSigner = { Ed25519Sign(aidKp.privateKey) },
            aidPubHex = { HexUtil.encode(aidPub) },
            persist = { persisted.add(it) },
        )
        assertEquals(serverId, vm.target)
        vm.authorize()
        assertEquals("https://$serverId", persisted.last().serviceUrl)
    }

    /** Records the authorize POST + returns a configurable status/body. */
    class KnockTransport(private val status: Int, private val respBody: String = "{}") : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true }
        var lastUrl: String? = null
        var lastBody: String? = null
        fun lastBodyJson(): JsonObject? = lastBody?.let { json.parseToJsonElement(it).jsonObject }
        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            lastUrl = url; lastBody = body?.let { String(it, Charsets.UTF_8) }
            return HttpResponse(status, respBody.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
