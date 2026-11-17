// Google Play Billing behind a small seam (docs/payments-privacy-and-rails.md §11 "Google"), so the voucher shop runs
// against a fake in JVM tests and the UI gym. The live one wraps the Play Billing Library's BillingClient. A purchase
// never carries an obfuscated account or profile id: Play learns nothing that names the Flagship account.

package com.flagshipserver.app.core.payments

import android.app.Activity
import android.content.Context
import android.os.Build
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

enum class StoreState { PURCHASED, PENDING, OTHER }

/** One Play purchase as the shop sees it. [token] is the purchase token (the payment's id at `.com`). */
data class StorePurchase(val token: String, val products: List<String>, val quantity: Int, val state: StoreState)

/** A product Play sells, with its price as Play formats it for this person. */
data class StoreProduct(val productId: String, val price: String)

sealed interface BuyOutcome {
    /** Play's sheet ended with these purchases (purchased or pending). */
    data class Bought(val purchases: List<StorePurchase>) : BuyOutcome
    data object Canceled : BuyOutcome
    /** The product is already bought and not consumed yet: the shop resumes it. */
    data object AlreadyOwned : BuyOutcome
    data object Unavailable : BuyOutcome
    data class Failed(val code: Int) : BuyOutcome
}

enum class ConsumeOutcome { OK, GONE, FAILED }

interface PlayBilling {
    /** Connect to Play. False when billing isn't available here (no Play Store, an account that can't pay, ...). */
    suspend fun connect(): Boolean
    /** The products Play knows among [ids] (one-time, `INAPP`). */
    suspend fun products(ids: List<String>): List<StoreProduct>
    /** Open Play's purchase sheet for [productId] and wait for its answer. */
    suspend fun buy(productId: String): BuyOutcome
    /** The one-time purchases not consumed yet, or null when Play didn't answer. */
    suspend fun owned(): List<StorePurchase>?
    suspend fun consume(token: String): ConsumeOutcome
    /** Purchases Play reports outside a [buy] (a pending one that completed later). */
    var onPurchases: ((List<StorePurchase>) -> Unit)?
}

/** Was this copy installed by Google Play? A release build sells only then (a sideloaded copy can't use Play Billing). */
object PlayInstall {
    const val PLAY_STORE = "com.android.vending"

    fun fromPlay(context: Context): Boolean = runCatching {
        val pm = context.packageManager
        val installer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            pm.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(context.packageName)
        }
        installer == PLAY_STORE
    }.getOrDefault(false)
}

class LivePlayBilling(
    context: Context,
    /** The activity Play's sheet opens over. */
    private val activity: () -> Activity?,
) : PlayBilling {
    override var onPurchases: ((List<StorePurchase>) -> Unit)? = null

    private val details = HashMap<String, ProductDetails>()
    private val connectLock = Mutex()
    @Volatile private var waiting: CompletableDeferred<BuyOutcome>? = null

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases ->
            val list = purchases.orEmpty().map(::toStore)
            val w = waiting
            if (w != null && !w.isCompleted) {
                waiting = null
                w.complete(outcome(result, list))
            } else if (result.responseCode == BillingClient.BillingResponseCode.OK && list.isNotEmpty()) {
                onPurchases?.invoke(list)
            }
        }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    private fun toStore(p: Purchase) = StorePurchase(
        token = p.purchaseToken,
        products = p.products,
        quantity = p.quantity.coerceAtLeast(1),
        state = when (p.purchaseState) {
            Purchase.PurchaseState.PURCHASED -> StoreState.PURCHASED
            Purchase.PurchaseState.PENDING -> StoreState.PENDING
            else -> StoreState.OTHER
        },
    )

    private fun outcome(r: BillingResult, list: List<StorePurchase>): BuyOutcome = when (r.responseCode) {
        BillingClient.BillingResponseCode.OK -> BuyOutcome.Bought(list)
        BillingClient.BillingResponseCode.USER_CANCELED -> BuyOutcome.Canceled
        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> BuyOutcome.AlreadyOwned
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED -> BuyOutcome.Unavailable
        else -> BuyOutcome.Failed(r.responseCode)
    }

    override suspend fun connect(): Boolean = connectLock.withLock {
        if (client.isReady) return true
        suspendCancellableCoroutine { cont ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (cont.isActive) cont.resume(result.responseCode == BillingClient.BillingResponseCode.OK)
                }

                override fun onBillingServiceDisconnected() {
                    if (cont.isActive) cont.resume(false)
                }
            })
        }
    }

    override suspend fun products(ids: List<String>): List<StoreProduct> {
        if (ids.isEmpty() || !connect()) return emptyList()
        val params = QueryProductDetailsParams.newBuilder().setProductList(
            ids.map { QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(BillingClient.ProductType.INAPP).build() },
        ).build()
        val found: List<ProductDetails> = suspendCancellableCoroutine { cont ->
            client.queryProductDetailsAsync(params) { result, out ->
                if (cont.isActive) cont.resume(if (result.responseCode == BillingClient.BillingResponseCode.OK) out.productDetailsList else emptyList())
            }
        }
        return found.mapNotNull { d ->
            val price = d.oneTimePurchaseOfferDetails?.formattedPrice ?: return@mapNotNull null
            details[d.productId] = d
            StoreProduct(d.productId, price)
        }
    }

    override suspend fun buy(productId: String): BuyOutcome {
        if (!connect()) return BuyOutcome.Unavailable
        val d = details[productId] ?: run { products(listOf(productId)); details[productId] } ?: return BuyOutcome.Unavailable
        val act = activity() ?: return BuyOutcome.Failed(BillingClient.BillingResponseCode.ERROR)
        val item = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d)
        d.oneTimePurchaseOfferDetails?.offerToken?.let(item::setOfferToken)
        // Deliberately no setObfuscatedAccountId / setObfuscatedProfileId: the purchase names no Flagship account.
        val params = BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(item.build())).build()
        val w = CompletableDeferred<BuyOutcome>()
        waiting = w
        val started = client.launchBillingFlow(act, params)
        if (started.responseCode != BillingClient.BillingResponseCode.OK) {
            waiting = null
            return outcome(started, emptyList())
        }
        return w.await()
    }

    override suspend fun owned(): List<StorePurchase>? {
        if (!connect()) return null
        val params = QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()
        return suspendCancellableCoroutine { cont ->
            client.queryPurchasesAsync(params) { result, list ->
                if (cont.isActive) cont.resume(if (result.responseCode == BillingClient.BillingResponseCode.OK) list.map(::toStore) else null)
            }
        }
    }

    companion object {
        /** The activity in front (set by MainActivity on start); Play's sheet opens over it. */
        @Volatile var front: java.lang.ref.WeakReference<Activity>? = null
        @Volatile private var instance: LivePlayBilling? = null

        /** One client per process (a recreated activity reuses it). */
        fun shared(context: Context): LivePlayBilling = instance ?: synchronized(this) {
            instance ?: LivePlayBilling(context) { front?.get() }.also { instance = it }
        }
    }

    override suspend fun consume(token: String): ConsumeOutcome {
        if (!connect()) return ConsumeOutcome.FAILED
        val params = ConsumeParams.newBuilder().setPurchaseToken(token).build()
        return suspendCancellableCoroutine { cont ->
            client.consumeAsync(params) { result, _ ->
                if (cont.isActive) cont.resume(
                    when (result.responseCode) {
                        BillingClient.BillingResponseCode.OK -> ConsumeOutcome.OK
                        BillingClient.BillingResponseCode.ITEM_NOT_OWNED -> ConsumeOutcome.GONE
                        else -> ConsumeOutcome.FAILED
                    },
                )
            }
        }
    }
}
