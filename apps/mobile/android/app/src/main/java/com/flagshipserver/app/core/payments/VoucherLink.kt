// The "Load into Flagship" voucher link: the Kotlin twin of packages/protocol/src/voucherLink.ts (vectors:
// packages/protocol/test-vectors/voucher-link/). A card purchase on the web shop, signed out, ends with the vouchers
// in the browser; the link carries them in the URL fragment only, so `.com` never learns which account they go to.
// This phone checks each signature against the voucher keys it already holds (no network call) and adds the new ones
// to the account's sealed wallet; a spend happens later, through the normal trickle.
//
//   link      https://<control apex>/app/vouchers#v=<payload, base64url without padding>
//   payload   version 1 | part | parts | keyId (8 bytes) | count | sigLen (2 bytes, big-endian)
//             | count × (prefix 32 | nonce 32 | signature sigLen) | check (4 bytes)
//   check     the first 4 bytes of SHA-256("flagship/voucher-link/v1|" followed by every payload byte before it)

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import com.flagshipserver.app.core.voici.WebEnvelopes

sealed interface VoucherLinkParse {
    data class Ok(val part: Int, val parts: Int, val keyId: String, val vouchers: List<Voucher>) : VoucherLinkParse {
        override fun toString() = "VoucherLinkParse.Ok(part=$part, parts=$parts, count=${vouchers.size})"
    }
    /** `not-a-link`, `damaged` or `newer`. */
    data class Failed(val code: String) : VoucherLinkParse
}

/** What adding a link's vouchers would do (see the TS planVoucherLinkImport). */
data class VoucherLinkPlan(
    val add: List<Voucher>,
    val duplicate: Int,
    val spent: Int,
    val invalid: Int,
    val unknownKey: Int,
    val full: Boolean,
    /** "add" | "full" | "invalid" | "unknown-key" | "spent" | "already" */
    val outcome: String,
)

object VoucherLink {
    const val TAG = "flagship/voucher-link/v1"
    const val PATH = "/app/vouchers"
    const val VERSION = 1
    const val MAX_PER_LINK = 30
    const val MAX_PARTS = 255
    const val MAX_CHARS = 32_768
    private const val MIN_SIG = 256
    private const val MAX_SIG = 1024
    private const val HEADER = 14
    private const val CHECK = 4
    private val KEY_ID = Regex("^[0-9a-f]{16}$")
    private val B64URL = Regex("^[A-Za-z0-9_-]*$")

    private fun b64url(b: ByteArray) = WebEnvelopes.b64Encode(b).replace('+', '-').replace('/', '_').trimEnd('=')

    private fun fromB64url(s: String): ByteArray? {
        if (!B64URL.matches(s) || s.length % 4 == 1) return null
        val std = s.replace('-', '+').replace('_', '/')
        return WebEnvelopes.b64Decode(std + "=".repeat((4 - std.length % 4) % 4))
    }

    private fun check(body: ByteArray): ByteArray = VoiciJs.sha256(VoiciJs.utf8("$TAG|") + body).copyOfRange(0, CHECK)

    /** One link's payload: [vouchers] share one key and one signature length. */
    fun encodePayload(vouchers: List<Voucher>, part: Int, parts: Int): String {
        val first = vouchers.firstOrNull()
        require(first != null && vouchers.size <= MAX_PER_LINK) { "$TAG: bad count" }
        require(part >= 1 && parts >= part && parts <= MAX_PARTS) { "$TAG: bad part" }
        val sigs = vouchers.map { v ->
            val p = Vouchers.parse(v.toJson())
            val s = p?.let { WebEnvelopes.b64Decode(it.s) }
            require(p != null && s != null && p.k == first.k) { "$TAG: bad voucher" }
            s
        }
        val sigLen = sigs[0].size
        require(sigLen in MIN_SIG..MAX_SIG && sigs.all { it.size == sigLen }) { "$TAG: bad signature length" }
        val body = ByteArray(HEADER + vouchers.size * (64 + sigLen))
        body[0] = VERSION.toByte()
        body[1] = part.toByte()
        body[2] = parts.toByte()
        WebEnvelopes.hexToBytes(first.k).copyInto(body, 3)
        body[11] = vouchers.size.toByte()
        body[12] = (sigLen shr 8).toByte()
        body[13] = (sigLen and 0xff).toByte()
        var o = HEADER
        vouchers.forEachIndexed { i, v ->
            WebEnvelopes.hexToBytes(v.p).copyInto(body, o)
            WebEnvelopes.hexToBytes(v.n).copyInto(body, o + 32)
            sigs[i].copyInto(body, o + 64)
            o += 64 + sigLen
        }
        return b64url(body + check(body))
    }

    /** Every link for [vouchers]: grouped by key (first seen first), at most MAX_PER_LINK a link, numbered across all. */
    fun encodeLinks(vouchers: List<Voucher>, apex: String): List<String> {
        val groups = LinkedHashMap<String, MutableList<Voucher>>()
        for (v in vouchers) groups.getOrPut(v.k) { mutableListOf() }.add(v)
        val chunks = groups.values.flatMap { it.chunked(MAX_PER_LINK) }
        require(chunks.isNotEmpty() && chunks.size <= MAX_PARTS) { "$TAG: bad count" }
        return chunks.mapIndexed { i, c -> "https://$apex$PATH#v=${encodePayload(c, i + 1, chunks.size)}" }
    }

    /** The payload of a whole link or a bare fragment ("#v=…", "v=…"); null when it has none; "not-a-link" for another path. */
    internal fun payloadOf(link: String): String? {
        val s = link.trim()
        val hashAt = s.indexOf('#')
        val frag: String
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) {
            val pathEnd = s.indexOfFirst { it == '?' || it == '#' }
            val beforeFrag = if (pathEnd < 0) s else s.substring(0, pathEnd)
            val path = beforeFrag.replace(Regex("^https?://[^/]*", RegexOption.IGNORE_CASE), "").trimEnd('/')
            if (path != PATH) return NOT_A_LINK
            if (hashAt < 0) return null
            frag = s.substring(hashAt + 1)
        } else {
            frag = if (hashAt >= 0) s.substring(hashAt + 1) else s
        }
        for (pair in frag.split('&')) if (pair.startsWith("v=")) return pair.substring(2)
        return null
    }

    private const val NOT_A_LINK = "\u0000not-a-link"

    /** Shape and checksum only; signatures are checked by [plan]. */
    fun parse(link: String): VoucherLinkParse {
        val payload = payloadOf(link)
        if (payload == NOT_A_LINK) return VoucherLinkParse.Failed("not-a-link")
        if (payload.isNullOrEmpty() || payload.length > MAX_CHARS) return VoucherLinkParse.Failed("damaged")
        val b = fromB64url(payload)
        if (b == null || b.isEmpty()) return VoucherLinkParse.Failed("damaged")
        val version = b[0].toInt() and 0xff
        if (version != VERSION) return VoucherLinkParse.Failed(if (version > VERSION) "newer" else "damaged")
        if (b.size < HEADER + CHECK) return VoucherLinkParse.Failed("damaged")
        val body = b.copyOfRange(0, b.size - CHECK)
        if (!check(body).contentEquals(b.copyOfRange(b.size - CHECK, b.size))) return VoucherLinkParse.Failed("damaged")
        val part = b[1].toInt() and 0xff
        val parts = b[2].toInt() and 0xff
        val keyId = VoiciJs.hex(b.copyOfRange(3, 11))
        val count = b[11].toInt() and 0xff
        val sigLen = ((b[12].toInt() and 0xff) shl 8) or (b[13].toInt() and 0xff)
        if (part < 1 || parts < part || count < 1 || count > MAX_PER_LINK || sigLen < MIN_SIG || sigLen > MAX_SIG) return VoucherLinkParse.Failed("damaged")
        if (body.size != HEADER + count * (64 + sigLen) || !KEY_ID.matches(keyId)) return VoucherLinkParse.Failed("damaged")
        val vouchers = (0 until count).map { i ->
            val o = HEADER + i * (64 + sigLen)
            Voucher(
                keyId,
                VoiciJs.hex(body.copyOfRange(o, o + 32)),
                VoiciJs.hex(body.copyOfRange(o + 32, o + 64)),
                WebEnvelopes.b64Encode(body.copyOfRange(o + 64, o + 64 + sigLen)),
            )
        }
        return VoucherLinkParse.Ok(part, parts, keyId, vouchers)
    }

    /** What adding [vouchers] to [wallet] would do, decided on this device alone. */
    fun plan(wallet: VoucherWallet, vouchers: List<Voucher>, keys: List<VoucherKey>): VoucherLinkPlan {
        val have = wallet.vouchers.mapTo(HashSet()) { "${it.k}|${it.n}" }
        val spentSet = wallet.spent.toHashSet()
        val add = mutableListOf<Voucher>()
        var duplicate = 0
        var spent = 0
        var invalid = 0
        var unknownKey = 0
        for (v in vouchers) {
            val key = keys.firstOrNull { it.keyId == v.k }
            when {
                key == null -> unknownKey++
                !Vouchers.verify(key, v) -> invalid++
                v.nullifier in spentSet -> spent++
                "${v.k}|${v.n}" in have -> duplicate++
                else -> {
                    have.add("${v.k}|${v.n}")
                    add.add(v)
                }
            }
        }
        val full = add.isNotEmpty() && wallet.vouchers.size + add.size > VoucherWallets.MAX_VOUCHERS
        val outcome = when {
            full -> "full"
            add.isNotEmpty() -> "add"
            invalid > 0 -> "invalid"
            unknownKey > 0 -> "unknown-key"
            spent > 0 -> "spent"
            else -> "already"
        }
        return VoucherLinkPlan(add, duplicate, spent, invalid, unknownKey, full, outcome)
    }
}
