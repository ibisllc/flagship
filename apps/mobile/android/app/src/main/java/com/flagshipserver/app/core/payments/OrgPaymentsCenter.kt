// An org's Business plan on this phone (docs/plans-and-backup-offer.md §3, §3.4, §6): the plan `.com` serves, the
// org's voucher wallet (OrgWallet.kt) and its trickle. The same rules as the personal wallet (PaymentsCenter):
//
// - Only an org admin opens the wallet: its key comes from the org key ring's `wallet` kind, sealed to org admins only.
//   Every write carries one org admin's approval over `flagship/org-voucher-wallet-write/v1`.
// - The trickle spends ahead of need with `orgTrickleStep` and the org's terms; a spend names the org and the seat
//   count, never a person or a device, and goes through the private relays like every spend. Background work never
//   prompts: without an open session a tick waits.
// - After the `wallet` key rotates away from a seat that left, every voucher the old key could read is exchanged for
//   fresh ones before the wallet is sealed under the new key (that admin may have copied them).

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.api.PaymentsClient
import com.flagshipserver.app.api.PaymentsHttpError
import com.flagshipserver.app.core.OrgClientException
import com.flagshipserver.app.core.ohttp.OhttpPrivacy
import com.flagshipserver.app.core.ohttp.PrivateSpendKind
import com.flagshipserver.app.core.ohttp.RelayUnavailableException
import com.flagshipserver.app.core.pq.OrgApproval
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

/** The price `.com` serves with the plan (the screen never hard-codes a number). */
data class OrgPrice(val unitUsd: Long, val unitsPerSeatMonth: Long, val minSeats: Long, val maxSeats: Long)

/** `GET /api/orgs/<orgId>/plan`. */
data class OrgPlanServed(
    val orgId: String,
    val status: String,
    val seatLimit: Long,
    val paidSeats: Long,
    val paidUntil: Long,
    val trialEndsAt: Long,
    val coveredUntil: Long,
    val liveSeats: Long,
    val price: OrgPrice?,
) {
    fun terms(trialSeats: Long) = OrgPlanTerms(trialEndsAt, trialSeats, paidSeats, paidUntil)

    companion object {
        fun parse(o: JsonObject?): OrgPlanServed? {
            if (o == null) return null
            fun n(k: String) = VoiciJs.time(o[k])
            val status = VoiciJs.str(o["status"])?.takeIf { it in OrgPlans.STATUSES } ?: return null
            val p = VoiciJs.obj(o["price"])
            val price = p?.let {
                OrgPrice(
                    VoiciJs.time(it["unitUsd"]) ?: return@let null,
                    VoiciJs.time(it["unitsPerSeatMonth"])?.takeIf { u -> u > 0 } ?: return@let null,
                    VoiciJs.time(it["minSeats"]) ?: return@let null,
                    VoiciJs.time(it["maxSeats"]) ?: return@let null,
                )
            }
            return OrgPlanServed(
                VoiciJs.str(o["orgId"]) ?: return null, status, n("seatLimit") ?: return null, n("paidSeats") ?: 0, n("paidUntil") ?: 0,
                n("trialEndsAt") ?: 0, n("coveredUntil") ?: 0, n("liveSeats") ?: 0, price,
            )
        }
    }
}

sealed interface OrgWalletPut {
    data class Stored(val version: Long) : OrgWalletPut
    /** Another admin wrote first: [wallet] is the stored blob to merge. */
    data class Conflict(val wallet: JsonObject?) : OrgWalletPut
}

/** The `.com` side of the org's plan and wallet. */
interface OrgPlanBackend {
    suspend fun plan(orgId: String): OrgPlanServed?
    suspend fun wallet(orgId: String): JsonObject?
    suspend fun putWallet(orgId: String, blob: JsonObject, write: JsonObject, approval: OrgApproval): OrgWalletPut
}

/** Every `wallet` ring version this seat opens, and the versions that retired a seat (their predecessors' vouchers are exchanged). */
class OrgWalletRing(val keys: Map<Long, ByteArray>, val retiring: Set<Long>) {
    val newest: Long get() = keys.keys.maxOrNull() ?: 0
}

/** This phone's seat in the org. */
interface OrgWalletKeyring {
    fun isAdmin(): Boolean
    /** The ring keys this seat opens; [interactive] may prompt and may make version 1. Null when locked or not an admin. */
    suspend fun walletRing(interactive: Boolean): OrgWalletRing?
    /** One org admin's approval over [order]; null when the seat key is locked. */
    fun approve(order: ByteArray): OrgApproval?
}

/** Device-local: when the org's next unhurried spend is due (never synced). */
interface OrgPaymentsLocal {
    fun nextSpendAt(orgId: String): Long
    fun setNextSpendAt(orgId: String, at: Long)
}

class MemoryOrgPaymentsLocal : OrgPaymentsLocal {
    private val m = HashMap<String, Long>()
    override fun nextSpendAt(orgId: String) = m[orgId] ?: 0
    override fun setNextSpendAt(orgId: String, at: Long) { m[orgId] = at }
}

class PrefsOrgPaymentsLocal(context: android.content.Context) : OrgPaymentsLocal {
    private val prefs = context.applicationContext.getSharedPreferences("flagship.org-payments", android.content.Context.MODE_PRIVATE)
    override fun nextSpendAt(orgId: String) = prefs.getLong("nextSpendAt.$orgId", 0)
    override fun setNextSpendAt(orgId: String, at: Long) { prefs.edit().putLong("nextSpendAt.$orgId", at).apply() }
}

/** What the last import or purchase came to (the screen writes the sentence). */
sealed interface OrgPlanNotice {
    data class Added(val count: Int) : OrgPlanNotice
    /** [code]: `file-bad`, `file-unknown-key`, `file-too-many`, `locked`. */
    data class Refused(val code: String) : OrgPlanNotice
}

data class OrgPlanUi(
    val loaded: Boolean = false,
    val served: OrgPlanServed? = null,
    val config: PaymentsConfig = PaymentsConfig.DEFAULT,
    val isAdmin: Boolean = false,
    /** The wallet key opened here (an org admin with an open session). */
    val canOpen: Boolean = false,
    val wallet: OrgVoucherWallet? = null,
    val version: Long = 0,
    val keyVersion: Long = 0,
    val busy: Boolean = false,
    /** The last refusal code (`.com`'s, or `locked`); OrgPlanCopy turns it into a sentence. */
    val error: String? = null,
    val notice: OrgPlanNotice? = null,
) {
    val balance: Int get() = wallet?.balance ?: 0
    val canPay: Boolean get() = isAdmin && canOpen && wallet != null
    val unitsPerSeatMonth: Long get() = served?.price?.unitsPerSeatMonth ?: config.business.unitsPerSeatMonth
    val unitUsd: Long get() = served?.price?.unitUsd ?: config.unitUsd
    /** The fewest seats the wallet may pay for: the plan's minimum, or everyone who holds a seat now. */
    val minSeats: Long get() = maxOf(served?.price?.minSeats ?: config.business.minSeats, served?.liveSeats ?: 0)
    val maxSeats: Long get() = served?.price?.maxSeats ?: config.business.maxSeats
    val seats: Long get() = wallet?.settings?.seats ?: minSeats
    /** About how many months the balance keeps [seats] seats. */
    val monthsCovered: Double get() = if (seats <= 0) 0.0 else balance.toDouble() / (seats * unitsPerSeatMonth).toDouble()
}

class OrgPaymentsCenter(
    val orgId: String,
    private val backend: OrgPlanBackend,
    private val keyring: OrgWalletKeyring,
    private val payments: PaymentsClient,
    /** The personal center's state: the served config, voucher keys and private relays. */
    private val shared: () -> PaymentsUi,
    private val local: OrgPaymentsLocal = MemoryOrgPaymentsLocal(),
    private val now: () -> Long = System::currentTimeMillis,
    private val rand: () -> Double = { SecureRandom().nextDouble() },
) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(OrgPlanUi())
    val state: StateFlow<OrgPlanUi> = _state.asStateFlow()
    private var ring: OrgWalletRing? = null

    /** The plan, and for an org admin the wallet; [interactive] (the Plan screen) may unlock and make the first key. */
    suspend fun refresh(interactive: Boolean) = mutex.withLock {
        val cfg = shared().config
        val served = runCatching { backend.plan(orgId) }.getOrNull() ?: _state.value.served
        val opened = if (keyring.isAdmin()) runCatching { keyring.walletRing(interactive) }.getOrNull()?.takeIf { it.keys.isNotEmpty() } else null
        // The keyring knows for sure only once it has read the org's verified records.
        val admin = keyring.isAdmin()
        _state.update { it.copy(loaded = true, served = served, config = cfg, isAdmin = admin) }
        if (!admin) {
            _state.update { it.copy(canOpen = false, wallet = null) }
            return@withLock
        }
        val r = opened ?: ring
        if (r == null) {
            _state.update { it.copy(canOpen = false, error = if (interactive) "locked" else it.error) }
            return@withLock
        }
        ring = r
        val fetched = runCatching { backend.wallet(orgId) }
        if (fetched.isFailure) {
            _state.update { it.copy(canOpen = true) }
        } else {
            val blob = fetched.getOrNull()
            if (blob == null) {
                val seats = maxOf(served?.price?.minSeats ?: cfg.business.minSeats, served?.liveSeats ?: 0)
                val mine = _state.value.wallet
                _state.update {
                    it.copy(canOpen = true, wallet = mine ?: OrgWallets.empty(seats, cfg.overage.defaultCapUnits), version = 0, keyVersion = r.newest)
                }
            } else {
                val sealed = OrgWallets.parseSealed(blob)
                val stored = sealed?.let { s -> r.keys[s.keyVersion]?.let { k -> OrgWallets.open(OrgWallets.deriveKey(k, orgId), orgId, blob) } }
                if (sealed == null || stored == null) {
                    // A stored wallet this phone can't open is never replaced by an empty one (it would lose the vouchers).
                    _state.update { it.copy(canOpen = false, wallet = null) }
                    return@withLock
                }
                val mine = _state.value.wallet
                val merged = if (mine != null && _state.value.version >= sealed.version) OrgWallets.merge(mine, stored) else stored
                _state.update { it.copy(canOpen = true, wallet = merged, version = sealed.version, keyVersion = sealed.keyVersion) }
            }
        }
        val s = _state.value
        if (s.wallet != null && s.version > 0 && s.keyVersion < r.newest) rekeyLocked(r)
    }

    /** Seal the wallet under the newest key, exchanging every voucher first when a newer version retired a seat. */
    private suspend fun rekeyLocked(r: OrgWalletRing) {
        val from = _state.value.keyVersion
        if (r.retiring.none { it > from }) {
            write(r.newest) { it }
            return
        }
        val key = shared().issuingKey ?: return
        val per = shared().config.maxPerRequest.toInt().coerceAtLeast(1)
        _state.update { it.copy(busy = true) }
        try {
            for (chunk in (_state.value.wallet ?: return).vouchers.chunked(per)) {
                val reqs = chunk.map { Vouchers.request(key) }
                val fresh = try {
                    val (k, sigs) = payments.exchange(key.keyId, chunk.map { it.toJson() }, reqs.map { it.second })
                    require(k == key.keyId && sigs.size == reqs.size)
                    reqs.mapIndexed { i, q -> Vouchers.finalize(key, q.first, sigs[i]) }
                } catch (e: PaymentsHttpError) {
                    if (e.code == "voucher-spent") {
                        val listed = (e.body["spent"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                        write(_state.value.keyVersion) { OrgWallets.markSpent(it, listed) }
                    }
                    return
                }
                if (!write(r.newest) { OrgWallets.add(OrgWallets.markSpent(it, chunk.map { v -> v.nullifier }), fresh) }) return
            }
            if (_state.value.keyVersion < r.newest) write(r.newest) { it }
        } catch (_: Exception) {
            _state.update { it.copy(error = "unavailable") }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    /** Change the wallet and store it as the next version sealed under [keyVersion]; a conflict merges and tries again. */
    private suspend fun write(keyVersion: Long = maxOf(_state.value.keyVersion, ring?.newest ?: 0), change: (OrgVoucherWallet) -> OrgVoucherWallet): Boolean {
        val r = ring ?: return false
        val ringKey = r.keys[keyVersion] ?: return false
        val key = OrgWallets.deriveKey(ringKey, orgId)
        var base = _state.value.wallet ?: return false
        var version = _state.value.version
        for (attempt in 0 until 3) {
            val next = change(base)
            val sealed = OrgWallets.seal(key, orgId, keyVersion, version + 1, next)
            val w = OrgWallets.writeFor(orgId, sealed, now())
            val approval = keyring.approve(OrgWallets.canonicalWrite(w))
            if (approval == null) {
                _state.update { it.copy(error = "locked") }
                return false
            }
            val put = try {
                backend.putWallet(orgId, sealed.toJson(), w.toJson(), approval)
            } catch (e: OrgClientException) {
                _state.update { it.copy(error = e.code.ifEmpty { "unavailable" }) }
                return false
            } catch (_: Exception) {
                // Offline: the change stays here; the next write carries it.
                _state.update { it.copy(wallet = next) }
                return false
            }
            when (put) {
                is OrgWalletPut.Stored -> {
                    _state.update { it.copy(wallet = next, version = version + 1, keyVersion = keyVersion, error = null) }
                    return true
                }
                is OrgWalletPut.Conflict -> {
                    val stored = OrgWallets.parseSealed(put.wallet)
                    val remote = stored?.let { s -> r.keys[s.keyVersion]?.let { k -> OrgWallets.open(OrgWallets.deriveKey(k, orgId), orgId, put.wallet) } }
                    if (remote != null) base = OrgWallets.merge(base, remote)
                    version = stored?.version ?: version
                }
            }
        }
        return false
    }

    /** The seat count the wallet pays for (admins; from everyone who holds a seat to the plan's maximum). */
    suspend fun setSeats(seats: Long): Boolean = mutex.withLock {
        val s = _state.value
        if (!s.canPay || seats < s.minSeats || seats > s.maxSeats) return@withLock false
        local.setNextSpendAt(orgId, 0)
        write { w -> w.copy(settings = w.settings.copy(seats = seats, updatedAt = now())) }
    }

    suspend fun setAutoPay(on: Boolean): Boolean = mutex.withLock {
        if (!_state.value.canPay) return@withLock false
        write { w -> w.copy(settings = w.settings.copy(autoPay = on, updatedAt = now())) }
    }

    /** One tick of the org trickle (foreground, never prompts). */
    suspend fun tick() = mutex.withLock {
        val s = _state.value
        val w = s.wallet ?: return@withLock
        val served = s.served ?: return@withLock
        if (!s.canPay) return@withLock
        val cfg = shared().config
        val out = OrgPlans.trickleStep(
            cfg,
            OrgTrickleInput(now(), w.settings.autoPay, w.balance.toLong(), served.terms(cfg.business.trialSeats), w.settings.seats, local.nextSpendAt(orgId)),
            rand(),
        )
        local.setNextSpendAt(orgId, out.nextSpendAt)
        if (out.spend > 0) spend(out.spend.toInt(), retry = true)
    }

    private suspend fun spend(n: Int, retry: Boolean) {
        val s0 = _state.value
        val w = s0.wallet ?: return
        val served = s0.served ?: return
        val seats = w.settings.seats
        val vouchers = OrgWallets.take(w, n)
        if (vouchers.isEmpty()) return
        val cfg = shared().config
        val t0 = now()
        val mayGoDirect = OhttpPrivacy.spendMayGoDirect(PrivateSpendKind.TRICKLE, OhttpPrivacy.planLapseInMs(served.coveredUntil, cfg.graceHours * 3_600_000L, t0))
        val body = JsonObject(
            linkedMapOf(
                "v" to JsonPrimitive(1),
                "org" to JsonPrimitive(orgId),
                "for" to JsonPrimitive(BUSINESS),
                "seats" to JsonPrimitive(seats),
                "vouchers" to JsonArray(vouchers.map { it.toJson() }),
            ),
        )
        _state.update { it.copy(busy = true, error = null) }
        try {
            val r = payments.redeemPrivately(body, shared().ohttp) { mayGoDirect }.answer
            write { OrgWallets.markSpent(it, vouchers.map { v -> v.nullifier }) }
            val paidUntil = (r["paidUntil"] as? JsonPrimitive)?.longOrNull
            val status = VoiciJs.str(r["status"])?.takeIf { it in OrgPlans.STATUSES }
            _state.update {
                val sv = it.served ?: return@update it
                it.copy(served = sv.copy(paidUntil = paidUntil ?: sv.paidUntil, paidSeats = if (paidUntil != null) seats else sv.paidSeats, status = status ?: sv.status))
            }
        } catch (e: PaymentsHttpError) {
            when (e.code) {
                "voucher-spent" -> {
                    val listed = (e.body["spent"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                    write { OrgWallets.markSpent(it, listed) }
                    if (retry && listed.isNotEmpty()) return spend(n, retry = false)
                }
                "bad-voucher" -> (e.body["nullifier"] as? JsonPrimitive)?.contentOrNull?.let { nf -> write { OrgWallets.markSpent(it, listOf(nf)) } }
                "plan-paid-ahead" -> Unit
                else -> _state.update { it.copy(error = e.code ?: "unavailable") }
            }
        } catch (e: RelayUnavailableException) {
            // Nothing was spent; a failing relay is tried again later.
            if (e.reason != "unconfigured") local.setNextSpendAt(orgId, now() + OhttpPrivacy.relayRetryAfterMs(1))
        } catch (_: Exception) {
            _state.update { it.copy(error = "unavailable") }
        } finally {
            _state.update { it.copy(busy = false) }
        }
    }

    /**
     * Bought vouchers into the org wallet (compare-and-set, a conflict merges). True only when `.com` holds the new
     * version: a store purchase is finished only then. Adding the same vouchers twice is harmless.
     */
    suspend fun addVouchers(fresh: List<Voucher>): Boolean = mutex.withLock {
        if (!_state.value.canPay) return@withLock false
        val ok = write { OrgWallets.add(it, fresh) }
        if (ok) _state.update { it.copy(notice = OrgPlanNotice.Added(fresh.size)) }
        ok
    }

    /** A voucher file (bought as an invoiced batch on the web) into the org wallet; every voucher must verify here. */
    suspend fun importFile(text: String): Boolean {
        val vs = VoucherFiles.parse(text)
        val keys = shared().keys.associateBy { it.keyId }
        val code = when {
            vs == null -> "file-bad"
            (_state.value.balance + vs.size) > OrgWallets.MAX_VOUCHERS -> "file-too-many"
            vs.any { v -> keys[v.k] == null } -> "file-unknown-key"
            vs.any { v -> !Vouchers.verify(keys.getValue(v.k), v) } -> "file-bad"
            else -> null
        }
        if (code != null) {
            _state.update { it.copy(notice = OrgPlanNotice.Refused(code)) }
            return false
        }
        val ok = addVouchers(vs!!)
        if (!ok) _state.update { it.copy(notice = OrgPlanNotice.Refused(it.error ?: "unavailable")) }
        else tick()
        return ok
    }

    fun refuse(code: String) = _state.update { it.copy(notice = OrgPlanNotice.Refused(code)) }

    fun clearNotice() = _state.update { it.copy(notice = null, error = null) }

    companion object {
        const val BUSINESS = "business"
    }
}
