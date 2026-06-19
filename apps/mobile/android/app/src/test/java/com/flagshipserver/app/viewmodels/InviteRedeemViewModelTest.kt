// InviteRedeemViewModel (gating v2) — redeems with the friend's PER-AUTHOR
// contact AID (derived from the author AID carried in the link), falling back to
// the global AID for a legacy link; POSTs the RAW secret to the box's redeem
// endpoint; maps 404/409/403/410; on a MANUAL-approve {pending} response emits a
// contact-AID-signed acceptance reply for the friend to send back to the author.

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
    // The per-author contact AID the friend presents (v2 redemption identity).
    private val contactPub = ServerKeys.deriveContactAccountIdPub(friendUmk, authorAidPub)
    private val globalPub = ServerKeys.deriveAccountIdPub(friendUmk)

    private fun makeVM(t: JsonHttpTransport, authorHex: String? = authorAidHex, inviteIdHex: String? = null, secretHex: String = secret, now: () -> Long = { 1700 }) =
        InviteRedeemViewModel(
            serverDomain = server, secretHex = secretHex, authorAidHex = authorHex, inviteIdHex = inviteIdHex,
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            globalAidSigner = { ServerKeys.deriveAccountId(friendUmk) },
            globalAidPubHex = { HexUtil.encode(globalPub) },
            contactAidSigner = { a, _ -> ServerKeys.deriveContactAccountId(friendUmk, a) },
            contactAidPubHex = { a, _ -> HexUtil.encode(ServerKeys.deriveContactAccountIdPub(friendUmk, a)) },
            now = now,
        )

    @Test fun redeem_usesContactAid_andPostsRawSecret() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice-notes","boundAID":"${HexUtil.encode(contactPub)}","firstBind":true}""")
        val vm = makeVM(t)
        vm.redeem()
        val p = vm.phase.value
        assertTrue(p is InviteRedeemPhase.Done)
        p as InviteRedeemPhase.Done
        assertEquals("alice-notes", p.serviceRef)
        assertTrue(p.firstBind)
        assertTrue(t.lastUrl!!.endsWith("/api/service-invites/redeem"))
        val body = t.lastBodyJson()!!
        assertEquals(secret, body["secret"]!!.jsonPrimitive.content) // RAW secret
        // v2: the PER-AUTHOR contact AID is presented as visitorAID, NOT the global AID.
        assertEquals(HexUtil.encode(contactPub), body["visitorAID"]!!.jsonPrimitive.content)
        // and the AID sig verifies over the contact-AID redeem bytes.
        val secretHash = ServiceInvite.secretHash(HexUtil.decode(secret)!!)
        val sig = HexUtil.decode(body["aidSig"]!!.jsonPrimitive.content)!!
        assertTrue(ServiceInvite.verify(sig, ServiceInvite.canonicalRedeem(secretHash, contactPub, 1700), contactPub))
    }

    @Test fun redeem_legacyLink_fallsBackToGlobalAid() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice-notes","boundAID":"${HexUtil.encode(globalPub)}","firstBind":true}""")
        val vm = makeVM(t, authorHex = null) // no author AID in the link
        vm.redeem()
        assertTrue(vm.phase.value is InviteRedeemPhase.Done)
        assertEquals(HexUtil.encode(globalPub), t.lastBodyJson()!!["visitorAID"]!!.jsonPrimitive.content)
    }

    @Test fun redeem_manualPending_emitsAcceptanceReply() = runTest {
        // The box returns {pending} + the owner's relayed create.
        val create = """{"inviteId":"inv1","authorAID":"$authorAidHex","serviceRef":"alice-notes","secretHash":"${"d".repeat(64)}","encryptedBundle":"00","issuedAt":1500}"""
        val t = RedeemTransport(status = 200, respBody = """{"pending":true,"approvalMode":"manual","serviceRef":"alice-notes","create":$create,"createSig":"${"b".repeat(128)}"}""")
        val vm = makeVM(t)
        vm.redeem()
        val p = vm.phase.value
        assertTrue(p is InviteRedeemPhase.AwaitingApproval)
        p as InviteRedeemPhase.AwaitingApproval
        assertEquals("alice-notes", p.serviceRef)
        assertTrue(p.replyLink.startsWith("flagship://accept?b="))
        // The reply decodes back to a verifiable acceptance bound to THIS contact AID.
        val acc = InviteLink.decodeAcceptance(p.replyLink)!!
        assertEquals("inv1", acc.accept["inviteId"]!!.jsonPrimitive.content)
        assertEquals(HexUtil.encode(contactPub), acc.accept["contactAID"]!!.jsonPrimitive.content)
        assertEquals("00", acc.create["encryptedBundle"]!!.jsonPrimitive.content)
        assertEquals("b".repeat(128), acc.createSigHex)
        val acceptBytes = ServiceInvite.canonicalAccept("inv1", "alice-notes", contactPub, 1700)
        assertTrue(ServiceInvite.verify(HexUtil.decode(acc.acceptSigHex)!!, acceptBytes, contactPub))
    }

    @Test fun redeem_manualPending_signsOverLinkInviteId() = runTest {
        // The canonical inviteId is the one carried in the link's `i=` param; the
        // friend signs the acceptance over it (here it differs from whatever the
        // box happens to echo in the relayed create — the LINK wins).
        val linkInviteId = "ea".repeat(32)
        val create = """{"inviteId":"$linkInviteId","authorAID":"$authorAidHex","serviceRef":"alice-notes","secretHash":"${"d".repeat(64)}","encryptedBundle":"00","issuedAt":1500}"""
        val t = RedeemTransport(status = 200, respBody = """{"pending":true,"approvalMode":"manual","serviceRef":"alice-notes","create":$create,"createSig":"${"b".repeat(128)}"}""")
        val vm = makeVM(t, inviteIdHex = linkInviteId)
        vm.redeem()
        val p = vm.phase.value as InviteRedeemPhase.AwaitingApproval
        val acc = InviteLink.decodeAcceptance(p.replyLink)!!
        assertEquals(linkInviteId, acc.accept["inviteId"]!!.jsonPrimitive.content)
        val acceptBytes = ServiceInvite.canonicalAccept(linkInviteId, "alice-notes", contactPub, 1700)
        assertTrue(ServiceInvite.verify(HexUtil.decode(acc.acceptSigHex)!!, acceptBytes, contactPub))
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
