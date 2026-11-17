// The Kotlin voucher, wallet and config against packages/protocol/test-vectors/vouchers/ (genVoucherVectors.ts).

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

class VoucherVectorsTest {
    private val V by lazy { Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/vouchers/vectors.json").readText()).jsonObject }
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun JsonObject.cases(k: String) = this[k]!!.jsonArray.map { it.jsonObject }
    private fun h(s: String) = WebEnvelopes.hexToBytes(s)
    private val key by lazy { V.o("key").let { VoucherKey(it.s("keyId"), it.s("nHex"), it.s("eHex")) } }
    private fun voucher(o: JsonObject) = Vouchers.parse(o)!!
    private fun wallet(o: JsonObject) = VoucherWallets.parse(o)!!
    private fun canon(w: VoucherWallet) = WebEnvelopes.canonicalJson(w.toJson())

    @Test fun keyId() {
        assertEquals(key.keyId, Vouchers.keyId(key.nHex, key.eHex))
        assertNotNull(Vouchers.rsa(key))
        assertNull(Vouchers.rsa(key.copy(keyId = "0".repeat(16))))
    }

    @Test fun blindAndUnblindByteForByte() {
        for (c in V.cases("blind")) {
            val (pending, blinded) = Vouchers.request(key, h(c.s("nonceHex")), h(c.s("prefixHex")), h(c.s("saltHex")), BigInteger(c.s("rHex"), 16))
            assertEquals(c.s("blinded"), blinded)
            assertEquals(c.s("invHex"), pending.inv)
            val v = Vouchers.finalize(key, pending, c.s("blindSig"))
            assertEquals(voucher(c.o("voucher")), v)
            assertEquals(c.s("preparedHex"), VoiciJs.hex(Vouchers.prepared(v.p, v.n)))
            assertEquals(c.s("messageHex"), VoiciJs.hex(Vouchers.message(h(c.s("nonceHex")))))
            assertEquals(c.s("nullifier"), v.nullifier)
            assertTrue(Vouchers.verify(key, v))
        }
    }

    @Test fun refusesTamperedVouchers() {
        for (c in V.cases("bad")) {
            val v = Vouchers.parse(c["voucher"])
            assertTrue(c.s("why"), v == null || !Vouchers.verify(key, v))
        }
        val b = V.cases("blind")
        val (pending, _) = Vouchers.request(key, h(b[0].s("nonceHex")), h(b[0].s("prefixHex")))
        assertThrows(IllegalArgumentException::class.java) { Vouchers.finalize(key, pending, b[1].s("blindSig")) }
    }

    @Test fun sealsTheWalletByteForByte() {
        val w = V.o("wallet")
        val k = VoucherWallets.deriveKey(h(w.s("umkSeedHex")))
        assertEquals(w.s("keyHex"), VoiciJs.hex(k))
        val wal = wallet(w.o("wallet"))
        assertEquals(w.s("plaintext"), VoucherWallets.plaintext(wal))
        assertEquals(w.l("plaintextLength").toInt(), VoucherWallets.plaintext(wal).length)
        val sealed = VoucherWallets.seal(k, w.l("version"), wal, h(w.s("nonceHex")))
        assertEquals(w.o("sealed"), sealed)
        val opened = VoucherWallets.open(k, sealed)!!
        assertEquals(canon(wal), canon(opened))
        val bumped = JsonObject(sealed + ("version" to kotlinx.serialization.json.JsonPrimitive(w.l("version") + 1)))
        assertNull(VoucherWallets.open(k, bumped))
    }

    @Test fun mergesWallets() {
        val m = V.o("merge")
        val local = wallet(m.o("local"))
        val remote = wallet(m.o("remote"))
        val want = WebEnvelopes.canonicalJson(m.o("merged"))
        assertEquals(want, canon(VoucherWallets.merge(local, remote)))
        assertEquals(want, canon(VoucherWallets.merge(remote, local)))
    }

    @Test fun trickleOverageAndPlanLead() {
        for (c in V.cases("trickle")) {
            val i = c.o("input")
            val input = TrickleInput(
                i.l("now"), i["enabled"]!!.jsonPrimitive.boolean, i.l("balance"), i.l("aheadMs"), i.l("startAt"), i.l("nextSpendAt"),
                i.l("unitMs"), i.l("lowWaterMs"), i.l("highWaterMs"), i.l("maxPerRequest"),
            )
            val out = c.o("out")
            assertEquals(c.s("name"), TrickleOut(out.l("spend"), out.l("nextSpendAt")), VoucherWallets.trickleStep(input, c["rand"]!!.jsonPrimitive.double))
        }
        for (c in V.cases("overage")) {
            val i = c.o("input")
            val input = OverageInput(i["paid"]!!.jsonPrimitive.boolean, i.l("remainingBytes"), i.l("buyBelowBytes"), i.l("capUnits"), i.l("spentUnits"), i.l("blockUnits"), i.l("balance"))
            assertEquals(c.s("name"), c["out"]!!.jsonPrimitive.boolean, VoucherWallets.overageStep(input))
        }
        val cfg = PaymentsConfig.DEFAULT
        for (c in V.cases("planAhead")) {
            val p = c.o("paid")
            val paidPlan = if (p["plan"] is JsonNull) null else p.s("plan")
            assertEquals(c.s("name"), c.l("out"), VoucherWallets.planAheadMs(cfg, c.s("plan"), paidPlan, p.l("paidUntil"), c.l("now")))
        }
        assertEquals(V.o("unitMs").l("pro"), cfg.unitMs("pro"))
        assertEquals(V.o("unitMs").l("pro-max"), cfg.unitMs("pro-max"))
        assertEquals(V.o("defaultConfig"), cfg.toJson())
        assertEquals(cfg, PaymentsConfig.merge(V["defaultConfig"]))
    }

    @Test fun walletOperations() {
        val vs = V.cases("blind").map { voucher(it.o("voucher")) }
        var w = VoucherWallets.add(VoucherWallets.empty(10), vs)
        assertEquals(3, w.balance)
        val first = VoucherWallets.take(w, 1).single()
        w = VoucherWallets.markSpent(w, listOf(first.nullifier))
        assertEquals(2, w.balance)
        w = VoucherWallets.add(w, listOf(first))
        assertEquals(2, w.balance)
    }

    @Test fun configOverrides() {
        val c = PaymentsConfig.merge(Json.parseToJsonElement("""{"plans":{"pro":{"unitsPerMonth":12}},"graceHours":1,"packs":[30,10]}"""))
        assertEquals(12, c.plan("pro").unitsPerMonth)
        assertEquals(20, c.plan("pro-max").unitsPerMonth)
        assertEquals(72, c.graceHours)
        assertEquals(listOf(10L, 30L), c.packs)
        assertFalse(PaymentsConfig.isPaidPlan("free"))
        assertEquals("2025-11", VoucherWallets.overagePeriod(1_763_400_000_000))
    }
}
