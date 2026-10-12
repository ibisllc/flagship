// KnockAuthorizeViewModel — AID-signs a KnockAuthorization binding the browser's
// pageId, POSTs it to the box's /api/service-access/knock/authorize, maps
// 200/401/403/404, and persists a SecuredSession on success. Picks the signing
// identity by box: own server -> global AID; a box we were invited to -> the
// per-owner contact AID the invite bound; anything else -> nothing signed/sent.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.InMemoryInviteOwnerBook
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
import org.junit.Assert.assertFalse
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

    // Pinned from packages/protocol/tests/fixtures/serviceAccessGating.vectors.json
    // `contactAid`: the friend (UMK 0x16) invited by the author (UMK 0x0b).
    private val ownerAidHex = "b4b357bf622c86ea3b6c3e2440e2bf9e344ac3cf5f61236da8e6f280f93db640"
    private val contactAidHex = "086abb1c191c86e7cb68d4736f73c68f8b0c55c2a3fafa6a2c770fc308ab242a"

    private val persisted = ArrayList<SecuredSession>()
    private val signerCalls = ArrayList<String>()
    private var reloads = 0

    private fun makeVM(
        t: JsonHttpTransport,
        now: () -> Long = { 1700004000000L },
        ownServers: List<String> = listOf(serverId),
        owners: InMemoryInviteOwnerBook = InMemoryInviteOwnerBook(),
        reload: suspend () -> List<String> = { emptyList() },
    ) =
        KnockAuthorizeViewModel(
            serverId = serverId, svc = svc, serviceRef = serviceRef, pageId = pageId,
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            aidSigner = { signerCalls.add("global"); Ed25519Sign(aidKp.privateKey) },
            aidPubHex = { HexUtil.encode(aidPub) },
            contactAidSigner = { a, _ -> signerCalls.add("contact"); ServerKeys.deriveContactAccountId(umkSeed, a) },
            contactAidPubHex = { a, _ -> HexUtil.encode(ServerKeys.deriveContactAccountIdPub(umkSeed, a)) },
            ownServers = { ownServers },
            reloadOwnServers = { reloads += 1; reload() },
            owners = owners,
            now = now,
            persist = { persisted.add(it) },
        )

    private val okBody = """{"authorized":true,"secretId":"${"ab".repeat(32)}","serviceRef":"alice--notes","browserAgent":"Firefox","startedAt":1700004000000,"expiresAt":1700004000000}"""

    private fun assertSignedBy(t: KnockTransport, pub: ByteArray) {
        val body = t.lastBodyJson()!!
        val auth = body["authorization"]!!.jsonObject
        assertEquals(HexUtil.encode(pub), auth["visitorAID"]!!.jsonPrimitive.content)
        val sig = HexUtil.decode(body["signature"]!!.jsonPrimitive.content)!!
        val canonical = ServiceInvite.canonicalKnock(serverId, serviceRef, pageId, pub, 1700004000000L)
        Ed25519Verify(pub).verify(sig, canonical) // throws on mismatch
    }

    @Test fun invitedServer_signsWithContactAid() = runTest {
        val owners = InMemoryInviteOwnerBook().apply { remember(serverId, ownerAidHex) }
        val t = KnockTransport(status = 200, respBody = okBody)
        val vm = makeVM(t, ownServers = emptyList(), owners = owners)
        vm.authorize()
        assertTrue(vm.phase.value is KnockAuthorizePhase.Done)
        assertSignedBy(t, HexUtil.decode(contactAidHex)!!)
        assertFalse(t.lastBody!!.contains(HexUtil.encode(aidPub)))
        assertEquals(listOf("contact"), signerCalls)
        assertEquals(1, persisted.size)
    }

    @Test fun invitedServer_recordKeptUnderAppHost_matchesBox() = runTest {
        // An invite opened on `<app>.<box>` counts for the box.
        val owners = InMemoryInviteOwnerBook().apply { remember("Notes.$serverId", ownerAidHex.uppercase()) }
        val t = KnockTransport(status = 200, respBody = okBody)
        makeVM(t, ownServers = emptyList(), owners = owners).authorize()
        assertSignedBy(t, HexUtil.decode(contactAidHex)!!)
    }

    @Test fun ownServer_signsWithGlobalAid_evenWithAnInviteRecord() = runTest {
        val owners = InMemoryInviteOwnerBook().apply { remember(serverId, ownerAidHex) }
        val t = KnockTransport(status = 200, respBody = okBody)
        makeVM(t, ownServers = listOf(serverId.uppercase()), owners = owners).authorize()
        assertSignedBy(t, aidPub)
        assertEquals(listOf("global"), signerCalls)
    }

    @Test fun unknownServer_refusesAndSendsNothing() = runTest {
        val t = KnockTransport(status = 200, respBody = okBody)
        val owners = InMemoryInviteOwnerBook().apply { remember("other.bob.flagship.services", ownerAidHex) }
        val vm = makeVM(t, ownServers = listOf("home.carol.flagship.services"), owners = owners)
        vm.authorize()
        val p = vm.phase.value as KnockAuthorizePhase.Failed
        assertEquals(
            "This isn't one of your servers. Open its invite link on this phone first, then try again.",
            p.message,
        )
        assertNull(t.lastUrl)
        assertTrue(signerCalls.isEmpty())
        assertTrue(persisted.isEmpty())
        assertEquals(1, reloads)
    }

    @Test fun inviteRecordNamingOurOwnAid_isOurBox_signsWithGlobalAid() = runTest {
        val owners = InMemoryInviteOwnerBook().apply { remember(serverId, HexUtil.encode(aidPub)) }
        val t = KnockTransport(status = 200, respBody = okBody)
        val vm = makeVM(t, ownServers = emptyList(), owners = owners)
        vm.authorize()
        assertTrue(vm.phase.value is KnockAuthorizePhase.Done)
        assertSignedBy(t, aidPub)
        assertEquals(listOf("global"), signerCalls)
        assertEquals(0, reloads)
    }

    @Test fun coldStart_podsNotLoaded_reloadsOnceAndFindsOwnBox() = runTest {
        val t = KnockTransport(status = 200, respBody = okBody)
        val vm = makeVM(t, ownServers = emptyList(), reload = { listOf("other.alice.flagship.services", serverId.uppercase()) })
        vm.authorize()
        assertTrue(vm.phase.value is KnockAuthorizePhase.Done)
        assertEquals(1, reloads)
        assertSignedBy(t, aidPub)
        assertEquals(listOf("global"), signerCalls)
    }

    @Test fun coldStart_reloadStillUnknown_refusesAndSendsNothing() = runTest {
        val t = KnockTransport(status = 200, respBody = okBody)
        val vm = makeVM(t, ownServers = emptyList(), reload = { listOf("other.alice.flagship.services") })
        vm.authorize()
        assertEquals(KnockAuthorizeViewModel.NOT_YOURS, (vm.phase.value as KnockAuthorizePhase.Failed).message)
        assertEquals(1, reloads)
        assertNull(t.lastUrl)
        assertTrue(signerCalls.isEmpty())
    }

    @Test fun coldStart_reloadFails_refusesAndSendsNothing() = runTest {
        val t = KnockTransport(status = 200, respBody = okBody)
        val vm = makeVM(t, ownServers = emptyList(), reload = { error("offline") })
        vm.authorize()
        assertEquals(KnockAuthorizeViewModel.NOT_YOURS, (vm.phase.value as KnockAuthorizePhase.Failed).message)
        assertNull(t.lastUrl)
        assertTrue(signerCalls.isEmpty())
    }

    @Test fun knownBox_doesNotReloadPods() = runTest {
        val owners = InMemoryInviteOwnerBook().apply { remember(serverId, ownerAidHex) }
        makeVM(KnockTransport(status = 200, respBody = okBody), ownServers = emptyList(), owners = owners).authorize()
        makeVM(KnockTransport(status = 200, respBody = okBody)).authorize()
        assertEquals(0, reloads)
    }

    @Test fun wording_opensAppOnServer() {
        val vm = makeVM(KnockTransport(status = 200))
        assertEquals("Open notes on home?", vm.title)
        assertEquals("home", vm.serverName)
        assertEquals("notes.$serverId", vm.target)
    }

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
        assertTrue((vm.phase.value as KnockAuthorizePhase.Failed).message.contains("Refresh"))
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
            ownServers = { listOf(serverId) },
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
            ownServers = { listOf(serverId) },
            persist = { persisted.add(it) },
        )
        assertEquals(serverId, vm.target)
        assertEquals("Open home?", vm.title)
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
