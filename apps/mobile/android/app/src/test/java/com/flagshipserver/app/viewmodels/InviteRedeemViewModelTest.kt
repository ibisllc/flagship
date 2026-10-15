// InviteRedeemViewModel (gating v2) — redeems with the friend's PER-AUTHOR
// contact AID (derived from the author AID carried in the link), falling back to
// the global AID for a legacy link; POSTs the RAW secret to the box's redeem
// endpoint; maps 404/409/403/410; on a MANUAL-approve {pending} response emits a
// contact-AID-signed acceptance reply for the friend to send back to the author.

package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.api.ServiceAccessClient
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpResponse
import com.flagshipserver.app.core.InMemoryInviteOwnerBook
import com.flagshipserver.app.core.InviteLink
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InviteRedeemViewModelTest {
    private val server = "home.alice.flagship.services"
    private val secret = "07".repeat(32) // 64-hex
    private val friendUmk = ByteArray(32) { 0x16 }
    private val authorUmk = ByteArray(32) { 0x0b }
    private val authorAidPub = ServerKeys.deriveAccountIdPub(authorUmk)
    private val authorAidHex = HexUtil.encode(authorAidPub)
    // The friend's id for the invite's app (the redemption identity).
    private val contactPub = ServerKeys.deriveAppAccountIdPub(friendUmk, "alice--notes")
    private val globalPub = ServerKeys.deriveAccountIdPub(friendUmk)

    private val owners = InMemoryInviteOwnerBook()

    private fun makeVM(t: JsonHttpTransport, authorHex: String? = authorAidHex, inviteIdHex: String? = null, secretHex: String = secret, now: () -> Long = { 1700 }, serverDomain: String = server, serviceRef: String? = "alice--notes") =
        InviteRedeemViewModel(
            serverDomain = serverDomain, secretHex = secretHex, authorAidHex = authorHex, inviteIdHex = inviteIdHex,
            serviceRef = serviceRef,
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            appAidSigner = { ref, _ -> ServerKeys.deriveAppAccountId(friendUmk, ref) },
            appAidPubHex = { ref, _ -> HexUtil.encode(ServerKeys.deriveAppAccountIdPub(friendUmk, ref)) },
            now = now,
            owners = owners,
        )

    @Test fun redeem_usesContactAid_andPostsRawSecret() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice--notes","boundAID":"${HexUtil.encode(contactPub)}","firstBind":true}""")
        val vm = makeVM(t)
        vm.redeem()
        val p = vm.phase.value
        assertTrue(p is InviteRedeemPhase.Done)
        p as InviteRedeemPhase.Done
        assertEquals("alice--notes", p.serviceRef)
        assertTrue(p.firstBind)
        assertTrue(t.lastUrl!!.endsWith("/api/service-invites/redeem"))
        val body = t.lastBodyJson()!!
        assertEquals(secret, body["secret"]!!.jsonPrimitive.content) // RAW secret
        // The friend's id for the app is presented as visitorAID, NOT the global AID.
        assertEquals(HexUtil.encode(contactPub), body["visitorAID"]!!.jsonPrimitive.content)
        assertTrue(HexUtil.encode(globalPub) != body["visitorAID"]!!.jsonPrimitive.content)
        // and the AID sig verifies over the contact-AID redeem bytes.
        val secretHash = ServiceInvite.secretHash(HexUtil.decode(secret)!!)
        val sig = HexUtil.decode(body["aidSig"]!!.jsonPrimitive.content)!!
        assertTrue(ServiceInvite.verify(sig, ServiceInvite.canonicalRedeem(secretHash, contactPub, 1700), contactPub))
    }

    @Test fun redeem_linkWithoutApp_isRefusedBeforeNetwork() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice--notes","firstBind":true}""")
        val vm = makeVM(t, serviceRef = null)
        vm.redeem()
        assertEquals(InviteRedeemPhase.Failed(InviteRedeemViewModel.OLD_LINK), vm.phase.value)
        assertNull(t.lastUrl)
        val bad = makeVM(t, serviceRef = "Alice Notes")
        bad.redeem()
        assertEquals(InviteRedeemPhase.Failed(InviteRedeemViewModel.OLD_LINK), bad.phase.value)
    }

    @Test fun redeem_usesTheIdForTheLinksApp() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice--chess","firstBind":true}""")
        makeVM(t, serviceRef = "alice--chess").redeem()
        assertEquals(
            HexUtil.encode(ServerKeys.deriveAppAccountIdPub(friendUmk, "alice--chess")),
            t.lastBodyJson()!!["visitorAID"]!!.jsonPrimitive.content,
        )
    }

    @Test fun redeem_manualPending_emitsAcceptanceReply() = runTest {
        // The box returns {pending} + the owner's relayed create (used only to
        // learn the inviteId/serviceRef to sign over — NOT shipped in the reply).
        val iid = "ea4ab8be66710610842cf6ef0d7e56bd91a4f03c7a5633fde4a66482cc292890"
        val create = """{"inviteId":"$iid","authorAID":"$authorAidHex","serviceRef":"alice--notes","secretHash":"${"d".repeat(64)}","encryptedBundle":"00","issuedAt":1500}"""
        val t = RedeemTransport(status = 200, respBody = """{"pending":true,"approvalMode":"manual","serviceRef":"alice--notes","create":$create,"createSig":"${"b".repeat(128)}"}""")
        val vm = makeVM(t)
        vm.redeem()
        val p = vm.phase.value
        assertTrue(p is InviteRedeemPhase.AwaitingApproval)
        p as InviteRedeemPhase.AwaitingApproval
        assertEquals("alice--notes", p.serviceRef)
        // Canonical reply form (cross-client) carrying ONLY {accept, acceptSig}.
        assertTrue(p.replyLink.startsWith("https://flagshipserver.com/invite-accept#"))
        // The reply decodes back to a verifiable acceptance bound to THIS contact AID.
        val acc = InviteLink.decodeAcceptance(p.replyLink)!!
        assertEquals(iid, acc.accept["inviteId"]!!.jsonPrimitive.content)
        assertEquals(HexUtil.encode(contactPub), acc.accept["contactAID"]!!.jsonPrimitive.content)
        val acceptBytes = ServiceInvite.canonicalAccept(iid, "alice--notes", contactPub, 1700)
        assertTrue(ServiceInvite.verify(HexUtil.decode(acc.acceptSigHex)!!, acceptBytes, contactPub))
    }

    @Test fun redeem_manualPending_signsOverLinkInviteId() = runTest {
        // The canonical inviteId is the one carried in the link's `i=` param; the
        // friend signs the acceptance over it (here it differs from whatever the
        // box happens to echo in the relayed create — the LINK wins).
        val linkInviteId = "ea".repeat(32)
        val create = """{"inviteId":"$linkInviteId","authorAID":"$authorAidHex","serviceRef":"alice--notes","secretHash":"${"d".repeat(64)}","encryptedBundle":"00","issuedAt":1500}"""
        val t = RedeemTransport(status = 200, respBody = """{"pending":true,"approvalMode":"manual","serviceRef":"alice--notes","create":$create,"createSig":"${"b".repeat(128)}"}""")
        val vm = makeVM(t, inviteIdHex = linkInviteId)
        vm.redeem()
        val p = vm.phase.value as InviteRedeemPhase.AwaitingApproval
        val acc = InviteLink.decodeAcceptance(p.replyLink)!!
        assertEquals(linkInviteId, acc.accept["inviteId"]!!.jsonPrimitive.content)
        val acceptBytes = ServiceInvite.canonicalAccept(linkInviteId, "alice--notes", contactPub, 1700)
        assertTrue(ServiceInvite.verify(HexUtil.decode(acc.acceptSigHex)!!, acceptBytes, contactPub))
    }

    @Test fun redeem_storesOwnerAidForTheBox() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice--notes","boundAID":"${HexUtil.encode(contactPub)}","firstBind":true}""")
        makeVM(t, authorHex = authorAidHex.uppercase(), serverDomain = "Home.Alice.Flagship.Services").redeem()
        assertEquals(mapOf(server to authorAidHex), owners.entries)
        assertEquals(authorAidHex, owners.ownerFor(server))
    }

    @Test fun redeem_latestOwnerWins() = runTest {
        owners.remember(server, "aa".repeat(32))
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice--notes","firstBind":false}""")
        makeVM(t).redeem()
        assertEquals(authorAidHex, owners.ownerFor(server))
    }

    @Test fun redeem_manualPending_storesOwnerAid() = runTest {
        val iid = "ea".repeat(32)
        val create = """{"inviteId":"$iid","authorAID":"$authorAidHex","serviceRef":"alice--notes","secretHash":"${"d".repeat(64)}","encryptedBundle":"00","issuedAt":1500}"""
        val t = RedeemTransport(status = 200, respBody = """{"pending":true,"approvalMode":"manual","serviceRef":"alice--notes","create":$create,"createSig":"${"b".repeat(128)}"}""")
        val vm = makeVM(t, inviteIdHex = iid)
        vm.redeem()
        assertTrue(vm.phase.value is InviteRedeemPhase.AwaitingApproval)
        assertEquals(authorAidHex, owners.ownerFor(server))
    }

    @Test fun redeem_legacyOrFailed_storesNothing() = runTest {
        makeVM(RedeemTransport(status = 200, respBody = """{"serviceRef":"alice--notes","firstBind":true}"""), authorHex = null).redeem()
        makeVM(RedeemTransport(status = 404)).redeem()
        assertTrue(owners.entries.isEmpty())
    }

    @Test fun unknownInvite404() = runTest {
        val vm = makeVM(RedeemTransport(status = 404))
        vm.redeem()
        val p = vm.phase.value
        assertTrue(p is InviteRedeemPhase.Failed)
        assertTrue((p as InviteRedeemPhase.Failed).message.contains("unknown") || p.message.contains("withdrawn"))
    }

    @Test fun alreadyBound409() = runTest {
        val vm = makeVM(RedeemTransport(status = 409))
        vm.redeem()
        assertTrue((vm.phase.value as InviteRedeemPhase.Failed).message.contains("another account"))
    }

    @Test fun revoked403() = runTest {
        val vm = makeVM(RedeemTransport(status = 403))
        vm.redeem()
        assertTrue((vm.phase.value as InviteRedeemPhase.Failed).message.contains("revoked"))
    }

    @Test fun expiredOrFull410() = runTest {
        val vm = makeVM(RedeemTransport(status = 410))
        vm.redeem()
        assertTrue((vm.phase.value as InviteRedeemPhase.Failed).message.contains("expired") ||
            (vm.phase.value as InviteRedeemPhase.Failed).message.contains("full"))
    }

    @Test fun malformedSecret_rejectedBeforeNetwork() = runTest {
        val t = RedeemTransport(status = 200)
        val vm = makeVM(t, secretHex = "notahexsecret")
        vm.redeem()
        assertTrue(vm.phase.value is InviteRedeemPhase.Failed)
        assertNull(t.lastUrl)
    }

    /** Records the redeem POST + returns a configurable status/body. */
    class RedeemTransport(private val status: Int, private val respBody: String = "{}") : JsonHttpTransport {
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
