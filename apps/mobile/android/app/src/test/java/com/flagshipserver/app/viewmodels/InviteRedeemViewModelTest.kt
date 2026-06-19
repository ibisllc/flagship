// InviteRedeemViewModel — AID-signs the redeem and POSTs the RAW secret to the
// box's redeem endpoint; maps 404/409/403 to friendly messages; guards a
// malformed secret before any network call.

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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InviteRedeemViewModelTest {
    private val server = "home.alice.flagship.services"
    private val secret = "07".repeat(32) // 64-hex
    private val umkSeed = ByteArray(32) { 0x16 }
    private val aidKp = Ed25519Sign.KeyPair.newKeyPairFromSeed(ServerKeys.deriveAccountIdSeed(umkSeed))
    private val aidPub = ServerKeys.deriveAccountIdPub(umkSeed)

    private fun makeVM(t: JsonHttpTransport, secretHex: String = secret, now: () -> Long = { 1700 }) =
        InviteRedeemViewModel(
            serverDomain = server, secretHex = secretHex,
            client = ServiceAccessClient(boxTransport = t, comTransport = t),
            aidSigner = { Ed25519Sign(aidKp.privateKey) },
            aidPubHex = { HexUtil.encode(aidPub) },
            now = now,
        )

    @Test fun redeem_aidSignsAndPostsRawSecret() = runTest {
        val t = RedeemTransport(status = 200, respBody = """{"serviceRef":"alice-notes","boundAID":"${HexUtil.encode(aidPub)}","firstBind":true}""")
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
        assertEquals(HexUtil.encode(aidPub), body["visitorAID"]!!.jsonPrimitive.content)
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
