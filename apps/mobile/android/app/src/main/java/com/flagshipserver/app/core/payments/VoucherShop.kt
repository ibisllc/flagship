// The Google Play voucher shop (docs/payments-privacy-and-rails.md §11 "Google"). A payment buys the right to N blind
// signatures, never an account link:
//
//   1. Play's sheet sells a pack (`com.flagshipserver.app.vouchers.<units>`, one-time, no obfuscated ids).
//   2. The phone makes units × quantity voucher requests and keeps them (keyed by the purchase token) BEFORE asking
//      `.com`, so a crash never loses a paid-for set: the same set is sent again, and `.com` answers it again.
//   3. `POST /api/vouchers/paid-issue` with {productId, purchaseToken}; the signatures are unblinded into vouchers.
//   4. The vouchers go into the wallet through the normal save path (compare-and-set at `.com`).
//   5. Only then is the purchase consumed, and the kept requests deleted.
//
// At start and on Plan, unconsumed purchases are resumed the same way. A pending payment waits; a refunded one is
// consumed with nothing added. Each phone buys at most CAP_UNITS vouchers in CAP_DAYS days (the log keeps units and
// the UTC day only). Only an admin device buys, like every other spend control.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.PaidIssue
import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.PaymentsHttpError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A pack on sale here: [price] as Play formats it. */
data class ShopProduct(val units: Long, val productId: String, val price: String)

/** What the last shop step came to (PlanScreen turns it into a sentence). [code] is `.com`'s refusal code. */
data class ShopNotice(val kind: Kind, val units: Long = 0, val code: String? = null) {
    enum class Kind { ADDED, PENDING, RETRY, REFUNDED, REFUSED, CAP, PLAY_FAILED }
}

data class ShopUi(
    /** Play Billing works here, the Google rail is on and Play knows the packs. */
    val available: Boolean = false,
    val products: List<ShopProduct> = emptyList(),
    val working: Boolean = false,
    val notice: ShopNotice? = null,
)

class VoucherShop(
    private val billing: PlayBilling?,
    private val client: PaymentsClient,
    private val center: PaymentsCenter,
    private val store: ShopStore,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(ShopUi())
    val state: StateFlow<ShopUi> = _state.asStateFlow()

    init {
        // A pending payment that completes while the app is open.
        billing?.onPurchases = { list -> scope.launch { mutex.withLock { list.forEach { handle(it) } } } }
    }

    private fun day(t: Long = now()) = Math.floorDiv(t, PaymentsConfig.DAY_MS)

    /** Units this device bought in the last CAP_DAYS days. */
    fun boughtRecently(): Long {
        val from = day() - CAP_DAYS + 1
        return store.capLog().filter { it.day >= from }.sumOf { it.units }
    }

    private fun logPurchase(units: Long) {
        val from = day() - CAP_DAYS + 1
        store.setCapLog(store.capLog().filter { it.day >= from } + CapEntry(day(), units))
    }

    /** Connect to Play, list the packs (only when the Google rail is on), then resume anything unfinished. */
    suspend fun load() = mutex.withLock {
        val s = center.state.value
        val b = billing
        if (b == null || !b.connect()) {
            _state.update { it.copy(available = false, products = emptyList()) }
            return@withLock
        }
        if (s.rails.google && s.canSpend) {
            val byId = s.products.associateBy { it.productId }
            val found = runCatching { b.products(byId.keys.toList()) }.getOrDefault(emptyList())
            val products = found.mapNotNull { p -> byId[p.productId]?.let { ShopProduct(it.units, it.productId, p.price) } }.sortedBy { it.units }
            _state.update { it.copy(available = products.isNotEmpty(), products = products) }
        } else {
            _state.update { it.copy(available = false, products = emptyList()) }
        }
        resumeLocked()
    }

    /** Finish any purchase of ours that Play still holds unconsumed, and drop what is done. */
    suspend fun resume() = mutex.withLock { resumeLocked() }

    private suspend fun resumeLocked() {
        val b = billing ?: return
        if (!center.state.value.canSpend) return
        val owned = runCatching { b.owned() }.getOrNull() ?: return
        val ours = owned.filter { p -> p.products.any { VoucherProduct.units(it) != null } }
        if (ours.isEmpty() && store.pending().isEmpty()) return
        working(true)
        try {
            for (p in ours) handle(p)
            val tokens = owned.map { it.token }.toSet()
            for (entry in store.pending()) {
                if (entry.token in tokens) continue
                // Play no longer holds it: consumed already, or refunded. A saved one is done; an unsaved one gets one
                // more try with its kept set (the proof still checks at `.com`) and is dropped on a final refusal.
                if (entry.saved) store.remove(entry.token) else deliver(entry, stale = true)
            }
        } finally {
            working(false)
        }
    }

    /** Buy [product] through Play's sheet. */
    suspend fun buy(product: ShopProduct) = mutex.withLock {
        val b = billing ?: return@withLock
        if (!center.state.value.canSpend || _state.value.working) return@withLock
        if (boughtRecently() + product.units > CAP_UNITS) {
            notice(ShopNotice(ShopNotice.Kind.CAP))
            return@withLock
        }
        working(true)
        _state.update { it.copy(notice = null) }
        try {
            when (val out = b.buy(product.productId)) {
                is BuyOutcome.Bought -> out.purchases.forEach { handle(it) }
                BuyOutcome.AlreadyOwned -> resumeLocked()
                BuyOutcome.Canceled -> Unit
                BuyOutcome.Unavailable -> {
                    _state.update { it.copy(available = false, products = emptyList()) }
                    notice(ShopNotice(ShopNotice.Kind.PLAY_FAILED))
                }
                is BuyOutcome.Failed -> notice(ShopNotice(ShopNotice.Kind.PLAY_FAILED))
            }
        } finally {
            working(false)
        }
    }

    private fun working(on: Boolean) = _state.update { it.copy(working = on) }
    private fun notice(n: ShopNotice?) = _state.update { it.copy(notice = n) }

    private fun newRequests(key: VoucherKey, units: Long) = (0 until units).map { Vouchers.request(key).let { (p, b) -> ShopRequest(p, b) } }

    private suspend fun handle(p: StorePurchase) {
        val productId = p.products.firstOrNull { VoucherProduct.units(it) != null } ?: return
        when (p.state) {
            StoreState.PENDING -> return notice(ShopNotice(ShopNotice.Kind.PENDING))
            StoreState.OTHER -> return
            StoreState.PURCHASED -> Unit
        }
        if (!center.state.value.canSpend) return
        val entry = store.pending().firstOrNull { it.token == p.token } ?: run {
            val key = center.state.value.issuingKey ?: return notice(ShopNotice(ShopNotice.Kind.REFUSED, code = "no-key"))
            val units = VoucherProduct.units(productId)!! * p.quantity.coerceAtLeast(1)
            val fresh = PendingPurchase(p.token, productId, units, key.keyId, newRequests(key, units))
            // Kept before `.com` is asked: a crash after the signing still finds the same set.
            store.put(fresh)
            logPurchase(units)
            fresh
        }
        deliver(entry, stale = false)
    }

    private suspend fun deliver(start: PendingPurchase, stale: Boolean) {
        var entry = start
        if (!entry.saved) {
            var rebuilt = false
            var issued: PaidIssue? = null
            while (issued == null) {
                val proof = JsonObject(linkedMapOf("productId" to JsonPrimitive(entry.productId), "purchaseToken" to JsonPrimitive(entry.token)))
                try {
                    issued = client.paidIssue(RAIL, proof, entry.k, entry.requests.map { it.blinded })
                } catch (e: PaymentsHttpError) {
                    val code = e.code ?: "unavailable"
                    // Nothing was signed for this payment yet: a fresh set (the right count, the issuing key) may go once.
                    val issuing = center.state.value.issuingKey
                    val units = (e.body["units"] as? JsonPrimitive)?.content?.toLongOrNull()
                    if (!rebuilt && issuing != null && code == "wrong-count" && units != null && units in 1..MAX_UNITS && units != entry.units) {
                        entry = entry.copy(units = units, k = issuing.keyId, requests = newRequests(issuing, units))
                    } else if (!rebuilt && issuing != null && code == "no-key" && issuing.keyId != entry.k) {
                        entry = entry.copy(k = issuing.keyId, requests = newRequests(issuing, entry.units))
                    } else {
                        return refused(entry, code, stale)
                    }
                    store.put(entry)
                    rebuilt = true
                } catch (_: Exception) {
                    return notice(ShopNotice(ShopNotice.Kind.RETRY))
                }
            }
            val got = issued!!
            val key = center.key(entry.k)
            val fresh = runCatching {
                require(key != null && got.k == entry.k && got.sigs.size == entry.requests.size)
                entry.requests.mapIndexed { i, r -> Vouchers.finalize(key!!, r.pending, got.sigs[i]) }
            }.getOrNull() ?: return notice(ShopNotice(ShopNotice.Kind.REFUSED, code = "malformed"))
            if (!center.addPaidVouchers(fresh)) return notice(ShopNotice(ShopNotice.Kind.RETRY))
            entry = entry.copy(saved = true)
            store.put(entry)
        }
        when (billing?.consume(entry.token)) {
            ConsumeOutcome.OK, ConsumeOutcome.GONE -> store.remove(entry.token)
            else -> Unit // kept as saved: the next resume consumes it without asking `.com` again
        }
        if (!stale) notice(ShopNotice(ShopNotice.Kind.ADDED, units = entry.units))
    }

    private suspend fun refused(entry: PendingPurchase, code: String, stale: Boolean) {
        when (code) {
            "payment-refunded" -> {
                // Refunded: nothing is added, and the purchase is finished so Play stops offering it back.
                billing?.consume(entry.token)
                store.remove(entry.token)
                if (!stale) notice(ShopNotice(ShopNotice.Kind.REFUNDED))
            }
            "payment-unpaid", "rail-unreachable", "unavailable" -> notice(ShopNotice(ShopNotice.Kind.RETRY))
            else -> {
                // payment-used, payment-invalid and the rest: kept on this phone (never consumed), and said.
                if (stale) store.remove(entry.token) else notice(ShopNotice(ShopNotice.Kind.REFUSED, code = code))
            }
        }
    }

    companion object {
        const val RAIL = "google"
        const val CAP_UNITS = 240L
        const val CAP_DAYS = 30L
        private const val MAX_UNITS = 1000L
        @Volatile var shared: VoucherShop? = null
    }
}
