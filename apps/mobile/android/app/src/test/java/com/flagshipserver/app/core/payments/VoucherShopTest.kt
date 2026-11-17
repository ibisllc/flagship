// The Google Play voucher shop (VoucherShop) against a fake Play (the BillingClient seam) and a fake `.com` that speaks
// paid-issue's wire and refusal codes (docs/payments-privacy-and-rails.md §11), signing with the vectors' test key.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.AllowanceState
import com.flagshipserver.app.api.PaidIssue
import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.api.PlanState
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import com.flagshipserver.app.core.voici.WebEnvelopes
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.util.Base64

class VoucherShopTest {
    private val events = mutableListOf<String>()

    private inner class FakeCom : PaymentsClient {
        private val V = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/vouchers/vectors.json").readText()).jsonObject
        private val jwk = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/vouchers/test-rsa-key.json").readText()).jsonObject["jwk"]!!.jsonObject
        private fun big(k: String) = BigInteger(1, Base64.getUrlDecoder().decode(jwk[k]!!.jsonPrimitive.content))
        private val n = big("n")
        private val d = big("d")
        val key = V["key"]!!.jsonObject.let { VoucherKey(it["keyId"]!!.jsonPrimitive.content, it["nHex"]!!.jsonPrimitive.content, it["eHex"]!!.jsonPrimitive.content) }
        var googleRail = true
        var servedProducts: JsonElement? = null
        var version = 0L
        var blob: JsonObject? = null
        /** A refusal for the next paid-issue calls (null: sign). */
        var refusal: Pair<Int, String>? = null
        var refusalExtra: Map<String, JsonElement> = emptyMap()
        var offline = false
        var walletOffline = false
        val issues = mutableListOf<JsonObject>()
        private val signed = HashMap<String, List<String>>()

        private fun refuse(status: Int, code: String, extra: Map<String, JsonElement> = emptyMap()): Nothing =
            throw PaymentsHttpError(status, code, JsonObject(mapOf("error" to JsonPrimitive(code), "code" to JsonPrimitive(code)) + extra))

        override suspend fun config() = JsonObject(
            buildMap {
                put("config", PaymentsConfig.DEFAULT.toJson())
                put("keys", JsonArray(listOf(JsonObject(mapOf("keyId" to JsonPrimitive(key.keyId), "nHex" to JsonPrimitive(key.nHex), "eHex" to JsonPrimitive(key.eHex), "issuing" to JsonPrimitive(true))))))
                put("testIssue", JsonPrimitive(false))
                put("rails", JsonObject(mapOf("stripe" to JsonPrimitive(true), "apple" to JsonPrimitive(false), "google" to JsonPrimitive(googleRail))))
                servedProducts?.let { put("products", it) }
            },
        )

        override suspend fun wallet(username: String) = blob
        override suspend fun putWallet(username: String, device: VoiciDeviceSigner, blob: JsonObject) {
            if (walletOffline) throw java.io.IOException("offline")
            val v = VoiciJs.time(blob["version"])!!
            if (v != version + 1) refuse(409, "version-conflict", mapOf("wallet" to (this.blob ?: JsonNull)))
            version = v
            this.blob = blob
            events += "wallet"
        }
        override suspend fun plan(username: String) = PlanState("free", 0)
        override suspend fun allowance(username: String) = AllowanceState(0, 0, 0)
        override suspend fun redeem(body: JsonObject): JsonObject = error("not used")
        override suspend fun testIssue(keyId: String, blinded: List<String>): List<String> = error("not used")

        override suspend fun paidIssue(rail: String, proof: JsonObject, keyId: String, blinded: List<String>): PaidIssue {
            events += "issue"
            issues += JsonObject(mapOf("rail" to JsonPrimitive(rail), "proof" to proof, "k" to JsonPrimitive(keyId), "count" to JsonPrimitive(blinded.size)))
            if (offline) throw java.io.IOException("offline")
            refusal?.let { (s, c) -> refuse(s, c, refusalExtra) }
            assertEquals("google", rail)
            assertEquals(setOf("productId", "purchaseToken"), proof.keys)
            val token = proof["purchaseToken"]!!.jsonPrimitive.content
            val units = VoucherProduct.units(proof["productId"]!!.jsonPrimitive.content)!!
            if (blinded.size.toLong() != units) refuse(409, "wrong-count", mapOf("units" to JsonPrimitive(units)))
            signed[token]?.let { if (it != blinded) refuse(409, "payment-used") }
            signed[token] = blinded
            return PaidIssue(keyId, blinded.map { b ->
                val m = BigInteger(1, WebEnvelopes.b64Decode(b)!!)
                WebEnvelopes.b64Encode(Vouchers.i2osp(m.modPow(d, n), (n.bitLength() + 7) / 8))
            }, units)
        }
    }

    private inner class FakePlay : PlayBilling {
        override var onPurchases: ((List<StorePurchase>) -> Unit)? = null
        var available = true
        val owned = LinkedHashMap<String, StorePurchase>()
        var nextState = StoreState.PURCHASED
        var nextQuantity = 1
        var consumeWorks = true
        var buys = 0
        private var seq = 0

        override suspend fun connect() = available
        override suspend fun products(ids: List<String>) = ids.map { StoreProduct(it, "US$" + VoucherProduct.units(it) + ".00") }
        override suspend fun buy(productId: String): BuyOutcome {
            buys++
            val p = StorePurchase("tok-${++seq}", listOf(productId), nextQuantity, nextState)
            owned[p.token] = p
            return BuyOutcome.Bought(listOf(p))
        }
        override suspend fun owned() = owned.values.toList()
        override suspend fun consume(token: String): ConsumeOutcome {
            if (!consumeWorks) return ConsumeOutcome.FAILED
            events += "consume"
            return if (owned.remove(token) != null) ConsumeOutcome.OK else ConsumeOutcome.GONE
        }
    }

    private inner class RecordingStore(val inner: ShopStore = MemoryShopStore()) : ShopStore by inner {
        override fun put(p: PendingPurchase) {
            events += if (p.saved) "saved" else "persist"
            inner.put(p)
        }
    }

    private class Keys(var admin: Boolean = true) : PaymentsKeyring {
        override fun username() = "plucky-avocet"
        override fun umk() = ByteArray(32) { 0x7a }
        override fun device(): VoiciDeviceSigner {
            val kp = Ed25519Sign.KeyPair.newKeyPair()
            return VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(kp.publicKey), Ed25519Sign(kp.privateKey))
        }
        override fun isAdmin() = admin
        override suspend fun confirm(reason: String) = Unit
    }

    private var clock = 1_763_400_000_000L

    private fun world(admin: Boolean = true, com: FakeCom = FakeCom(), play: FakePlay = FakePlay(), store: ShopStore = RecordingStore()): Triple<FakeCom, FakePlay, Pair<PaymentsCenter, VoucherShop>> {
        val center = PaymentsCenter(com, Keys(admin), MemoryPaymentsLocalStore(), { clock }, { 0.5 })
        val shop = VoucherShop(play, com, center, store, CoroutineScope(Dispatchers.Unconfined), { clock })
        return Triple(com, play, center to shop)
    }

    private fun walletBalance(com: FakeCom) = VoucherWallets.open(VoucherWallets.deriveKey(ByteArray(32) { 0x7a }), com.blob)?.balance ?: 0

    @Test fun configParsesRailsAndProducts() {
        val cfg = PaymentsConfig.DEFAULT
        assertEquals(PaymentRails(stripe = true, apple = false, google = true), PaymentRails.parse(Json.parseToJsonElement("""{"stripe":true,"apple":false,"google":true}""")))
        assertEquals(PaymentRails(), PaymentRails.parse(null))
        assertEquals(PaymentRails(), PaymentRails.parse(Json.parseToJsonElement("""{"google":"true"}""")))
        assertEquals(
            listOf(VoucherProduct(10, "com.flagshipserver.app.vouchers.10"), VoucherProduct(30, "com.flagshipserver.app.vouchers.30"), VoucherProduct(120, "com.flagshipserver.app.vouchers.120")),
            VoucherProduct.parse(null, cfg),
        )
        assertEquals(
            listOf(VoucherProduct(30, "com.flagshipserver.app.vouchers.30")),
            VoucherProduct.parse(Json.parseToJsonElement("""[{"units":30,"productId":"com.flagshipserver.app.vouchers.30"},{"units":10,"productId":"com.other.10"}]"""), cfg),
        )
        assertNull(VoucherProduct.units("com.flagshipserver.app.vouchers.x"))
        assertEquals(120L, VoucherProduct.units("com.flagshipserver.app.vouchers.120"))
    }

    @Test fun aPurchaseBlindsIssuesSavesThenConsumes() = runBlocking {
        val (com, play, cs) = world()
        val (center, shop) = cs
        center.refresh()
        shop.load()
        val s = shop.state.value
        assertTrue(s.available)
        assertEquals(listOf(10L, 30L, 120L), s.products.map { it.units })
        assertEquals("US$30.00", s.products[1].price)
        shop.buy(s.products[1])
        assertEquals(listOf("persist", "issue", "wallet", "saved", "consume"), events)
        assertEquals(30, center.state.value.balance)
        assertEquals(30, walletBalance(com))
        assertTrue(play.owned.isEmpty())
        val issue = com.issues.single()
        assertEquals(30, issue["count"]!!.jsonPrimitive.content.toInt())
        assertEquals("com.flagshipserver.app.vouchers.30", (issue["proof"] as JsonObject)["productId"]!!.jsonPrimitive.content)
        assertEquals(ShopNotice(ShopNotice.Kind.ADDED, units = 30), shop.state.value.notice)
        assertEquals(30L, shop.boughtRecently())
    }

    @Test fun quantityMultipliesThePackAndWrongCountRebuildsOnce() = runBlocking {
        val (com, play, cs) = world()
        val (center, shop) = cs
        center.refresh()
        shop.load()
        play.nextQuantity = 3
        // The fake `.com` computes units from the pack only, so it answers wrong-count with the pack's units; the
        // phone rebuilds once with that count (nothing was signed yet).
        shop.buy(shop.state.value.products[0])
        assertEquals(2, com.issues.size)
        assertEquals(30, com.issues[0]["count"]!!.jsonPrimitive.content.toInt())
        assertEquals(10, com.issues[1]["count"]!!.jsonPrimitive.content.toInt())
        assertEquals(10, center.state.value.balance)
    }

    @Test fun aKilledAppResumesWithTheSameBlindedSet() = runBlocking {
        val store = RecordingStore()
        val (com, play, cs) = world(store = store)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        com.walletOffline = true
        shop.buy(shop.state.value.products[0])
        // Signed, but the wallet couldn't be saved: nothing consumed, the set is kept.
        assertEquals(ShopNotice.Kind.RETRY, shop.state.value.notice?.kind)
        assertEquals(1, play.owned.size)
        val kept = store.pending().single()
        assertFalse(kept.saved)
        // A fresh process: a new center and shop over the same store, Play and `.com`.
        com.walletOffline = false
        val center2 = PaymentsCenter(com, Keys(), MemoryPaymentsLocalStore(), { clock }, { 0.5 })
        val shop2 = VoucherShop(play, com, center2, store, CoroutineScope(Dispatchers.Unconfined), { clock })
        center2.refresh()
        shop2.resume()
        assertEquals(2, com.issues.size) // same set again: `.com` answers the same signatures, not payment-used
        assertEquals(10, center2.state.value.balance)
        assertTrue(play.owned.isEmpty())
        assertTrue(store.pending().isEmpty())
        assertEquals(10L, shop2.boughtRecently()) // the resume logged nothing new
    }

    @Test fun aSavedPurchaseWhoseConsumeFailedIsConsumedWithoutAskingAgain() = runBlocking {
        val store = RecordingStore()
        val (com, play, cs) = world(store = store)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        play.consumeWorks = false
        shop.buy(shop.state.value.products[0])
        assertEquals(10, center.state.value.balance)
        assertTrue(store.pending().single().saved)
        play.consumeWorks = true
        shop.resume()
        assertEquals(1, com.issues.size)
        assertTrue(play.owned.isEmpty())
        assertTrue(store.pending().isEmpty())
        assertEquals(10, center.state.value.balance)
    }

    @Test fun aPendingPaymentWaits() = runBlocking {
        val store = RecordingStore()
        val (com, play, cs) = world(store = store)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        play.nextState = StoreState.PENDING
        shop.buy(shop.state.value.products[0])
        assertEquals(ShopNotice.Kind.PENDING, shop.state.value.notice?.kind)
        assertTrue(com.issues.isEmpty())
        assertTrue(store.pending().isEmpty())
        assertEquals(1, play.owned.size)
        // Paid later: Play reports it and the shop finishes it.
        val done = play.owned.values.single().copy(state = StoreState.PURCHASED)
        play.owned[done.token] = done
        play.onPurchases!!(listOf(done))
        assertEquals(10, center.state.value.balance)
        assertTrue(play.owned.isEmpty())
    }

    private fun refusedKeeps(code: String, status: Int, kind: ShopNotice.Kind) = runBlocking {
        events.clear()
        val store = RecordingStore()
        val (com, play, cs) = world(store = store)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        com.refusal = status to code
        shop.buy(shop.state.value.products[0])
        assertEquals(code, kind, shop.state.value.notice?.kind)
        if (kind == ShopNotice.Kind.REFUSED) assertEquals(code, code, shop.state.value.notice?.code)
        assertEquals(code, 1, play.owned.size)
        assertEquals(code, 1, store.pending().size)
        assertEquals(code, 0, center.state.value.balance)
        assertFalse(code, "consume" in events)
    }

    @Test fun everyRefusalThatKeepsThePurchase() {
        refusedKeeps("payment-unpaid", 402, ShopNotice.Kind.RETRY)
        refusedKeeps("rail-unreachable", 502, ShopNotice.Kind.RETRY)
        refusedKeeps("payment-used", 409, ShopNotice.Kind.REFUSED)
        refusedKeeps("payment-invalid", 400, ShopNotice.Kind.REFUSED)
        refusedKeeps("rail-off", 404, ShopNotice.Kind.REFUSED)
        refusedKeeps("no-key", 409, ShopNotice.Kind.REFUSED)
        refusedKeeps("malformed", 400, ShopNotice.Kind.REFUSED)
        refusedKeeps("too-many", 400, ShopNotice.Kind.REFUSED)
        refusedKeeps("wrong-count", 409, ShopNotice.Kind.REFUSED) // no usable units in the answer
    }

    @Test fun aNetworkFailureKeepsItForLater() = runBlocking {
        val store = RecordingStore()
        val (com, play, cs) = world(store = store)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        com.offline = true
        shop.buy(shop.state.value.products[0])
        assertEquals(ShopNotice.Kind.RETRY, shop.state.value.notice?.kind)
        assertEquals(1, store.pending().size)
        com.offline = false
        shop.resume()
        assertEquals(10, center.state.value.balance)
        assertTrue(store.pending().isEmpty())
    }

    @Test fun aRefundedPaymentIsConsumedWithNothingAdded() = runBlocking {
        val store = RecordingStore()
        val (com, play, cs) = world(store = store)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        com.refusal = 409 to "payment-refunded"
        shop.buy(shop.state.value.products[0])
        assertEquals(ShopNotice.Kind.REFUNDED, shop.state.value.notice?.kind)
        assertTrue(play.owned.isEmpty())
        assertTrue(store.pending().isEmpty())
        assertEquals(0, center.state.value.balance)
        assertNull(com.blob)
    }

    @Test fun theDeviceCapRefusesPastTwoHundredForty() = runBlocking {
        val (com, play, cs) = world()
        val (center, shop) = cs
        center.refresh()
        shop.load()
        val big = shop.state.value.products.single { it.units == 120L }
        shop.buy(big)
        shop.buy(big)
        assertEquals(240, center.state.value.balance)
        shop.buy(shop.state.value.products.first())
        assertEquals(ShopNotice.Kind.CAP, shop.state.value.notice?.kind)
        assertEquals(2, play.buys)
        // Thirty days on, the window has moved.
        clock += 30 * PaymentsConfig.DAY_MS
        shop.buy(shop.state.value.products.first())
        assertEquals(3, play.buys)
        assertEquals(250, center.state.value.balance)
    }

    @Test fun noStoreRowsWithoutPlayOrWithTheRailOff() = runBlocking {
        val (_, play, cs) = world()
        play.available = false
        cs.first.refresh()
        cs.second.load()
        assertFalse(cs.second.state.value.available)

        val com = FakeCom().apply { googleRail = false }
        val (_, _, cs2) = world(com = com)
        cs2.first.refresh()
        cs2.second.load()
        assertFalse(cs2.second.state.value.available)
    }

    @Test fun aNonAdminDeviceNeverBuysOrResumes() = runBlocking {
        val (com, play, cs) = world(admin = false)
        val (center, shop) = cs
        center.refresh()
        shop.load()
        assertFalse(shop.state.value.available)
        play.owned["tok-x"] = StorePurchase("tok-x", listOf("com.flagshipserver.app.vouchers.10"), 1, StoreState.PURCHASED)
        shop.buy(ShopProduct(10, "com.flagshipserver.app.vouchers.10", "US$10.00"))
        shop.resume()
        assertEquals(0, play.buys)
        assertTrue(com.issues.isEmpty())
    }

    @Test fun anOtherAppsPurchaseIsLeftAlone() = runBlocking {
        val (com, play, cs) = world()
        val (center, shop) = cs
        center.refresh()
        play.owned["tok-y"] = StorePurchase("tok-y", listOf("com.example.coins"), 1, StoreState.PURCHASED)
        shop.load()
        assertTrue(com.issues.isEmpty())
        assertEquals(1, play.owned.size)
    }
}
