// The Kotlin voucher link against packages/protocol/test-vectors/voucher-link/ (genVoucherLinkVectors.ts).

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoucherLinkVectorsTest {
    private val V by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voucher-link/vectors.json").readText()).jsonObject }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private val key by lazy { V["key"]!!.jsonObject.let { VoucherKey(it.s("keyId"), it.s("nHex"), it.s("eHex")) } }
    private val vouchers by lazy { V["vouchers"]!!.jsonArray.map { Vouchers.parse(it)!! } }
    private val forged by lazy { Vouchers.parse(V["forged"])!! }
    private val otherKey by lazy { Vouchers.parse(V["otherKey"])!! }
    private fun strs(k: String, o: JsonObject = V) = o[k]!!.jsonArray.map { it.jsonPrimitive.content }
    private fun filler(i: Int) = Voucher("ffffffffffffffff", "00".repeat(32), i.toString(16).padStart(64, '0'), "AAAA")
    private fun pick(e: kotlinx.serialization.json.JsonElement): Voucher {
        val p = e.jsonPrimitive
        return p.intOrNull?.let { vouchers[it] } ?: if (p.content == "forged") forged else otherKey
    }

    @Test fun constants() {
        assertEquals(V.s("path"), VoucherLink.PATH)
        assertEquals(V["maxPerLink"]!!.jsonPrimitive.int, VoucherLink.MAX_PER_LINK)
    }

    @Test fun encodesByteForByte() {
        val links = V["links"]!!.jsonObject
        assertEquals(strs("single", links), VoucherLink.encodeLinks(vouchers.take(3), V.s("apex")))
        assertEquals(strs("chunked", links), VoucherLink.encodeLinks(vouchers, V.s("apex")))
        assertEquals(V.s("payloadOneVoucher"), VoucherLink.encodePayload(listOf(vouchers[0]), 1, 1))
    }

    @Test fun parsesEveryCase() {
        for (c in V["parse"]!!.jsonArray.map { it.jsonObject }) {
            val name = c.s("name")
            val e = c["expect"]!!.jsonObject
            val r = VoucherLink.parse(c.s("link"))
            if (e["ok"]!!.jsonPrimitive.boolean) {
                assertTrue(name, r is VoucherLinkParse.Ok)
                r as VoucherLinkParse.Ok
                assertEquals(name, e["part"]!!.jsonPrimitive.int, r.part)
                assertEquals(name, e["parts"]!!.jsonPrimitive.int, r.parts)
                assertEquals(name, e.s("keyId"), r.keyId)
                assertEquals(name, e["count"]!!.jsonPrimitive.int, r.vouchers.size)
                assertEquals(name, strs("nullifiers", e), r.vouchers.map { it.nullifier })
            } else {
                assertEquals(name, VoucherLinkParse.Failed(e.s("code")), r)
            }
        }
    }

    @Test fun roundTripsAChunkedPurchase() {
        val back = strs("chunked", V["links"]!!.jsonObject).flatMap { (VoucherLink.parse(it) as VoucherLinkParse.Ok).vouchers }
        assertEquals(vouchers, back)
    }

    @Test fun plansEveryImport() {
        for (c in V["imports"]!!.jsonArray.map { it.jsonObject }) {
            val name = c.s("name")
            val wj = c["wallet"]!!.jsonObject
            val filler = wj["filler"]?.jsonPrimitive?.int ?: 0
            val w = VoucherWallets.empty(10).copy(
                vouchers = wj["vouchers"]!!.jsonArray.map { vouchers[it.jsonPrimitive.int] } + (0 until filler).map(::filler),
                spent = wj["spent"]!!.jsonArray.map { vouchers[it.jsonPrimitive.int].nullifier },
            )
            val link = c["link"]!!.jsonArray.map(::pick)
            val p = VoucherLink.plan(w, link, if (c.s("keys") == "test") listOf(key) else emptyList())
            val e = c["expect"]!!.jsonObject
            assertEquals(name, e["add"]!!.jsonArray.map { it.jsonPrimitive.int }, p.add.map { a -> vouchers.indexOfFirst { it.n == a.n && it.s == a.s } })
            assertEquals(name, e["duplicate"]!!.jsonPrimitive.int, p.duplicate)
            assertEquals(name, e["spent"]!!.jsonPrimitive.int, p.spent)
            assertEquals(name, e["invalid"]!!.jsonPrimitive.int, p.invalid)
            assertEquals(name, e["unknownKey"]!!.jsonPrimitive.int, p.unknownKey)
            assertEquals(name, e["full"]!!.jsonPrimitive.boolean, p.full)
            assertEquals(name, e.s("outcome"), p.outcome)
        }
    }
}
