// Opening a voucher link on the phone (PaymentsCenter.previewLink / addFromLink, docs/anonymous-vouchers.md
// "Voucher links", "Failure handling"): checked against the keys held here, added without the network, synced later,
// a second open adds nothing, forged / spent / damaged links say so, and only an admin device adds.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.AllowanceState
import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.api.PlanState
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.VoiciVectorsTest.Companion.vectorsFile
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class VoucherLinkCenterTest {
    private val V = Json.parseToJsonElement(vectorsFile("packages/protocol/test-vectors/voucher-link/vectors.json").readText()).jsonObject
    private val key = V["key"]!!.jsonObject.let { VoucherKey(it["keyId"]!!.jsonPrimitive.content, it["nHex"]!!.jsonPrimitive.content, it["eHex"]!!.jsonPrimitive.content) }
    private val vouchers = V["vouchers"]!!.jsonArray.map { Vouchers.parse(it)!! }
    private val single = V["links"]!!.jsonObject["single"]!!.jsonArray[0].jsonPrimitive.content

    private inner class Com : PaymentsClient {
        var offline = false
        var version = 0L
        var blob: JsonObject? = null
        var configCalls = 0
        private fun net() { if (offline) throw IOException("offline") }
        override suspend fun config(): JsonObject? {
            configCalls++
            if (offline) return null
            return JsonObject(mapOf(
                "config" to PaymentsConfig.DEFAULT.toJson(),
                "keys" to JsonArray(listOf(JsonObject(mapOf("keyId" to JsonPrimitive(key.keyId), "nHex" to JsonPrimitive(key.nHex), "eHex" to JsonPrimitive(key.eHex))))),
            ))
        }
        override suspend fun wallet(username: String): JsonObject? { net(); return blob }
        override suspend fun putWallet(username: String, device: VoiciDeviceSigner, blob: JsonObject) {
            net()
            val v = VoiciJs.time(blob["version"])!!
            if (v != version + 1) throw PaymentsHttpError(409, "version-conflict", JsonObject(mapOf("code" to JsonPrimitive("version-conflict"), "wallet" to (this.blob ?: JsonNull))))
            version = v
            this.blob = blob
        }
        override suspend fun plan(username: String): PlanState? { net(); return PlanState("free", 0) }
        override suspend fun allowance(username: String): AllowanceState? = null
        override suspend fun redeem(body: JsonObject): JsonObject = error("not used")
        override suspend fun testIssue(keyId: String, blinded: List<String>): List<String> = error("not used")
        override suspend fun paidIssue(rail: String, proof: JsonObject, keyId: String, blinded: List<String>) = error("not used")
    }

    private class Keys(var admin: Boolean = true, var user: String? = "plucky-avocet", var open: Boolean = true) : PaymentsKeyring {
        val umk = ByteArray(32) { 0x7a }
        override fun username() = user
        override fun umk() = if (open) umk else null
        override fun device(): VoiciDeviceSigner {
            val kp = Ed25519Sign.KeyPair.newKeyPair()
            return VoiciDeviceSigner("d0".repeat(16), VoiciJs.hex(kp.publicKey), Ed25519Sign(kp.privateKey))
        }
        override fun isAdmin() = admin
        override suspend fun confirm(reason: String) {}
    }

    private fun remoteVouchers(com: Com, keys: Keys) =
        VoucherWallets.open(VoucherWallets.deriveKey(keys.umk), com.blob)?.vouchers.orEmpty()

    @Test fun addsAndSyncs() = runBlocking {
        val com = Com(); val keys = Keys(); val local = MemoryPaymentsLocalStore()
        val c = PaymentsCenter(com, keys, local)
        c.refresh()
        val p = c.previewLink(single) as VoucherLinkPreview.Ask
        assertEquals(3, p.plan.add.size)
        assertEquals(1 to 1, p.part to p.parts)
        assertTrue(c.addFromLink(p.plan))
        assertEquals(vouchers.take(3).map { it.nullifier }.toSet(), remoteVouchers(com, keys).map { it.nullifier }.toSet())
    }

    @Test fun secondOpenAddsNothing() = runBlocking {
        val com = Com(); val keys = Keys()
        val c = PaymentsCenter(com, keys, MemoryPaymentsLocalStore())
        c.refresh()
        c.addFromLink((c.previewLink(single) as VoucherLinkPreview.Ask).plan)
        val versionAfterFirst = com.version
        assertEquals(VoucherLinkPreview.Refused("already"), c.previewLink(single))
        assertEquals(versionAfterFirst, com.version)
        assertEquals(3, c.state.value.balance)
    }

    @Test fun offlineAddUsesTheCachedKeysAndSyncsAfterARestart() = runBlocking {
        val com = Com(); val keys = Keys(); val local = MemoryPaymentsLocalStore()
        PaymentsCenter(com, keys, local).refresh() // keys and the wallet seen once while online
        com.offline = true
        val cold = PaymentsCenter(com, keys, local) // a new process, offline
        val calls = com.configCalls
        val p = cold.previewLink(single) as VoucherLinkPreview.Ask
        assertEquals(calls, com.configCalls) // the check made no network call
        assertTrue(cold.addFromLink(p.plan))
        assertTrue(remoteVouchers(com, keys).isEmpty())
        com.offline = false
        val later = PaymentsCenter(com, keys, local) // another restart, back online
        later.refresh()
        assertEquals(3, remoteVouchers(com, keys).size)
        assertEquals(3, later.state.value.balance)
    }

    @Test fun neverSeenAKeyAsksForPlanOnce() = runBlocking {
        val com = Com().apply { offline = true }
        val c = PaymentsCenter(com, Keys(), MemoryPaymentsLocalStore())
        assertEquals(VoucherLinkPreview.Refused("unknown-key"), c.previewLink(single))
    }

    @Test fun forgedSpentAndDamaged() = runBlocking {
        val com = Com(); val keys = Keys()
        val c = PaymentsCenter(com, keys, MemoryPaymentsLocalStore())
        c.refresh()
        val forged = Vouchers.parse(V["forged"])!!
        assertEquals(VoucherLinkPreview.Refused("invalid"), c.previewLink(VoucherLink.encodeLinks(listOf(forged), "flagshipserver.com")[0]))
        assertEquals(VoucherLinkPreview.Refused("damaged"), c.previewLink(single.dropLast(40)))
        assertEquals(VoucherLinkPreview.Refused("damaged"), c.previewLink("https://flagshipserver.com/app/vouchers"))
        // Spent from this wallet: the trickle marked them spent.
        c.addFromLink((c.previewLink(single) as VoucherLinkPreview.Ask).plan)
        val w = c.state.value.wallet!!
        com.blob = VoucherWallets.seal(VoucherWallets.deriveKey(keys.umk), com.version + 1, VoucherWallets.markSpent(w, vouchers.take(3).map { it.nullifier }))
        com.version += 1
        val fresh = PaymentsCenter(com, keys, MemoryPaymentsLocalStore())
        fresh.refresh()
        assertEquals(VoucherLinkPreview.Refused("spent"), fresh.previewLink(single))
    }

    @Test fun onlyAnAdminDeviceWithTheKeyAdds() = runBlocking {
        val com = Com()
        val c = PaymentsCenter(com, Keys(admin = false), MemoryPaymentsLocalStore())
        c.refresh()
        assertEquals(VoucherLinkPreview.Refused("not-admin"), c.previewLink(single))
        assertEquals(VoucherLinkPreview.Refused("signed-out"), PaymentsCenter(com, Keys(user = null), MemoryPaymentsLocalStore()).previewLink(single))
        assertEquals(VoucherLinkPreview.Refused("signed-out"), PaymentsCenter(com, Keys(open = false), MemoryPaymentsLocalStore()).previewLink(single))
        assertFalse(PaymentsCenter(com, Keys(admin = false), MemoryPaymentsLocalStore()).addFromLink(VoucherLink.plan(VoucherWallets.empty(10), vouchers.take(1), listOf(key))))
    }

    @Test fun refusalSentencesCoverEveryCode() {
        for (code in listOf("damaged", "newer", "already", "spent", "invalid", "unknown-key", "full", "not-admin", "signed-out")) {
            VoucherLinkCopy.refusalRes(code)
        }
        assertEquals(VoucherLinkCopy.refusalRes("damaged"), VoucherLinkCopy.refusalRes("whatever"))
    }
}
