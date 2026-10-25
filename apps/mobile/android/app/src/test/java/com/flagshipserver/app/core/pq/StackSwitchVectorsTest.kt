package com.flagshipserver.app.core.pq

import com.flagshipserver.app.api.StackSwitchOrderWire
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.StackSwitchOrder
import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// The Kotlin half of packages/protocol/test-vectors/arch-v2-switch/vectors.json.
class StackSwitchVectorsTest {
    private val v = PqVectors.load("packages/protocol/test-vectors/arch-v2-switch/vectors.json")

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun order(o: JsonObject) = StackSwitchOrderWire(o.s("serverDomain"), o.s("target"), o.s("nonce"), o["issuedAt"]!!.jsonPrimitive.long)

    @Test
    fun everyCase() {
        val verify = Ed25519Verify(HexUtil.decode(v.s("signerHex"))!!)
        val admin = Ed25519Sign(ByteArray(32) { 0x22 })
        for (c in v["cases"]!!.jsonArray.map { it.jsonObject }) {
            val name = c.s("name")
            val bytes = StackSwitchOrder.canonical(order(c["order"]!!.jsonObject))
            c["canonical"]?.let { assertEquals(name, it.jsonPrimitive.content, String(bytes, Charsets.UTF_8)) }
            val expect = c["expect"]!!.jsonPrimitive.boolean
            assertEquals(name, expect, runCatching { verify.verify(HexUtil.decode(c.s("signature"))!!, bytes) }.isSuccess)
            if (expect) assertEquals(name, c.s("signature"), HexUtil.encode(admin.sign(bytes)))
        }
        for (r in v["refused"]!!.jsonArray.map { it.jsonObject }) {
            assertThrows(r.s("name"), IllegalArgumentException::class.java) { StackSwitchOrder.canonical(order(r["order"]!!.jsonObject)) }
        }
    }

    @Test
    fun nonceAndDryRun() {
        val n = StackSwitchOrder.newNonce()
        assertTrue(Regex("^[0-9a-f]{32}$").matches(n))
        val b = StackSwitchOrder.sign(StackSwitchOrderWire("home.alice.flagship.services", "arch-v2", n, 1), Ed25519Sign(ByteArray(32) { 0x22 }), dryRun = true)
        assertEquals(true, b.dryRun)
        assertEquals(128, b.signature.length)
    }
}
