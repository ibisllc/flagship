// A scripted Google Play for the UI gym (debug builds only): every voucher pack is on sale at its dollar price, a buy
// succeeds at once with a fresh purchase token, and a purchase stays owned until it is consumed. MockPaymentsClient's
// paid-issue accepts these tokens.

package com.flagshipserver.app.core.payments

import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

class MockPlayBilling(
    /** What the next buy does (the gym's scenarios may change it). */
    var next: (productId: String, token: String) -> BuyOutcome = { id, token -> BuyOutcome.Bought(listOf(StorePurchase(token, listOf(id), 1, StoreState.PURCHASED))) },
) : PlayBilling {
    override var onPurchases: ((List<StorePurchase>) -> Unit)? = null
    private val owned = LinkedHashMap<String, StorePurchase>()
    private var seq = 0

    override suspend fun connect() = true

    override suspend fun products(ids: List<String>): List<StoreProduct> = ids.mapNotNull { id ->
        val units = VoucherProduct.units(id) ?: return@mapNotNull null
        val f = NumberFormat.getCurrencyInstance(Locale.getDefault()).apply { currency = Currency.getInstance("USD") }
        StoreProduct(id, f.format(units))
    }

    override suspend fun buy(productId: String): BuyOutcome {
        val out = next(productId, "$TOKEN_PREFIX${++seq}-${System.nanoTime()}")
        if (out is BuyOutcome.Bought) out.purchases.forEach { owned[it.token] = it }
        return out
    }

    override suspend fun owned(): List<StorePurchase> = owned.values.toList()

    override suspend fun consume(token: String): ConsumeOutcome = if (owned.remove(token) != null) ConsumeOutcome.OK else ConsumeOutcome.GONE

    companion object {
        const val TOKEN_PREFIX = "gym-play-"
    }
}
