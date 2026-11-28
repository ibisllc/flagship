// Runs packages/protocol/test-vectors/org-read-token/vectors.json (docs/account-read-token.md "Org routes"), read from
// disk so a drift fails here, and checks OrgClient carries the token on org reads and mints again after a 401.

package com.flagshipserver.app.core

import com.flagshipserver.app.core.pq.PqHex
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class OrgReadTokenVectorsTest {

    private fun vectorsFile(): File {
        val rel = "packages/protocol/test-vectors/org-read-token/vectors.json"
        val candidates = ArrayList<File>()
        System.getProperty("user.dir")?.let { candidates.add(File(it)) }
        runCatching { javaClass.protectionDomain?.codeSource?.location?.toURI()?.let { candidates.add(File(it)) } }
        for (start in candidates) {
            var dir: File? = start.absoluteFile
            var hops = 0
            while (dir != null && hops < 14) {
                val f = File(dir, rel)
                if (f.isFile) return f
                dir = dir.parentFile
                hops += 1
            }
        }
        fail("could not locate $rel")
        error("unreachable")
    }

    private val v: JsonObject by lazy { Json.parseToJsonElement(vectorsFile().readText()).jsonObject }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun hex(s: String) = PqHex.decode(s)!!

    @Test
    fun reproducesTheSeatRequest() {
        val k = v["keys"]!!.jsonObject
        val seat = v["seat"]!!.jsonObject
        val r = seat["request"]!!.jsonObject
        val cred = OrgReadTokenCredential.member(hex(k.s("umkSeedHex")), k.s("orgId"), k.s("seatId"))
        assertEquals(k.s("memberPubHex"), cred.pubHex)
        assertEquals(seat.s("path"), OrgReadToken.path(k.s("orgId")))
        assertEquals(r.s("subject"), OrgReadToken.seatSubject(k.s("seatId")))
        val canonical = OrgReadToken.canonicalRequest(k.s("orgId"), r.s("subject"), cred.pubHex, r["issuedAt"]!!.jsonPrimitive.long, r.s("nonceHex"))
        assertEquals(seat.s("canonical"), String(canonical, Charsets.UTF_8))
        // Ed25519 is deterministic: the body is the vector's byte for byte.
        val body = OrgReadToken.requestBody(k.s("orgId"), cred, r["issuedAt"]!!.jsonPrimitive.long, r.s("nonceHex"))
        assertEquals(seat.s("signatureHex"), body.s("signature"))
        assertEquals(r, body["request"])
        Ed25519Verify(hex(k.s("memberPubHex"))).verify(hex(seat.s("signatureHex")), canonical)
        val rejected = runCatching { Ed25519Verify(hex(k.s("memberPubHex"))).verify(hex(seat["reject"]!!.jsonObject.s("signatureHex")), canonical) }
        assertTrue(rejected.isFailure)
    }

    @Test
    fun theGatedPaths() {
        val org = "ab".repeat(16)
        assertNull(OrgReadToken.gatedOrg("/api/orgs/$org/plan"))
        assertNull(OrgReadToken.gatedOrg("/api/orgs/$org/invites/$org"))
        assertNull(OrgReadToken.gatedOrg("/api/orgs/$org/read-token"))
        assertEquals(org, OrgReadToken.gatedOrg("/api/orgs/$org/directory/slices"))
        assertEquals(org, OrgReadToken.gatedOrg("/api/orgs/$org/voucher-wallet"))
    }

    @Test
    fun orgClientSendsTheTokenAndMintsAgainAfterA401() = runBlocking {
        val org = "ab".repeat(16)
        val seat = "cd".repeat(16)
        val cred = OrgReadTokenCredential.member(ByteArray(32) { 7 }, org, seat)
        val tokens = OrgReadTokens(credentials = { listOf(cred) })
        val calls = mutableListOf<String>()
        var minted = 0
        var refuse: String? = null
        val http = object : OrgHttp {
            override suspend fun call(method: String, path: String, body: JsonObject?) = call(method, path, body, emptyMap())
            override suspend fun call(method: String, path: String, body: JsonObject?, headers: Map<String, String>): Pair<Int, JsonObject> {
                if (path.endsWith("/read-token")) {
                    minted += 1
                    assertEquals("seat:$seat", (body!!["request"] as JsonObject).s("subject"))
                    return 200 to buildJsonObject { put("token", "ort1.t$minted"); put("expiresAt", 10_000_000_000_000L) }
                }
                val auth = headers["authorization"]
                calls += "${path.substringAfterLast('/')}:${auth ?: "none"}"
                if (auth != null && auth == refuse) return 401 to buildJsonObject { put("code", "org-read-token-required") }
                return 200 to buildJsonObject { put("status", "trial") }
            }
        }
        val client = OrgClient(http, tokens) { 1_760_000_000_000L }
        client.connectors(org)
        client.proposals(org)
        assertEquals(listOf("connectors:Bearer ort1.t1", "proposals:Bearer ort1.t1"), calls)
        assertEquals(1, minted)
        refuse = "Bearer ort1.t1"
        calls.clear()
        client.connectors(org)
        assertEquals(listOf("connectors:Bearer ort1.t1", "connectors:Bearer ort1.t2"), calls)
        assertEquals(2, minted)
        calls.clear()
        client.plan(org)
        assertEquals(listOf("plan:none"), calls)
        Unit
    }
}
