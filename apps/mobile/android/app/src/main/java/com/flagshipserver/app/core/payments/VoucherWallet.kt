// The voucher wallet: the Kotlin twin of packages/protocol/src/voucherWallet.ts (vectors: test-vectors/vouchers
// `wallet`, `merge`, `trickle`, `overage`, `planAhead`). The account's admin devices hold the vouchers and sync them
// sealed under a key from the account's UMK, like the call hours; `.com` stores ciphertext only.
//
//   key     HKDF-SHA256(UMK seed, salt empty, info "flagship/voucher-wallet/v1", 32)
//   sealed  {version, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce, aad "flagship/voucher-wallet/v1|<version>",
//           canonical JSON {v:1, vouchers, spent, settings, overage, pad}); `pad` makes the plaintext 4 KiB × 2^i

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom
import kotlin.math.ceil
import kotlin.math.floor

data class WalletSettings(
    val plan: String?,
    val autoPay: Boolean,
    val overageCapUnits: Long,
    val delayStart: Boolean,
    val startAt: Long,
    val updatedAt: Long,
) {
    fun toJson() = JsonObject(
        mapOf(
            "plan" to (plan?.let(::JsonPrimitive) ?: JsonNull),
            "autoPay" to JsonPrimitive(autoPay),
            "overageCapUnits" to JsonPrimitive(overageCapUnits),
            "delayStart" to JsonPrimitive(delayStart),
            "startAt" to JsonPrimitive(startAt),
            "updatedAt" to JsonPrimitive(updatedAt),
        ),
    )
}

data class VoucherWallet(
    val vouchers: List<Voucher>,
    val spent: List<String>,
    val settings: WalletSettings,
    val overagePeriod: String,
    val overageUnits: Long,
) {
    val balance: Int get() = vouchers.size

    fun toJson(pad: String? = null): JsonObject {
        val m = linkedMapOf<String, JsonElement>(
            "v" to JsonPrimitive(1),
            "vouchers" to JsonArray(vouchers.map { it.toJson() }),
            "spent" to JsonArray(spent.map(::JsonPrimitive)),
            "settings" to settings.toJson(),
            "overage" to JsonObject(mapOf("period" to JsonPrimitive(overagePeriod), "units" to JsonPrimitive(overageUnits))),
        )
        if (pad != null) m["pad"] = JsonPrimitive(pad)
        return JsonObject(m)
    }
}

data class TrickleInput(
    val now: Long,
    val enabled: Boolean,
    val balance: Long,
    val aheadMs: Long,
    val startAt: Long,
    val nextSpendAt: Long,
    val unitMs: Long,
    val lowWaterMs: Long,
    val highWaterMs: Long,
    val maxPerRequest: Long,
)

data class TrickleOut(val spend: Long, val nextSpendAt: Long)

data class OverageInput(
    val paid: Boolean,
    val remainingBytes: Long,
    val buyBelowBytes: Long,
    val capUnits: Long,
    val spentUnits: Long,
    val blockUnits: Long,
    val balance: Long,
)

object VoucherWallets {
    const val TAG = "flagship/voucher-wallet/v1"
    const val MAX_VOUCHERS = 500
    const val MAX_SPENT = 2048
    const val BUCKET = 4096
    const val MAX_BYTES = 512 * 1024
    private val PERIOD = Regex("^(\\d{4}-(0[1-9]|1[0-2]))?$")

    fun empty(overageCapUnits: Long) = VoucherWallet(emptyList(), emptyList(), WalletSettings(null, true, overageCapUnits, false, 0, 0), "", 0)

    private val byKn = Comparator<Voucher> { a, b -> if (a.k == b.k) a.n.compareTo(b.n) else a.k.compareTo(b.k) }

    private fun parseSettings(v: JsonElement?): WalletSettings? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("plan", "autoPay", "overageCapUnits", "delayStart", "startAt", "updatedAt"))) return null
        val planEl = o["plan"]
        val plan = if (planEl is JsonNull) null else VoiciJs.str(planEl)?.takeIf(PaymentsConfig::isPaidPlan) ?: return null
        val autoPay = (o["autoPay"] as? JsonPrimitive)?.takeIf { !it.isString && (it.content == "true" || it.content == "false") }?.content?.toBoolean() ?: return null
        val delay = (o["delayStart"] as? JsonPrimitive)?.takeIf { !it.isString && (it.content == "true" || it.content == "false") }?.content?.toBoolean() ?: return null
        val cap = VoiciJs.time(o["overageCapUnits"])?.takeIf { it <= 10_000 } ?: return null
        val startAt = VoiciJs.time(o["startAt"]) ?: return null
        val updatedAt = VoiciJs.time(o["updatedAt"]) ?: return null
        return WalletSettings(plan, autoPay, cap, delay, startAt, updatedAt)
    }

    /** Strict shape of a wallet plaintext (`pad` allowed and dropped). */
    fun parse(v: JsonElement?): VoucherWallet? {
        val o = VoiciJs.obj(v) ?: return null
        val keys = o.keys - "pad"
        if (keys != setOf("v", "vouchers", "spent", "settings", "overage") || !VoiciJs.isNumEq(o["v"], 1)) return null
        if (o.containsKey("pad")) VoiciJs.str(o["pad"])?.takeIf { s -> s.all { it == '0' } } ?: return null
        val va = VoiciJs.arr(o["vouchers"])?.takeIf { it.size <= MAX_VOUCHERS } ?: return null
        val sa = VoiciJs.arr(o["spent"])?.takeIf { it.size <= MAX_SPENT } ?: return null
        val spent = sa.map { e -> VoiciJs.str(e)?.takeIf { WebEnvelopes.isLowerHex(it, 32) } ?: return null }
        val vouchers = va.map { Vouchers.parse(it) ?: return null }
        val settings = parseSettings(o["settings"]) ?: return null
        val ov = VoiciJs.obj(o["overage"])?.takeIf { VoiciJs.exactKeys(it, listOf("period", "units")) } ?: return null
        val period = VoiciJs.str(ov["period"])?.takeIf { PERIOD.matches(it) } ?: return null
        val units = VoiciJs.time(ov["units"]) ?: return null
        return normalize(VoucherWallet(vouchers, spent, settings, period, units))
    }

    /** Sorted, deduplicated, spent vouchers dropped, lists capped. */
    fun normalize(w: VoucherWallet): VoucherWallet {
        val spent = w.spent.toSortedSet().toList().takeLast(MAX_SPENT)
        val spentSet = spent.toHashSet()
        val seen = HashSet<String>()
        val vouchers = w.vouchers.sortedWith(byKn).filter { v -> seen.add("${v.k}|${v.n}") && v.nullifier !in spentSet }
        return w.copy(vouchers = vouchers.take(MAX_VOUCHERS), spent = spent)
    }

    /** A version conflict: both sides' vouchers and spends, the newer settings, the later overage count. */
    fun merge(local: VoucherWallet, remote: VoucherWallet): VoucherWallet {
        val settings = if (remote.settings.updatedAt > local.settings.updatedAt) remote.settings else local.settings
        val (period, units) = when {
            local.overagePeriod == remote.overagePeriod -> local.overagePeriod to maxOf(local.overageUnits, remote.overageUnits)
            local.overagePeriod > remote.overagePeriod -> local.overagePeriod to local.overageUnits
            else -> remote.overagePeriod to remote.overageUnits
        }
        return normalize(VoucherWallet(local.vouchers + remote.vouchers, local.spent + remote.spent, settings, period, units))
    }

    fun take(w: VoucherWallet, n: Int): List<Voucher> = normalize(w).vouchers.take(maxOf(0, n))

    fun markSpent(w: VoucherWallet, nullifiers: Collection<String>) = normalize(w.copy(spent = w.spent + nullifiers))

    fun add(w: VoucherWallet, vouchers: Collection<Voucher>) = normalize(w.copy(vouchers = w.vouchers + vouchers))

    /** The canonical plaintext, padded to its bucket. */
    fun plaintext(w: VoucherWallet): String {
        val n = normalize(w)
        val bare = WebEnvelopes.canonicalJson(n.toJson(""))
        var bucket = BUCKET
        while (bucket < bare.length) bucket *= 2
        require(bucket <= MAX_BYTES) { "$TAG: too large" }
        return WebEnvelopes.canonicalJson(n.toJson("0".repeat(bucket - bare.length)))
    }

    fun deriveKey(umkSeed: ByteArray): ByteArray = VoiciJs.hkdf32(umkSeed, TAG)

    private fun aad(version: Long) = VoiciJs.utf8("$TAG|$version")

    fun seal(key: ByteArray, version: Long, w: VoucherWallet, nonce: ByteArray = ByteArray(12).also { SecureRandom().nextBytes(it) }): JsonObject {
        require(version >= 1 && nonce.size == 12) { "$TAG: bad input" }
        val ct = VoiciJs.gcmEncrypt(key, nonce, aad(version), VoiciJs.utf8(plaintext(w)))
        return JsonObject(linkedMapOf("version" to JsonPrimitive(version), "nonce" to JsonPrimitive(VoiciJs.hex(nonce)), "ct" to JsonPrimitive(WebEnvelopes.b64Encode(ct))))
    }

    fun open(key: ByteArray, blob: JsonElement?): VoucherWallet? {
        val o = VoiciJs.obj(blob) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("version", "nonce", "ct"))) return null
        val version = VoiciJs.time(o["version"]) ?: return null
        val nonce = VoiciJs.str(o["nonce"])?.takeIf { WebEnvelopes.isLowerHex(it, 12) } ?: return null
        val ct = WebEnvelopes.b64Decode(VoiciJs.str(o["ct"])) ?: return null
        if (ct.size > MAX_BYTES + 16) return null
        return try {
            val text = VoiciJs.utf8Fatal(VoiciJs.gcmDecrypt(key, WebEnvelopes.hexToBytes(nonce), aad(version), ct)) ?: return null
            val v = VoiciJs.parseJson(text) ?: return null
            if (WebEnvelopes.canonicalJson(v) != text) null else parse(v)
        } catch (_: Exception) {
            null
        }
    }

    /** The stored blob's version (the next write is version + 1). */
    fun version(blob: JsonElement?): Long = VoiciJs.obj(blob)?.let { VoiciJs.time(it["version"]) } ?: 0

    // ── spending rules ──

    /** How far ahead [plan] is paid, in [plan]'s time (0 past the grace; negative inside it; converted across plans). */
    fun planAheadMs(cfg: PaymentsConfig, plan: String, paidPlan: String?, paidUntil: Long, now: Long): Long {
        if (paidPlan == null || paidUntil <= 0) return 0
        if (paidUntil + cfg.graceHours * 3_600_000L < now) return 0
        val ahead = paidUntil - now
        if (paidPlan == plan || ahead <= 0) return if (paidPlan == plan) ahead else 0
        return floor(ahead.toDouble() * cfg.unitMs(plan).toDouble() / cfg.unitMs(paidPlan).toDouble()).toLong()
    }

    /** One tick of the trickle; [rand] uniform in [0, 1). */
    fun trickleStep(t: TrickleInput, rand: Double): TrickleOut {
        if (!t.enabled || t.balance <= 0) return TrickleOut(0, 0)
        if (t.now < t.startAt) return TrickleOut(0, t.nextSpendAt)
        val later = t.now + floor(rand * t.unitMs.toDouble()).toLong()
        if (t.aheadMs < t.lowWaterMs) {
            val need = ceil((t.lowWaterMs - t.aheadMs).toDouble() / t.unitMs.toDouble()).toLong()
            return TrickleOut(maxOf(1, minOf(t.balance, need, t.maxPerRequest)), later)
        }
        if (t.aheadMs >= t.highWaterMs) return TrickleOut(0, 0)
        if (t.nextSpendAt == 0L) return TrickleOut(0, later)
        if (t.now >= t.nextSpendAt) return TrickleOut(1, later)
        return TrickleOut(0, t.nextSpendAt)
    }

    fun overageStep(o: OverageInput): Boolean =
        o.paid && o.remainingBytes < o.buyBelowBytes && o.spentUnits + o.blockUnits <= o.capUnits && o.balance >= o.blockUnits

    /** "YYYY-MM" (UTC) of [now]. */
    fun overagePeriod(now: Long): String {
        val d = java.time.Instant.ofEpochMilli(now).atZone(java.time.ZoneOffset.UTC)
        return "%04d-%02d".format(java.util.Locale.ROOT, d.year, d.monthValue)
    }

    fun monthsOfPlan(cfg: PaymentsConfig, plan: String, balance: Int): Long = balance / cfg.plan(plan).unitsPerMonth
}
