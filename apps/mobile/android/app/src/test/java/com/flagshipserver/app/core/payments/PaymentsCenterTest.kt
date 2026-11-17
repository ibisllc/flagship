// PaymentsCenter (the wallet, its sync and the trickle) and PlanFormat against an in-memory `.com` that speaks the
// worker's wire and refusal codes (blindVouchers.ts), signing with the vectors' test key.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.AllowanceState
import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.api.PlanState
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import com.flagshipserver.app.core.voici.WebEnvelopes
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.util.Base64
import java.util.Locale

class PaymentsCenterTest {
    private val GB = 1024L * 1024 * 1024
    private val DAY = PaymentsConfig.DAY_MS
    private val cfg = PaymentsConfig.DEFAULT

    private class FakeCom(private val now: () -> Long) : PaymentsClient {
        private val V = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/vouchers/vectors.json").readText()).jsonObject
        private val jwk = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/vouchers/test-rsa-key.json").readText()).jsonObject["jwk"]!!.jsonObject
        private fun big(k: String) = BigInteger(1, Base64.getUrlDecoder().decode(jwk[k]!!.jsonPrimitive.content))
        private val n = big("n")
        private val d = big("d")
        val key = V["key"]!!.jsonObject.let { VoucherKey(it["keyId"]!!.jsonPrimitive.content, it["nHex"]!!.jsonPrimitive.content, it["eHex"]!!.jsonPrimitive.content) }
        var plan: String? = null
        var paidUntil = 0L
        val spent = HashSet<String>()
        var version = 0L
        var blob: JsonObject? = null
        var remaining = 200 * 1024L * 1024 * 1024
        var topUp = 0L
        val redeems = mutableListOf<JsonObject>()

        private fun refuse(status: Int, code: String, extra: Map<String, JsonElement> = emptyMap()): Nothing =
            throw PaymentsHttpError(status, code, JsonObject(mapOf("code" to JsonPrimitive(code)) + extra))

        override suspend fun config() = JsonObject(
            mapOf(
                "config" to PaymentsConfig.DEFAULT.toJson(),
                "keys" to JsonArray(listOf(JsonObject(mapOf("keyId" to JsonPrimitive(key.keyId), "nHex" to JsonPrimitive(key.nHex), "eHex" to JsonPrimitive(key.eHex), "issuing" to JsonPrimitive(true))))),
                "testIssue" to JsonPrimitive(true),
            ),
        )

        override suspend fun wallet(username: String) = blob
        override suspend fun putWallet(username: String, device: VoiciDeviceSigner, blob: JsonObject) {
            val v = VoiciJs.time(blob["version"])!!
            if (v != version + 1) refuse(409, "version-conflict", mapOf("wallet" to (this.blob ?: JsonNull)))
            version = v
            this.blob = blob
        }
        override suspend fun plan(username: String) = PlanState(when (plan) { "pro" -> "hobby"; "pro-max" -> "maker"; else -> "free" }, paidUntil)
        override suspend fun allowance(username: String) = AllowanceState(0, 0, remaining + topUp)

        override suspend fun redeem(body: JsonObject): JsonObject {
            redeems += body
            val what = body["for"]!!.jsonPrimitive.content
            val vs = (body["vouchers"] as JsonArray).map { Vouchers.parse(it)!! }
            for (v in vs) if (!Vouchers.verify(key, v)) refuse(400, "bad-voucher", mapOf("nullifier" to JsonPrimitive(v.nullifier)))
            if (what == "overage") {
                if (plan == null) refuse(409, "overage-needs-plan")
                val already = vs.map { it.nullifier }.filter { it in spent }
                if (already.isNotEmpty()) refuse(409, "voucher-spent", mapOf("spent" to JsonArray(already.map(::JsonPrimitive))))
                spent += vs.map { it.nullifier }
                topUp += 100L * 1024 * 1024 * 1024
                return JsonObject(mapOf("ok" to JsonPrimitive(true), "topUpBytes" to JsonPrimitive(topUp)))
            }
            val fresh = vs.filter { spent.add(it.nullifier) }
            val already = vs.filter { it !in fresh }.map { it.nullifier }
            if (fresh.isEmpty()) refuse(409, "voucher-spent", mapOf("spent" to JsonArray(already.map(::JsonPrimitive))))
            val base = if (plan == what && paidUntil > now()) paidUntil else now()
            paidUntil = base + fresh.size * PaymentsConfig.DEFAULT.unitMs(what)
            plan = what
            return JsonObject(mapOf("ok" to JsonPrimitive(true), "paidUntil" to JsonPrimitive(paidUntil), "spent" to JsonArray(already.map(::JsonPrimitive))))
        }

        override suspend fun paidIssue(rail: String, proof: JsonObject, keyId: String, blinded: List<String>) = error("not used")

        override suspend fun testIssue(keyId: String, blinded: List<String>): List<String> = blinded.map { b ->
            val m = BigInteger(1, WebEnvelopes.b64Decode(b)!!)
            WebEnvelopes.b64Encode(Vouchers.i2osp(m.modPow(d, n), (n.bitLength() + 7) / 8))
        }
    }

    private class Keys(var admin: Boolean = true) : PaymentsKeyring {
        val umk = ByteArray(32) { 0x7a }
        var confirms = 0
        override fun username() = "plucky-avocet"
        override fun umk() = umk
        override fun device(): VoiciDeviceSigner {
            val kp = Ed25519Sign.KeyPair.newKeyPair()
            return VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(kp.publicKey), Ed25519Sign(kp.privateKey))
        }
        override fun isAdmin() = admin
        override suspend fun confirm(reason: String) { confirms++ }
    }

    private var clock = 1_763_400_000_000L
    private fun center(com: FakeCom, keys: Keys = Keys(), rand: Double = 0.5) = PaymentsCenter(com, keys, MemoryPaymentsLocalStore(), { clock }, { rand })

    @Test fun testCreditIsSealedAndSynced() = runBlocking {
        val com = FakeCom { clock }
        val c = center(com)
        c.refresh()
        assertTrue(c.addTestVouchers())
        assertEquals(30, c.state.value.balance)
        assertEquals(1L, com.version)
        val opened = VoucherWallets.open(VoucherWallets.deriveKey(ByteArray(32) { 0x7a }), com.blob)
        assertEquals(30, opened!!.balance)
        assertEquals(0, com.redeems.size)
    }

    @Test fun choosingProSpendsAtOnceAfterTheBiometric() = runBlocking {
        val com = FakeCom { clock }
        val keys = Keys()
        val c = center(com, keys)
        c.refresh()
        c.addTestVouchers()
        assertTrue(c.choosePlan("pro", delayStart = false, reason = "start"))
        assertEquals(1, keys.confirms)
        assertEquals(1, com.redeems.size)
        val body = com.redeems.single()
        assertEquals(setOf("v", "username", "for", "vouchers"), body.keys)
        assertEquals(1, (body["vouchers"] as JsonArray).size)
        assertEquals("pro", c.state.value.plan)
        assertEquals(clock + 3 * DAY, c.state.value.paidUntil)
        assertEquals(29, c.state.value.balance)
        assertEquals(29, VoucherWallets.open(VoucherWallets.deriveKey(keys.umk), com.blob)!!.balance)
    }

    @Test fun delayedStartSpendsNothingYet() = runBlocking {
        val com = FakeCom { clock }
        val keys = Keys()
        val c = center(com, keys)
        c.refresh()
        c.addTestVouchers()
        assertTrue(c.choosePlan("pro", delayStart = true, reason = "start"))
        assertEquals(0, keys.confirms)
        assertEquals(0, com.redeems.size)
        val startAt = c.state.value.wallet!!.settings.startAt
        assertEquals(clock + 12 * 3_600_000L, startAt)
        clock = startAt + 1
        c.tick()
        assertEquals(1, com.redeems.size)
    }

    @Test fun theTrickleSpendsOneAtARandomMomentAndStopsAhead() = runBlocking {
        val com = FakeCom { clock }
        val c = center(com)
        c.refresh()
        c.addTestVouchers()
        c.choosePlan("pro", false, "start")
        c.tick() // schedules the next spend inside one unit
        val before = com.redeems.size
        clock += 3 * DAY
        c.refresh()
        c.tick()
        assertTrue(com.redeems.size > before)
        com.paidUntil = clock + 13 * DAY
        c.refresh()
        val n = com.redeems.size
        clock += 2 * DAY
        c.tick()
        assertEquals(n, com.redeems.size)
    }

    @Test fun aSpentVoucherIsDroppedAndTheSpendRetried() = runBlocking {
        val com = FakeCom { clock }
        val c = center(com)
        c.refresh()
        c.addTestVouchers()
        val first = VoucherWallets.take(c.state.value.wallet!!, 1).single()
        com.spent += first.nullifier
        c.choosePlan("pro", false, "start")
        assertEquals(2, com.redeems.size)
        assertEquals("pro", c.state.value.plan)
        assertEquals(28, c.state.value.balance)
        assertFalse(c.state.value.wallet!!.vouchers.any { it.nullifier == first.nullifier })
    }

    @Test fun aWriteConflictMergesTheOtherDevicesWallet() = runBlocking {
        val com = FakeCom { clock }
        val a = center(com)
        val b = center(com)
        a.refresh()
        b.refresh()
        a.addTestVouchers()
        b.addTestVouchers()
        assertEquals(2L, com.version)
        assertEquals(60, b.state.value.balance)
        assertEquals(60, VoucherWallets.open(VoucherWallets.deriveKey(ByteArray(32) { 0x7a }), com.blob)!!.balance)
    }

    @Test fun aNonAdminDeviceNeverSpends() = runBlocking {
        val com = FakeCom { clock }
        val c = center(com, Keys(admin = false))
        c.refresh()
        assertFalse(c.addTestVouchers())
        assertFalse(c.choosePlan("pro", false, "start"))
        assertEquals(0, com.redeems.size)
    }

    @Test fun overageBuysOneBlockWithinTheCap() = runBlocking {
        val com = FakeCom { clock }
        val c = center(com)
        c.refresh()
        c.addTestVouchers()
        c.choosePlan("pro", false, "start")
        com.remaining = 2 * GB
        c.refresh()
        c.tick()
        val overage = com.redeems.filter { it["for"]!!.jsonPrimitive.content == "overage" }
        assertEquals(1, overage.size)
        assertEquals(5, (overage.single()["vouchers"] as JsonArray).size)
        val w = c.state.value.wallet!!
        assertEquals(VoucherWallets.overagePeriod(clock), w.overagePeriod)
        assertEquals(5L, w.overageUnits)
        assertTrue(c.setOverageCap(0))
        com.topUp = 0
        c.refresh()
        c.tick()
        assertEquals(1, com.redeems.count { it["for"]!!.jsonPrimitive.content == "overage" })
    }

    @Test fun planFormat() {
        assertEquals("$30", PlanFormat.usd(30, cfg, Locale.US))
        assertEquals(3L, PlanFormat.months(30, "pro", cfg))
        assertEquals(1L, PlanFormat.months(30, "pro-max", cfg))
        assertEquals(listOf(0L, 5L, 10L, 15L, 20L), PlanFormat.capOptions(cfg).take(5))
        assertEquals(200L, PlanFormat.capGb(10, cfg))
        assertEquals(3, PlanFormat.daysLeft(clock + 2 * DAY + 1, clock))
        assertTrue(PlanFormat.inGrace(clock - DAY, clock, cfg))
        assertFalse(PlanFormat.inGrace(clock - 4 * DAY, clock, cfg))
        assertNotNull(PlanFormat.overageThisMonth(null, clock))
    }
}
