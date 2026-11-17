// What the voucher shop keeps on this device (docs/payments-privacy-and-rails.md §11): the blinded requests of a store
// purchase until its vouchers are in the wallet and the purchase is consumed, and the device's purchase log for its
// cap (units and UTC day only). Both live in the keystore-backed encrypted preferences: a request's blinding inverse is
// secret (with it the signer could link the voucher to the purchase).

package com.flagshipserver.app.core.payments

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.flagshipserver.app.core.voici.VoiciJs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One request of a purchase: what the device keeps ([pending]) and what it sends ([blinded]). */
data class ShopRequest(val pending: PendingVoucher, val blinded: String)

/** A store purchase in flight, keyed by its purchase token. [saved]: the wallet at `.com` holds its vouchers. */
data class PendingPurchase(
    val token: String,
    val productId: String,
    val units: Long,
    val k: String,
    val requests: List<ShopRequest>,
    val saved: Boolean = false,
) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "token" to JsonPrimitive(token),
            "productId" to JsonPrimitive(productId),
            "units" to JsonPrimitive(units),
            "k" to JsonPrimitive(k),
            "requests" to JsonArray(
                requests.map { r ->
                    JsonObject(
                        linkedMapOf(
                            "k" to JsonPrimitive(r.pending.k), "p" to JsonPrimitive(r.pending.p), "n" to JsonPrimitive(r.pending.n),
                            "inv" to JsonPrimitive(r.pending.inv), "b" to JsonPrimitive(r.blinded),
                        ),
                    )
                },
            ),
            "saved" to JsonPrimitive(saved),
        ),
    )

    companion object {
        fun parse(e: JsonElement?): PendingPurchase? {
            val o = VoiciJs.obj(e) ?: return null
            val reqs = VoiciJs.arr(o["requests"])?.map { r ->
                val x = VoiciJs.obj(r) ?: return null
                ShopRequest(
                    PendingVoucher(VoiciJs.str(x["k"]) ?: return null, VoiciJs.str(x["p"]) ?: return null, VoiciJs.str(x["n"]) ?: return null, VoiciJs.str(x["inv"]) ?: return null),
                    VoiciJs.str(x["b"]) ?: return null,
                )
            } ?: return null
            return PendingPurchase(
                VoiciJs.str(o["token"]) ?: return null,
                VoiciJs.str(o["productId"]) ?: return null,
                VoiciJs.safeInt(o["units"]) ?: return null,
                VoiciJs.str(o["k"]) ?: return null,
                reqs,
                (o["saved"] as? JsonPrimitive)?.content == "true",
            )
        }
    }
}

/** One line of the device's purchase log: [units] bought on UTC [day] (days since the epoch). Nothing else. */
data class CapEntry(val day: Long, val units: Long)

interface ShopStore {
    fun pending(): List<PendingPurchase>
    fun put(p: PendingPurchase)
    fun remove(token: String)
    fun capLog(): List<CapEntry>
    fun setCapLog(entries: List<CapEntry>)
}

class MemoryShopStore : ShopStore {
    private val map = LinkedHashMap<String, PendingPurchase>()
    private var log = emptyList<CapEntry>()
    override fun pending() = synchronized(this) { map.values.toList() }
    override fun put(p: PendingPurchase) { synchronized(this) { map[p.token] = p } }
    override fun remove(token: String) { synchronized(this) { map.remove(token) } }
    override fun capLog() = log
    override fun setCapLog(entries: List<CapEntry>) { log = entries }
}

class EncryptedShopStore(context: Context) : ShopStore {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context.applicationContext,
        FILE_NAME,
        MasterKey.Builder(context.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private fun readMap(): Map<String, PendingPurchase> {
        val raw = prefs.getString(PENDING, null) ?: return emptyMap()
        val o = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return emptyMap()
        return o.mapNotNull { (k, v) -> PendingPurchase.parse(v)?.let { k to it } }.toMap()
    }

    private fun writeMap(m: Map<String, PendingPurchase>) {
        // commit, not apply: the requests must be on disk before `.com` is asked to sign them.
        prefs.edit().putString(PENDING, JsonObject(m.mapValues { it.value.toJson() }).toString()).commit()
    }

    override fun pending() = synchronized(this) { readMap().values.toList() }
    override fun put(p: PendingPurchase) { synchronized(this) { writeMap(readMap() + (p.token to p)) } }
    override fun remove(token: String) { synchronized(this) { writeMap(readMap() - token) } }

    override fun capLog(): List<CapEntry> = synchronized(this) {
        val raw = prefs.getString(CAP, null) ?: return emptyList()
        val a = runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return emptyList()
        a.mapNotNull { e ->
            val x = VoiciJs.arr(e)?.takeIf { it.size == 2 } ?: return@mapNotNull null
            CapEntry(VoiciJs.safeInt(x[0]) ?: return@mapNotNull null, VoiciJs.safeInt(x[1]) ?: return@mapNotNull null)
        }
    }

    override fun setCapLog(entries: List<CapEntry>) {
        synchronized(this) {
            prefs.edit().putString(CAP, JsonArray(entries.map { JsonArray(listOf(JsonPrimitive(it.day), JsonPrimitive(it.units))) }).toString()).commit()
        }
    }

    private companion object {
        const val FILE_NAME = "flagship-voucher-shop"
        const val PENDING = "pending"
        const val CAP = "cap"
    }
}
