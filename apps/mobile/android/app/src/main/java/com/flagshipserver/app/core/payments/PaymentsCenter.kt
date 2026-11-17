// The phone's wallet and its spending (docs/payments-privacy-and-rails.md "As built", owner decision 2026-11-17: the
// phones hold and spend the vouchers). Same rules as iOS PaymentsCenter and the webapp's lib/payments.js:
//
// - The wallet is sealed under a key from the UMK and synced like the call hours (VoucherWallets); a version conflict
//   opens the stored copy, merges and writes again.
// - Only an admin device with the UMK spends; another device shows the plan read only. Background work never prompts:
//   without the UMK a tick simply waits for the next unlock.
// - The trickle spends one voucher at a time at random moments ahead of need (VoucherWallets.trickleStep), and at once
//   when the plan is about to lapse; the overage rule buys one prepaid block when the month's bytes run low, within
//   the owner's cap. A spend carries no credential and no device id.
// - Choosing a paid plan that spends at once is a consent: the biometric prompt comes first.

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.api.VoiciDeviceSigner
import com.flagshipserver.app.core.voici.VoiciJs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.security.SecureRandom

/** What PaymentsCenter needs from the device. */
interface PaymentsKeyring {
    fun username(): String?
    fun umk(): ByteArray?
    fun device(): VoiciDeviceSigner?
    /** This device holds the account's admin root (only admin devices spend). */
    fun isAdmin(): Boolean
    /** The biometric before a spend the owner asked for. Throws when refused. */
    suspend fun confirm(reason: String)
}

/** Device-local state: when the next unhurried spend is due (never synced). */
interface PaymentsLocalStore {
    var nextSpendAt: Long
}

class PrefsPaymentsLocalStore(context: android.content.Context) : PaymentsLocalStore {
    private val prefs = context.applicationContext.getSharedPreferences("flagship.payments", android.content.Context.MODE_PRIVATE)
    override var nextSpendAt: Long
        get() = prefs.getLong("nextSpendAt", 0)
        set(v) { prefs.edit().putLong("nextSpendAt", v).apply() }
}

class MemoryPaymentsLocalStore : PaymentsLocalStore {
    override var nextSpendAt: Long = 0
}

data class PaymentsUi(
    val loaded: Boolean = false,
    val config: PaymentsConfig = PaymentsConfig.DEFAULT,
    val keys: List<VoucherKey> = emptyList(),
    val issuingKey: VoucherKey? = null,
    val testIssue: Boolean = false,
    /** The current plan at `.com` (null: Free) and when it is paid until. */
    val plan: String? = null,
    val paidUntil: Long = 0,
    val wallet: VoucherWallet? = null,
    val version: Long = 0,
    val isAdmin: Boolean = false,
    /** The wallet can be opened here (the UMK is available). */
    val canOpen: Boolean = false,
    val remainingBytes: Long? = null,
    val quotaBytes: Long? = null,
    val busy: Boolean = false,
    /** The last refusal code (PaymentsCopy turns it into a sentence). */
    val error: String? = null,
) {
    val balance: Int get() = wallet?.balance ?: 0
    val chosenPlan: String? get() = wallet?.settings?.plan
    val canSpend: Boolean get() = isAdmin && canOpen && wallet != null
}

class PaymentsCenter(
    private val client: PaymentsClient,
    private val keyring: PaymentsKeyring,
    private val local: PaymentsLocalStore = MemoryPaymentsLocalStore(),
    private val now: () -> Long = System::currentTimeMillis,
    private val rand: () -> Double = { SecureRandom().nextDouble() },
) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(PaymentsUi())
    val state: StateFlow<PaymentsUi> = _state.asStateFlow()

    private fun user() = keyring.username()?.lowercase()?.takeIf { it.isNotEmpty() }

    /** Read the config, the plan, the month's bytes and the wallet. */
    suspend fun refresh() = mutex.withLock { refreshLocked() }

    private suspend fun refreshLocked() {
        val u = user() ?: return
        val cfgJson = runCatching { client.config() }.getOrNull()
        val cfg = PaymentsConfig.merge(cfgJson?.get("config"))
        val keys = (cfgJson?.get("keys") as? JsonArray).orEmpty().mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val k = VoucherKey(VoiciJs.str(o["keyId"]) ?: return@mapNotNull null, VoiciJs.str(o["nHex"]) ?: return@mapNotNull null, VoiciJs.str(o["eHex"]) ?: return@mapNotNull null)
            if (Vouchers.rsa(k) == null) null else k to ((o["issuing"] as? JsonPrimitive)?.contentOrNull != "false")
        }
        val plan = runCatching { client.plan(u) }.getOrNull()
        val allowance = client.allowance(u)
        val umk = keyring.umk()
        var wallet: VoucherWallet? = null
        var version = 0L
        val fetched = if (umk != null) runCatching { client.wallet(u) } else null
        if (umk != null && fetched != null && fetched.isFailure) {
            // Offline: keep what this device has.
            wallet = _state.value.wallet
            version = _state.value.version
        } else if (umk != null && fetched != null) {
            val blob = fetched.getOrNull()
            version = VoucherWallets.version(blob)
            // A stored wallet this device can't open is never replaced by an empty one (it would lose the vouchers).
            wallet = if (blob == null) VoucherWallets.empty(cfg.overage.defaultCapUnits) else VoucherWallets.open(VoucherWallets.deriveKey(umk), blob)
            val mine = _state.value.wallet
            if (wallet != null && mine != null && _state.value.version >= version) wallet = VoucherWallets.merge(mine, wallet)
        }
        _state.update {
            it.copy(
                loaded = true,
                config = cfg,
                keys = keys.map { k -> k.first },
                issuingKey = keys.firstOrNull { k -> k.second }?.first,
                testIssue = (cfgJson?.get("testIssue") as? JsonPrimitive)?.contentOrNull == "true",
                plan = if (plan != null) PaymentsConfig.planOfTier(plan.tier) else it.plan,
                paidUntil = plan?.paidUntil ?: it.paidUntil,
                wallet = wallet,
                version = maxOf(version, if (wallet != null) it.version else 0),
                isAdmin = keyring.isAdmin(),
                canOpen = umk != null,
                remainingBytes = allowance?.remainingBytes ?: it.remainingBytes,
                quotaBytes = allowance?.quotaBytes ?: it.quotaBytes,
            )
        }
    }

    /** Change the wallet and write it as the next version; on a conflict merge with the stored copy and try again. */
    private suspend fun write(change: (VoucherWallet) -> VoucherWallet): Boolean {
        val u = user() ?: return false
        val umk = keyring.umk() ?: return false
        val device = keyring.device() ?: return false
        val key = VoucherWallets.deriveKey(umk)
        var base = _state.value.wallet ?: return false
        var version = _state.value.version
        for (attempt in 0 until 3) {
            val next = change(base)
            try {
                client.putWallet(u, device, VoucherWallets.seal(key, version + 1, next))
                _state.update { it.copy(wallet = next, version = version + 1) }
                return true
            } catch (e: PaymentsHttpError) {
                if (e.code != "version-conflict") return false
                val stored = e.body["wallet"]
                VoucherWallets.open(key, stored)?.let { remote -> base = VoucherWallets.merge(base, remote) }
                version = VoucherWallets.version(stored)
            } catch (_: Exception) {
                // Offline: keep the change here; the next write carries it.
                _state.update { it.copy(wallet = next) }
                return false
            }
        }
        return false
    }

    private fun settings() = _state.value.wallet?.settings

    /** The owner picks a plan (null: Free, which stops spending). A paid plan without the delay starts at once. */
    suspend fun choosePlan(plan: String?, delayStart: Boolean, reason: String): Boolean = mutex.withLock {
        val s = _state.value
        if (!s.canSpend || (plan != null && !PaymentsConfig.isPaidPlan(plan))) return false
        val t = now()
        val startAt = if (plan != null && delayStart) t + (rand() * s.config.activationDelayMaxHours * 3_600_000L).toLong() else 0L
        if (plan != null && !delayStart && wouldSpendNow(plan, t)) {
            try {
                keyring.confirm(reason)
            } catch (_: Exception) {
                return false
            }
        }
        val ok = write { w -> w.copy(settings = w.settings.copy(plan = plan, delayStart = delayStart, startAt = startAt, updatedAt = t)) }
        local.nextSpendAt = 0
        if (ok) tickLocked()
        ok
    }

    private fun wouldSpendNow(plan: String, t: Long): Boolean {
        val s = _state.value
        val cfg = s.config
        val ahead = VoucherWallets.planAheadMs(cfg, plan, s.plan, s.paidUntil, t)
        return s.balance > 0 && ahead < cfg.lowWaterDays * PaymentsConfig.DAY_MS
    }

    suspend fun setAutoPay(on: Boolean): Boolean = mutex.withLock {
        if (!_state.value.canSpend) return false
        write { w -> w.copy(settings = w.settings.copy(autoPay = on, updatedAt = now())) }
    }

    suspend fun setOverageCap(units: Long): Boolean = mutex.withLock {
        val s = _state.value
        if (!s.canSpend || units < 0 || units > s.config.overage.maxCapUnits) return false
        write { w -> w.copy(settings = w.settings.copy(overageCapUnits = units, updatedAt = now())) }
    }

    /** One tick of the trickle and the overage rule (foreground, Plan screen open). Never prompts. */
    suspend fun tick() = mutex.withLock { tickLocked() }

    private suspend fun tickLocked() {
        val s = _state.value
        val w = s.wallet ?: return
        if (!s.canSpend) return
        val cfg = s.config
        val t = now()
        val plan = w.settings.plan
        if (plan != null) {
            val out = VoucherWallets.trickleStep(
                TrickleInput(
                    now = t,
                    enabled = w.settings.autoPay,
                    balance = w.balance.toLong(),
                    aheadMs = VoucherWallets.planAheadMs(cfg, plan, s.plan, s.paidUntil, t),
                    startAt = w.settings.startAt,
                    nextSpendAt = local.nextSpendAt,
                    unitMs = cfg.unitMs(plan),
                    lowWaterMs = cfg.lowWaterDays * PaymentsConfig.DAY_MS,
                    highWaterMs = cfg.highWaterDays * PaymentsConfig.DAY_MS,
                    maxPerRequest = cfg.maxPerRequest,
                ),
                rand(),
            )
            local.nextSpendAt = out.nextSpendAt
            if (out.spend > 0) spend(out.spend.toInt(), plan, retry = true)
        }
        val after = _state.value
        val ww = after.wallet ?: return
        val period = VoucherWallets.overagePeriod(t)
        val active = after.plan != null && after.paidUntil + cfg.graceHours * 3_600_000L >= t
        val remaining = after.remainingBytes ?: return
        val buy = VoucherWallets.overageStep(
            OverageInput(
                paid = active,
                remainingBytes = remaining,
                buyBelowBytes = cfg.overage.buyBelowGb * GB,
                capUnits = ww.settings.overageCapUnits,
                spentUnits = if (ww.overagePeriod == period) ww.overageUnits else 0,
                blockUnits = cfg.overage.blockUnits,
                balance = ww.balance.toLong(),
            ),
        )
        if (buy) spend(cfg.overage.blockUnits.toInt(), OVERAGE, retry = true)
    }

    /** Spend [n] vouchers for [what] ("pro", "pro-max" or "overage"). */
    private suspend fun spend(n: Int, what: String, retry: Boolean) {
        val u = user() ?: return
        val w = _state.value.wallet ?: return
        val vouchers = VoucherWallets.take(w, n)
        if (vouchers.size < n && what == OVERAGE) return
        if (vouchers.isEmpty()) return
        val body = JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "username" to JsonPrimitive(u),
                "for" to JsonPrimitive(what),
                "vouchers" to JsonArray(vouchers.map { it.toJson() }),
            ),
        )
        _state.update { it.copy(busy = true, error = null) }
        try {
            val r = client.redeem(body)
            val t = now()
            val period = VoucherWallets.overagePeriod(t)
            write { cur ->
                val spent = VoucherWallets.markSpent(cur, vouchers.map { it.nullifier })
                if (what == OVERAGE) {
                    val units = (if (spent.overagePeriod == period) spent.overageUnits else 0) + vouchers.size
                    spent.copy(overagePeriod = period, overageUnits = units)
                } else spent
            }
            val paidUntil = (r["paidUntil"] as? JsonPrimitive)?.longOrNull
            val topUp = (r["topUpBytes"] as? JsonPrimitive)?.longOrNull
            _state.update {
                it.copy(
                    plan = if (what != OVERAGE && paidUntil != null) what else it.plan,
                    paidUntil = paidUntil ?: it.paidUntil,
                    remainingBytes = if (topUp != null) (it.remainingBytes ?: 0) + _state.value.config.overage.blockGb * GB else it.remainingBytes,
                )
            }
        } catch (e: PaymentsHttpError) {
            when (e.code) {
                "voucher-spent" -> {
                    val listed = (e.body["spent"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                    write { VoucherWallets.markSpent(it, listed) }
                    if (retry && listed.isNotEmpty()) return spend(n, what, retry = false)
                }
                "bad-voucher" -> {
                    (e.body["nullifier"] as? JsonPrimitive)?.contentOrNull?.let { nf -> write { VoucherWallets.markSpent(it, listOf(nf)) } }
                }
                "plan-paid-ahead" -> Unit
                else -> _state.update { it.copy(error = e.code ?: "unavailable") }
            }
        } catch (_: Exception) {
            _state.update { it.copy(error = "unavailable") }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    /** The gym's free test vouchers (only when `.com` says testIssue): 30 blinded, signed, unblinded, synced. */
    suspend fun addTestVouchers(count: Int = 30): Boolean = mutex.withLock {
        val s = _state.value
        val key = s.issuingKey ?: return false
        if (!s.testIssue || !s.canSpend) return false
        _state.update { it.copy(busy = true, error = null) }
        try {
            val reqs = (0 until count).map { Vouchers.request(key) }
            val sigs = client.testIssue(key.keyId, reqs.map { it.second })
            if (sigs.size != reqs.size) return false
            val fresh = reqs.mapIndexed { i, r -> Vouchers.finalize(key, r.first, sigs[i]) }
            write { VoucherWallets.add(it, fresh) }
        } catch (e: PaymentsHttpError) {
            _state.update { it.copy(error = e.code ?: "unavailable") }
            false
        } catch (_: Exception) {
            _state.update { it.copy(error = "unavailable") }
            false
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    companion object {
        const val OVERAGE = "overage"
        const val GB = 1024L * 1024 * 1024
        @Volatile var shared: PaymentsCenter? = null
    }
}
