// ServiceAccessViewModel (gating v2) — loads the true mode, toggles
// open/restricted (owner-IRK envelope), mints invites across the 3 tiers
// (AID-signed create, random inviteId, author AID in the link), lists (OWNER-
// SIGNED) + decrypts + folds groups, removes (AID revoke + owner-IRK box prune),
// and finalizes a manual-approve acceptance. Pins the wire shapes + endpoints.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.InviteLink
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.ServerKeys
import com.flagshipserver.app.core.ServiceInvite
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
    private val serviceRef = "alice--notes"
    private val username = "alice"

    // Deterministic author keys: IRK seed 9×32 (set-mode/allow-remove signer);
    // AID derived from the author UMK (create/revoke/list signer).
    private val irkKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ByteArray(32) { 9 })
    private val umkSeed = ByteArray(32) { 0x0b }
    private val aidPub = ServerKeys.deriveAccountIdPub(umkSeed)
    private val household = ServerKeys.deriveHouseholdKey(umkSeed)

    private fun makeVM(client: ServiceAccessClient, now: () -> Long = { 1700 }) =
        ServiceAccessViewModel(
            serverDomain = server, serviceRef = serviceRef, username = username, client = client,
            irkSigner = { Ed25519Sign(irkKp.privateKey) },
            aidSigner = { ServerKeys.deriveAccountId(umkSeed) },
            aidPubHex = { HexUtil.encode(aidPub) },
            householdKey = { household },
            now = now,
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
        // set-mode stays owner-IRK (box config-pinned IRK).
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        val bytes = ServiceInvite.canonicalSetAccessMode(server, serviceRef, "restricted", 1700)
        assertTrue(ServiceInvite.verify(sig, bytes, irkKp.publicKey))
    }

    @Test fun addPerson_auto_sealsAidSignsAndReturnsLinkWithAuthor() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        val link = vm.addPerson("Alex", null, InviteTier.PERSONAL_AUTO)
        assertNotNull(link)
        assertTrue(link!!.startsWith("https://$server/invite#"))
        // The author AID is embedded so the friend derives a per-author contact AID.
        assertEquals(HexUtil.encode(aidPub), InviteLink.authorAidFromLink(link))
        // An auto invite link carries NO inviteId (only the manual tier needs it).
        assertNull(InviteLink.inviteIdFromLink(link))

        assertTrue(t.lastPostUrl!!.endsWith("/api/users/$username/service-invites"))
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        val inviteId = req["inviteId"]!!.jsonPrimitive.content
        assertTrue(Regex("^[0-9a-f]{64}$").matches(inviteId)) // random 128-bit id
        assertEquals(HexUtil.encode(aidPub), req["authorAID"]!!.jsonPrimitive.content)
        assertEquals("auto", req["approvalMode"]!!.jsonPrimitive.content)
        assertNull(req["maxRedemptions"])
        val secretHash = req["secretHash"]!!.jsonPrimitive.content
        val encBundle = req["encryptedBundle"]!!.jsonPrimitive.content
        // create sig verifies under the AID over the exact (v1-shape) canonical bytes.
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        val bytes = ServiceInvite.canonicalCreate(inviteId, aidPub, serviceRef, secretHash, encBundle, 1700)
        assertTrue(ServiceInvite.verify(sig, bytes, aidPub))
        // the sealed bundle opens back to the name under the household key.
        assertEquals("Alex", ServiceInvite.openBundle(encBundle, household, inviteId).name)
    }

    @Test fun addPerson_manual_setsApprovalMode() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        val link = vm.addPerson("Sam", null, InviteTier.PERSONAL_MANUAL)
        val req = t.lastBodyJson()!!["request"]!!.jsonObject
        assertEquals("manual", req["approvalMode"]!!.jsonPrimitive.content)
        assertNull(req["maxRedemptions"])
        // The manual link MUST carry the inviteId (&i=) — the friend signs the
        // acceptance over it. It equals the created invite's id.
        val inviteId = req["inviteId"]!!.jsonPrimitive.content
        assertEquals(inviteId, InviteLink.inviteIdFromLink(link!!))
    }

    @Test fun addPerson_group_commitsMaxNAndExpiryInSignedBytes() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.addPerson("Chess club", null, InviteTier.GROUP, maxRedemptions = 10, expiresAt = 1700009999999L)
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        assertEquals("auto", req["approvalMode"]!!.jsonPrimitive.content)
        assertEquals(10, req["maxRedemptions"]!!.jsonPrimitive.content.toInt())
        assertEquals(1700009999999L, req["expiresAt"]!!.jsonPrimitive.content.toLong())
        // The caps ARE in the signed create bytes (maxN then exp appended).
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        val bytes = ServiceInvite.canonicalCreate(
            req["inviteId"]!!.jsonPrimitive.content, aidPub, serviceRef,
            req["secretHash"]!!.jsonPrimitive.content, req["encryptedBundle"]!!.jsonPrimitive.content,
            1700, 10, 1700009999999L,
        )
        assertTrue(ServiceInvite.verify(sig, bytes, aidPub))
    }

    @Test fun listPeople_isOwnerSignedAndDecrypts() = runTest {
        val id1 = "aa" + "0".repeat(62)
        val b1 = ServiceInvite.sealBundle(ServiceInvite.Bundle("Alex"), household, id1)
        val listJson = """{"invites":[
            {"inviteId":"$id1","serviceRef":"$serviceRef","encryptedBundle":"$b1","boundAID":"ff","boundAt":1,"createdAt":1}
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
        // The list GET carried the owner-signed query (authorAID/scope/sig).
        val getUrl = t.lastGetUrl!!
        assertTrue(getUrl.contains("authorAID=${HexUtil.encode(aidPub)}"))
        assertTrue(getUrl.contains("scope=list"))
        assertTrue(getUrl.contains("sig="))
    }

    @Test fun listPeople_foldsGroupToOneRow() = runTest {
        val gid = "cc" + "0".repeat(62)
        val gb = ServiceInvite.sealBundle(ServiceInvite.Bundle("Chess club"), household, gid)
        val listJson = """{"invites":[
            {"inviteId":"$gid","serviceRef":"$serviceRef","encryptedBundle":"$gb","createdAt":1,
             "maxRedemptions":10,"redemptions":2,"boundAIDs":["aa11","bb22"],"approvalMode":"auto"}
        ]}"""
        val t = FakeTransport(getJsonByUrl = mapOf(
            "service-access" to """{"mode":"restricted","allowCount":2}""",
            "service-invites" to listJson,
        ))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        vm.load()
        assertEquals(1, vm.people.value.size)
        val g = vm.people.value[0]
        assertTrue(g.isGroup)
        assertEquals("Chess club", g.name)
        assertEquals(2, g.redemptions)
        assertEquals(10, g.maxRedemptions)
        assertEquals(listOf("aa11", "bb22"), g.memberAids)
    }

    @Test fun remove_signsAidRevoke() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.remove("deadbeef")
        assertTrue(t.lastPostUrl!!.endsWith("/api/users/$username/service-invites/revoke"))
        val env = t.lastBodyJson()!!
        val req = env["request"]!!.jsonObject
        assertEquals("deadbeef", req["inviteId"]!!.jsonPrimitive.content)
        // revoke now AID-signed (v2).
        val sig = HexUtil.decode(env["signature"]!!.jsonPrimitive.content)!!
        assertTrue(ServiceInvite.verify(sig, ServiceInvite.canonicalRevoke("deadbeef", 1700), aidPub))
    }

    @Test fun remove_withBoundAid_firesBoxPruneAndComRevoke() = runTest {
        val aid = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c"
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.remove("deadbeef", aid)

        // .com revoke fired (author-AID over canonicalRevoke).
        val revokeBody = t.bodyJsonFor("/api/users/$username/service-invites/revoke")!!
        val revokeSig = HexUtil.decode(revokeBody["signature"]!!.jsonPrimitive.content)!!
        assertTrue(ServiceInvite.verify(revokeSig, ServiceInvite.canonicalRevoke("deadbeef", 1700), aidPub))

        // Box allow-remove ALSO fired (owner-IRK over canonicalRemoveServiceAllow).
        val pruneBody = t.bodyJsonFor("/api/service-access/allow-remove")!!
        val pruneReq = pruneBody["request"]!!.jsonObject
        assertEquals(aid, pruneReq["aid"]!!.jsonPrimitive.content)
        val pruneSig = HexUtil.decode(pruneBody["signature"]!!.jsonPrimitive.content)!!
        assertTrue(ServiceInvite.verify(pruneSig, ServiceInvite.canonicalRemoveServiceAllow(server, serviceRef, aid, 1700), irkKp.publicKey))
    }

    @Test fun remove_group_prunesEveryMember() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.remove("gid", boundAidHex = null, memberAids = listOf("aa11", "bb22"))
        // .com revoke + a box prune for EACH member AID.
        assertNotNull(t.bodyJsonFor("/api/users/$username/service-invites/revoke"))
        val prunes = t.posts.filter { it.first.contains("/api/service-access/allow-remove") }
            .mapNotNull { it.second?.let { b -> Json.parseToJsonElement(b).jsonObject } }
            .map { it["request"]!!.jsonObject["aid"]!!.jsonPrimitive.content }
        assertEquals(setOf("aa11", "bb22"), prunes.toSet())
    }

    @Test fun removeGroupMember_prunesOne() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.removeGroupMember("aa11")
        // No .com revoke for a per-member removal; just the box prune.
        assertNull(t.bodyJsonFor("/api/users/$username/service-invites/revoke"))
        val pruneBody = t.bodyJsonFor("/api/service-access/allow-remove")!!
        assertEquals("aa11", pruneBody["request"]!!.jsonObject["aid"]!!.jsonPrimitive.content)
    }

    @Test fun remove_unredeemed_skipsBoxPrune() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        vm.remove("deadbeef", null)
        assertNotNull(t.bodyJsonFor("/api/users/$username/service-invites/revoke"))
        assertNull(t.bodyJsonFor("/api/service-access/allow-remove"))
    }

    @Test fun finalizeAcceptance_submitsOnlyTheAcceptance() = runTest {
        // Build a canonical acceptance reply (as the friend's app would) + feed it.
        val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val accept: JsonObject = buildJsonObject {
            put("inviteId", JsonPrimitive(iid))
            put("serviceRef", JsonPrimitive(serviceRef))
            put("contactAID", JsonPrimitive("c".repeat(64)))
            put("acceptedAt", JsonPrimitive(1700L))
        }
        val reply = InviteLink.buildAcceptReply("home.alice.flagship.services", accept, "a".repeat(128))
        val t = FakeTransport(postBody = """{"bound":true,"serviceRef":"$serviceRef","boundAID":"${"c".repeat(64)}"}""")
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t), now = { 1700 })
        val ok = vm.finalizeAcceptance(reply)
        assertTrue(ok)
        val submitted = t.bodyJsonFor("/api/service-access/accept")!!
        assertEquals(iid, submitted["accept"]!!.jsonObject["inviteId"]!!.jsonPrimitive.content)
        assertEquals("a".repeat(128), submitted["acceptSig"]!!.jsonPrimitive.content)
        // NO create / createSig — the box fetches the signed create from .com.
        assertNull(submitted["create"])
        assertNull(submitted["createSig"])
    }

    @Test fun finalizeAcceptance_malformed_failsBeforeNetwork() = runTest {
        val t = FakeTransport()
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        val ok = vm.finalizeAcceptance("not-an-acceptance")
        assertFalse(ok)
        assertNull(t.bodyJsonFor("/api/service-access/accept"))
        assertTrue(vm.phase.value is ServiceAccessPhase.Failed)
    }

    @Test fun setMode_failureSurfaces() = runTest {
        val t = FakeTransport(failPost = RuntimeException("403"))
        val vm = makeVM(ServiceAccessClient(boxTransport = t, comTransport = t))
        val ok = vm.setMode(restricted = true)
        assertFalse(ok)
        assertTrue(vm.phase.value is ServiceAccessPhase.Failed)
    }

    /** Records POSTs (url+body); serves canned GET JSON keyed by a url substring;
     *  records the last GET url; can fail POSTs. */
    class FakeTransport(
        private val getJsonByUrl: Map<String, String> = emptyMap(),
        private val failPost: Throwable? = null,
        private val failPostFor: String? = null,
        private val postStatus: Int = 200,
        private val postBody: String = "{}",
    ) : JsonHttpTransport {
        override val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        var lastPostUrl: String? = null
        var lastPostBody: String? = null
        var lastGetUrl: String? = null
        val posts = mutableListOf<Pair<String, String?>>()
        fun lastBodyJson(): JsonObject? = lastPostBody?.let { json.parseToJsonElement(it).jsonObject }
        fun bodyJsonFor(urlPart: String): JsonObject? =
            posts.firstOrNull { it.first.contains(urlPart) }?.second?.let { json.parseToJsonElement(it).jsonObject }

        override suspend fun execute(method: String, url: String, body: ByteArray?, contentType: String?, extraHeaders: Map<String, String>, accept: Set<Int>): HttpResponse {
            if (method == "GET") {
                lastGetUrl = url
                val canned = getJsonByUrl.entries.firstOrNull { url.contains(it.key) }?.value ?: "{}"
                return HttpResponse(200, canned.toByteArray(), emptyMap())
            }
            failPost?.let { throw it }
            failPostFor?.let { if (url.contains(it)) throw RuntimeException("403 $it") }
            lastPostUrl = url
            lastPostBody = body?.let { String(it, Charsets.UTF_8) }
            posts.add(url to lastPostBody)
            return HttpResponse(postStatus, postBody.toByteArray(), emptyMap())
        }
        override suspend fun <T> postJson(url: String, body: T, serializer: KSerializer<T>, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
        override suspend fun <T, R> postJsonForResponse(url: String, body: T, serializer: KSerializer<T>, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun <R> getJson(url: String, responseSerializer: KSerializer<R>, extraHeaders: Map<String, String>): R = error("unused")
        override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) = error("unused")
    }
}
