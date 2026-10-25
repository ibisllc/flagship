package com.flagshipserver.app.core.pq

import com.flagshipserver.app.api.GpuApprovalRequest
import com.flagshipserver.app.core.GpuApprovalOrders
import com.flagshipserver.app.core.HexUtil
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/gpu-approval/vectors.json: the canonical bytes
// flagship-gpud verifies, the admin root (0x22…) reproducing every accepted signature (Ed25519 is
// deterministic), every tampered case failing; plus the withdrawal's bytes.
class GpuApprovalVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/gpu-approval/vectors.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.opt(k: String) = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

    private fun request(server: String, a: JsonObject): GpuApprovalRequest {
        val app = a["app"]!!.jsonObject
        return GpuApprovalRequest(
            server, app.s("appId"), app.s("installationId"), app["generation"]!!.jsonPrimitive.long, a.s("backend"),
            a["maxCount"]!!.jsonPrimitive.int, a["capabilities"]!!.jsonArray.map { it.jsonPrimitive.content },
            a["policies"]!!.jsonArray.map { it.jsonPrimitive.content }, a.s("isolation"), a["secrecy"]!!.jsonPrimitive.boolean,
            a.opt("trustDomain"), a.opt("ownerConsent"),
        )
    }

    @Test
    fun everyCase() {
        val anchor = v["anchor"]!!.jsonObject
        val server = anchor.s("server")
        val verify = Ed25519Verify(HexUtil.decode(anchor.s("signerHex"))!!)
        val admin = Ed25519Sign(ByteArray(32) { 0x22 })
        val cases = v["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size > 10)
        for (c in cases) {
            val name = c.s("name")
            val r = request(server, c["approval"]!!.jsonObject)
            val proof = c["proof"]!!.jsonObject
            val at = proof["issuedAt"]!!.jsonPrimitive.long
            val bytes = GpuApprovalOrders.canonical(server, r, at)
            c.opt("canonical")?.let { assertEquals(name, it, String(bytes, Charsets.UTF_8)) }
            val sigHex = proof.opt("signature") ?: ""
            val sig = if (Regex("^[0-9a-f]{128}$").matches(sigHex)) HexUtil.decode(sigHex)!! else ByteArray(64)
            val ok = runCatching { verify.verify(sig, bytes) }.isSuccess
            assertEquals(name, c["expect"]!!.jsonPrimitive.boolean, ok)
            if (c["expect"]!!.jsonPrimitive.boolean) assertEquals(name, sigHex, HexUtil.encode(admin.sign(bytes)))
        }
    }

    @Test
    fun refusesWhatGpudCouldNotReadBack() {
        val s = "home.alice.flagship.services"
        val r = GpuApprovalRequest(s, "alice--render", "inst-7f3a", 3, "nvidia-cuda", 1, listOf("compute"), listOf("exclusive"), "gvisor-nvproxy", true)
        GpuApprovalOrders.canonical(s, r, 1)
        val bad = listOf(
            r.copy(appId = "alice|render"), r.copy(installationId = ""), r.copy(maxCount = 17), r.copy(maxCount = 0),
            r.copy(caps = emptyList()), r.copy(policies = listOf("shared")), r.copy(backend = "cuda"), r.copy(isolation = "none"),
            r.copy(trustDomain = "a b"), r.copy(generation = -1),
        )
        for (b in bad) assertThrows(IllegalArgumentException::class.java) { GpuApprovalOrders.canonical(s, b, 1) }
        assertThrows(IllegalArgumentException::class.java) { GpuApprovalOrders.canonical("Home.alice", r, 1) }
    }

    @Test
    fun withdrawVectors() {
        val anchor = v["anchor"]!!.jsonObject
        val server = anchor.s("server")
        val verify = Ed25519Verify(HexUtil.decode(anchor.s("signerHex"))!!)
        val admin = Ed25519Sign(ByteArray(32) { 0x22 })
        val cases = v["withdraw"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.size > 3)
        for (c in cases) {
            val name = c.s("name")
            val w = c["withdraw"]!!.jsonObject
            val bytes = GpuApprovalOrders.withdrawCanonical(server, w.s("appId"), w.s("installationId"), w["generation"]!!.jsonPrimitive.long, w["issuedAt"]!!.jsonPrimitive.long)
            c.opt("canonical")?.let { assertEquals(name, it, String(bytes, Charsets.UTF_8)) }
            val sigHex = c.opt("signature") ?: ""
            val sig = if (Regex("^[0-9a-f]{128}$").matches(sigHex)) HexUtil.decode(sigHex)!! else ByteArray(64)
            val expect = c["expect"]!!.jsonPrimitive.boolean
            assertEquals(name, expect, runCatching { verify.verify(sig, bytes) }.isSuccess)
            if (expect) assertEquals(name, sigHex, HexUtil.encode(admin.sign(bytes)))
        }
    }

    @Test
    fun ownerTermsNameATrustDomainAndConsentForSharing() {
        val r = GpuApprovalRequest("s", "a", "i", 1, "nvidia-cuda", 1, listOf("video-encode"), listOf("cooperative"), "gvisor-nvproxy", false)
        val t = GpuApprovalOrders.ownerTerms(r, 42)
        assertEquals("owner-apps", t.trustDomain)
        assertEquals("owner-consent-42", t.ownerConsent)
        GpuApprovalOrders.canonical("home.alice.flagship.services", t, 42)
        val ex = r.copy(policies = listOf("exclusive"), secrecy = true)
        assertEquals(ex, GpuApprovalOrders.ownerTerms(ex, 42))
    }

    @Test
    fun withdrawalBytes() {
        assertEquals(
            "flagship/gpu-approval-withdraw/v1|home.alice.flagship.services|alice--render|inst-7f3a|3|1800000000000",
            String(GpuApprovalOrders.withdrawCanonical("home.alice.flagship.services", "alice--render", "inst-7f3a", 3, 1_800_000_000_000), Charsets.UTF_8),
        )
    }
}
