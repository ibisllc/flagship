// The org's voucher wallet: the Kotlin twin of packages/protocol/src/orgWallet.ts (vectors: test-vectors/org-plan
// `wallet`, `merge`). An org has no UMK, so the wallet is sealed under the org key ring's `wallet` key, which only org
// admins receive and which every offboarding of an admin rotates. `.com` keeps ciphertext only; one org admin approves
// every write.
//
//   key      HKDF-SHA256(ring key, salt empty, info "flagship/org-voucher-wallet/v1|<orgId>", 32)
//   sealed   {version, keyVersion, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce,
//            aad "flagship/org-voucher-wallet/v1|<orgId>|<keyVersion>|<version>", canonical JSON plaintext)
//   plain    {v:1, vouchers, spent, settings {seats, autoPay, overageCapUnits, updatedAt}, overage, pad}
//   write    flagship/org-voucher-wallet-write/v1|<orgId>|<version>|<keyVersion>|<blobSha256>|<issuedAt>

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.SecureRandom

data class OrgWalletSettings(val seats: Long, val autoPay: Boolean, val overageCapUnits: Long, val updatedAt: Long) {
    fun toJson() = JsonObject(
        mapOf(
            "seats" to JsonPrimitive(seats),
            "autoPay" to JsonPrimitive(autoPay),
            "overageCapUnits" to JsonPrimitive(overageCapUnits),
            "updatedAt" to JsonPrimitive(updatedAt),
        ),
    )
}

data class OrgVoucherWallet(
    val vouchers: List<Voucher>,
    val spent: List<String>,
    val settings: OrgWalletSettings,
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

data class SealedOrgWallet(val version: Long, val keyVersion: Long, val nonce: String, val ct: String) {
    fun toJson() = JsonObject(
        linkedMapOf("version" to JsonPrimitive(version), "keyVersion" to JsonPrimitive(keyVersion), "nonce" to JsonPrimitive(nonce), "ct" to JsonPrimitive(ct)),
    )
}

data class OrgWalletWrite(val orgId: String, val version: Long, val keyVersion: Long, val blobSha256: String, val issuedAt: Long) {
    fun toJson() = JsonObject(
        linkedMapOf(
            "orgId" to JsonPrimitive(orgId), "version" to JsonPrimitive(version), "keyVersion" to JsonPrimitive(keyVersion),
            "blobSha256" to JsonPrimitive(blobSha256), "issuedAt" to JsonPrimitive(issuedAt),
        ),
    )
}

object OrgWallets {
    const val TAG = "flagship/org-voucher-wallet/v1"
    const val TAG_WRITE = "flagship/org-voucher-wallet-write/v1"
    const val MAX_VOUCHERS = 5000
    const val MAX_BYTES = 4 * 1024 * 1024
    private val PERIOD = Regex("^(\\d{4}-(0[1-9]|1[0-2]))?$")
    private val ORG_ID = Regex("^[0-9a-f]{32}$")
    private val B64 = Regex("^[A-Za-z0-9+/]+={0,2}$")
    private val byKn = Comparator<Voucher> { a, b -> if (a.k == b.k) a.n.compareTo(b.n) else a.k.compareTo(b.k) }

    fun empty(seats: Long, overageCapUnits: Long) = OrgVoucherWallet(emptyList(), emptyList(), OrgWalletSettings(seats, true, overageCapUnits, 0), "", 0)

    fun normalize(w: OrgVoucherWallet): OrgVoucherWallet {
        val spent = w.spent.toSortedSet().toList().takeLast(VoucherWallets.MAX_SPENT)
        val spentSet = spent.toHashSet()
        val seen = HashSet<String>()
        val vouchers = w.vouchers.sortedWith(byKn).filter { v -> seen.add("${v.k}|${v.n}") && v.nullifier !in spentSet }
        return w.copy(vouchers = vouchers.take(MAX_VOUCHERS), spent = spent)
    }

    private fun bool(e: JsonElement?): Boolean? =
        (e as? JsonPrimitive)?.takeIf { !it.isString && (it.content == "true" || it.content == "false") }?.content?.toBoolean()

    private fun parseSettings(v: JsonElement?): OrgWalletSettings? {
        val o = VoiciJs.obj(v) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("seats", "autoPay", "overageCapUnits", "updatedAt"))) return null
        val seats = VoiciJs.time(o["seats"])?.takeIf { it in 1..1_000_000 } ?: return null
        val autoPay = bool(o["autoPay"]) ?: return null
        val cap = VoiciJs.time(o["overageCapUnits"])?.takeIf { it <= 1_000_000 } ?: return null
        val updatedAt = VoiciJs.time(o["updatedAt"]) ?: return null
        return OrgWalletSettings(seats, autoPay, cap, updatedAt)
    }

    /** Strict shape of an org wallet plaintext (`pad` allowed and dropped). */
    fun parse(v: JsonElement?): OrgVoucherWallet? {
        val o = VoiciJs.obj(v) ?: return null
        if (o.keys - "pad" != setOf("v", "vouchers", "spent", "settings", "overage") || !VoiciJs.isNumEq(o["v"], 1)) return null
        if (o.containsKey("pad")) VoiciJs.str(o["pad"])?.takeIf { s -> s.all { it == '0' } } ?: return null
        val va = VoiciJs.arr(o["vouchers"])?.takeIf { it.size <= MAX_VOUCHERS } ?: return null
        val sa = VoiciJs.arr(o["spent"])?.takeIf { it.size <= VoucherWallets.MAX_SPENT } ?: return null
        val spent = sa.map { e -> VoiciJs.str(e)?.takeIf { WebEnvelopes.isLowerHex(it, 32) } ?: return null }
        val vouchers = va.map { Vouchers.parse(it) ?: return null }
        val settings = parseSettings(o["settings"]) ?: return null
        val ov = VoiciJs.obj(o["overage"])?.takeIf { VoiciJs.exactKeys(it, listOf("period", "units")) } ?: return null
        val period = VoiciJs.str(ov["period"])?.takeIf { PERIOD.matches(it) } ?: return null
        val units = VoiciJs.time(ov["units"]) ?: return null
        return normalize(OrgVoucherWallet(vouchers, spent, settings, period, units))
    }

    /** A version conflict: both sides' vouchers and spends, the newer settings, the later overage count. */
    fun merge(local: OrgVoucherWallet, remote: OrgVoucherWallet): OrgVoucherWallet {
        val settings = if (remote.settings.updatedAt > local.settings.updatedAt) remote.settings else local.settings
        val (period, units) = when {
            local.overagePeriod == remote.overagePeriod -> local.overagePeriod to maxOf(local.overageUnits, remote.overageUnits)
            local.overagePeriod > remote.overagePeriod -> local.overagePeriod to local.overageUnits
            else -> remote.overagePeriod to remote.overageUnits
        }
        return normalize(OrgVoucherWallet(local.vouchers + remote.vouchers, local.spent + remote.spent, settings, period, units))
    }

    fun add(w: OrgVoucherWallet, vouchers: Collection<Voucher>) = normalize(w.copy(vouchers = w.vouchers + vouchers))

    fun markSpent(w: OrgVoucherWallet, nullifiers: Collection<String>) = normalize(w.copy(spent = w.spent + nullifiers))

    fun take(w: OrgVoucherWallet, n: Int): List<Voucher> = normalize(w).vouchers.take(maxOf(0, n))

    /** The canonical plaintext, padded to its bucket (4 KiB × 2^i). */
    fun plaintext(w: OrgVoucherWallet): String {
        val n = normalize(w)
        val bare = WebEnvelopes.canonicalJson(n.toJson(""))
        var bucket = VoucherWallets.BUCKET
        while (bucket < bare.length) bucket *= 2
        require(bucket <= MAX_BYTES) { "$TAG: too large" }
        return WebEnvelopes.canonicalJson(n.toJson("0".repeat(bucket - bare.length)))
    }

    fun deriveKey(ringKey: ByteArray, orgId: String): ByteArray {
        require(ringKey.size == 32 && ORG_ID.matches(orgId)) { TAG }
        return VoiciJs.hkdf32(ringKey, "$TAG|$orgId")
    }

    private fun aad(orgId: String, keyVersion: Long, version: Long) = VoiciJs.utf8("$TAG|$orgId|$keyVersion|$version")

    fun seal(
        key: ByteArray,
        orgId: String,
        keyVersion: Long,
        version: Long,
        w: OrgVoucherWallet,
        nonce: ByteArray = ByteArray(12).also { SecureRandom().nextBytes(it) },
    ): SealedOrgWallet {
        require(version >= 1 && keyVersion >= 1 && nonce.size == 12 && ORG_ID.matches(orgId)) { TAG }
        val ct = VoiciJs.gcmEncrypt(key, nonce, aad(orgId, keyVersion, version), VoiciJs.utf8(plaintext(w)))
        return SealedOrgWallet(version, keyVersion, VoiciJs.hex(nonce), WebEnvelopes.b64Encode(ct))
    }

    /** Strict shape of a sealed blob (no decryption). */
    fun parseSealed(blob: JsonElement?): SealedOrgWallet? {
        val o = VoiciJs.obj(blob) ?: return null
        if (!VoiciJs.exactKeys(o, listOf("version", "keyVersion", "nonce", "ct"))) return null
        val version = VoiciJs.time(o["version"])?.takeIf { it >= 1 } ?: return null
        val keyVersion = VoiciJs.time(o["keyVersion"])?.takeIf { it >= 1 } ?: return null
        val nonce = VoiciJs.str(o["nonce"])?.takeIf { WebEnvelopes.isLowerHex(it, 12) } ?: return null
        val ct = VoiciJs.str(o["ct"]) ?: return null
        if (!B64.matches(ct) || ct.length % 4 != 0 || ct.length > ((MAX_BYTES + 16) * 4) / 3 + 4) return null
        return SealedOrgWallet(version, keyVersion, nonce, ct)
    }

    fun open(key: ByteArray, orgId: String, blob: JsonElement?): OrgVoucherWallet? {
        val s = parseSealed(blob) ?: return null
        val ct = WebEnvelopes.b64Decode(s.ct) ?: return null
        return try {
            val text = VoiciJs.utf8Fatal(VoiciJs.gcmDecrypt(key, WebEnvelopes.hexToBytes(s.nonce), aad(orgId, s.keyVersion, s.version), ct)) ?: return null
            val v = VoiciJs.parseJson(text) ?: return null
            if (WebEnvelopes.canonicalJson(v) != text) null else parse(v)
        } catch (_: Exception) {
            null
        }
    }

    fun blobSha256(blob: SealedOrgWallet): String = VoiciJs.hex(VoiciJs.sha256(VoiciJs.utf8(WebEnvelopes.canonicalJson(blob.toJson()))))

    /** The order an org admin approves to store a blob (wrapped in `flagship/org-approval/v1`). */
    fun canonicalWrite(w: OrgWalletWrite): ByteArray {
        require(ORG_ID.matches(w.orgId) && w.version >= 1 && w.keyVersion >= 1) { TAG_WRITE }
        require(WebEnvelopes.isLowerHex(w.blobSha256, 32) && w.issuedAt >= 0) { TAG_WRITE }
        return VoiciJs.utf8(listOf(TAG_WRITE, w.orgId, w.version.toString(), w.keyVersion.toString(), w.blobSha256, w.issuedAt.toString()).joinToString("|"))
    }

    fun writeFor(orgId: String, blob: SealedOrgWallet, issuedAt: Long) = OrgWalletWrite(orgId, blob.version, blob.keyVersion, blobSha256(blob), issuedAt)

    /** About how many months [balance] vouchers keep [seats] seats (count / (seats × units a seat-month)). */
    fun monthsCovered(cfg: PaymentsConfig, balance: Int, seats: Long): Double =
        if (seats <= 0) 0.0 else balance.toDouble() / cfg.orgMonthlyUnits(seats).toDouble()
}
