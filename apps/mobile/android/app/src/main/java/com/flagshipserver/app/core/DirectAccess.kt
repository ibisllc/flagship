// Direct access — Kotlin mirror of packages/protocol/src/directAccess.ts
// (docs/direct-access-and-domains.md). The owner's admin device signs the
// order; the box signs its address update and the v2 hint; the phone uses a
// public endpoint only inside an order it verified itself. Pinned by
// packages/protocol/test-vectors/direct-access/vectors.json (DirectAccessVectorsTest).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable
import java.security.MessageDigest

object DirectAccess {
    private const val TAG_ORDER = "flagship/direct-access/v1"
    private const val TAG_ADDRESS = "flagship/direct-address/v1"
    private const val TAG_HINT_V2 = "flagship/lan-hint/v2"
    const val MAX_ADDRESSES = 8
    const val MAX_PREFIXES = 4
    private const val MIN_PREFIX_V4 = 24
    private const val MIN_PREFIX_V6 = 32
    private const val CLOCK_SKEW_MS = 5L * 60_000
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val OCTET = Regex("^(0|[1-9][0-9]{0,2})$")
    private val PREFIX_LEN = Regex("^(0|[1-9][0-9]{0,2})$")

    // ---- addresses

    class ParsedIp(val family: Int, val bytes: IntArray)

    /** Dotted quad (no leading zeros) or IPv6 hex groups with "::"; no zone, no dotted tail. */
    fun parseIp(text: String): ParsedIp? {
        if (text.isEmpty() || text.length > 45 || text.any { it.code > 0x7f }) return null
        if (text.all { it == '.' || it in '0'..'9' }) {
            val parts = text.split(".")
            if (parts.size != 4) return null
            val bytes = IntArray(4)
            for ((i, p) in parts.withIndex()) {
                if (!OCTET.matches(p)) return null
                val n = p.toInt()
                if (n > 255) return null
                bytes[i] = n
            }
            return ParsedIp(4, bytes)
        }
        if (':' !in text || !text.all { it == ':' || it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        val halves = text.split("::")
        if (halves.size > 2) return null
        fun groups(s: String) = if (s.isEmpty()) emptyList() else s.split(":")
        val head = groups(halves[0])
        val tail = if (halves.size == 2) groups(halves[1]) else emptyList()
        val all = head + tail
        if (all.any { it.isEmpty() || it.length > 4 }) return null
        if (if (halves.size == 1) all.size != 8 else all.size > 7) return null
        val words = (head + List(8 - all.size) { "0" } + tail).map { it.toInt(16) }
        val bytes = IntArray(16)
        words.forEachIndexed { i, w -> bytes[2 * i] = w shr 8; bytes[2 * i + 1] = w and 0xff }
        return ParsedIp(6, bytes)
    }

    /** Dotted quad, or RFC 5952 text. */
    fun formatIp(ip: ParsedIp): String {
        if (ip.family == 4) return ip.bytes.joinToString(".")
        val w = IntArray(8) { (ip.bytes[2 * it] shl 8) or ip.bytes[2 * it + 1] }
        var best = -1
        var bestLen = 0
        var i = 0
        while (i < 8) {
            if (w[i] != 0) { i++; continue }
            var j = i
            while (j < 8 && w[j] == 0) j++
            if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i }
            i = j
        }
        fun hex(from: Int, to: Int) = (from until to).joinToString(":") { Integer.toHexString(w[it]) }
        if (best < 0) return hex(0, 8)
        return "${hex(0, best)}::${hex(best + bestLen, 8)}"
    }

    fun canonicalIp(text: String): String? = parseIp(text)?.let(::formatIp)

    private fun inRange(bytes: IntArray, net: IntArray, len: Int): Boolean {
        for (bit in 0 until len) {
            val mask = 0x80 shr (bit and 7)
            val n = if (bit shr 3 < net.size) net[bit shr 3] else 0
            if ((bytes[bit shr 3] and mask) != (n and mask)) return false
        }
        return true
    }

    private val V4_SPECIAL: List<Pair<IntArray, Int>> = listOf(
        intArrayOf(0) to 8, intArrayOf(10) to 8, intArrayOf(100, 64) to 10, intArrayOf(127) to 8,
        intArrayOf(169, 254) to 16, intArrayOf(172, 16) to 12, intArrayOf(192, 0, 0) to 24, intArrayOf(192, 0, 2) to 24,
        intArrayOf(192, 88, 99) to 24, intArrayOf(192, 168) to 16, intArrayOf(198, 18) to 15, intArrayOf(198, 51, 100) to 24,
        intArrayOf(203, 0, 113) to 24, intArrayOf(224) to 4, intArrayOf(240) to 4,
    )
    private val V6_SPECIAL: List<Pair<IntArray, Int>> = listOf(
        intArrayOf(0x20, 0x01, 0x00, 0x00) to 23, intArrayOf(0x20, 0x01, 0x0d, 0xb8) to 32,
        intArrayOf(0x20, 0x02) to 16, intArrayOf(0x3f, 0xff) to 20,
    )

    /** Globally routable unicast only (same rule as addressPolicy.ts). */
    fun isPublicAddress(text: String): Boolean {
        val p = parseIp(text) ?: return false
        if (p.family == 4) return V4_SPECIAL.none { inRange(p.bytes, it.first, it.second) }
        if (!inRange(p.bytes, intArrayOf(0x20), 3)) return false
        return V6_SPECIAL.none { inRange(p.bytes, it.first, it.second) }
    }

    class Prefix(val ip: ParsedIp, val length: Int)

    fun parsePrefix(text: String): Prefix? {
        val parts = text.split("/")
        if (parts.size != 2 || !PREFIX_LEN.matches(parts[1])) return null
        val ip = parseIp(parts[0]) ?: return null
        val length = parts[1].toInt()
        if (length > ip.bytes.size * 8) return null
        for (bit in length until ip.bytes.size * 8) if (ip.bytes[bit shr 3] and (0x80 shr (bit and 7)) != 0) return null
        return Prefix(ip, length)
    }

    fun formatPrefix(p: Prefix): String = "${formatIp(p.ip)}/${p.length}"

    fun prefixContains(p: Prefix, address: String): Boolean {
        val ip = parseIp(address) ?: return false
        return ip.family == p.ip.family && inRange(ip.bytes, p.ip.bytes, p.length)
    }

    // ---- the owner's order

    @Serializable
    data class Order(
        val serverDomain: String,
        val enabled: Boolean,
        val addresses: List<String>,
        val prefixes: List<String>,
        val port: Int,
        val issuedAt: Long,
    )

    /** The order as the box serves it beside a hint or an address update. */
    @Serializable
    data class SignedOrder(val order: Order, val signatureHex: String)

    /** `GET /api/screens/direct-access`. */
    @Serializable
    data class View(
        val on: Boolean,
        val addresses: List<String>,
        val prefixes: List<String>,
        val port: Int? = null,
        val issuedAt: Long? = null,
        val endpoints: List<LanHint.Endpoint> = emptyList(),
    )

    /** `POST /api/screens/direct-access` answer. */
    @Serializable
    data class Change(val ok: Boolean, val change: String, val directAccess: View)

    /** The reason code an order can't be signed or taken, or null. */
    fun problem(o: Order): String? {
        if (o.serverDomain.isEmpty() || o.serverDomain.any { it == '|' || it == ',' || it.isWhitespace() }) return "no-server"
        if (o.issuedAt <= 0) return "bad-time"
        if (o.port !in 1..65535) return "bad-port"
        if (!o.enabled) return if (o.addresses.isEmpty() && o.prefixes.isEmpty()) null else "off-with-addresses"
        if (o.addresses.isEmpty() && o.prefixes.isEmpty()) return "no-addresses"
        if (o.addresses.size > MAX_ADDRESSES || o.prefixes.size > MAX_PREFIXES) return "too-many"
        for (a in o.addresses) {
            val c = canonicalIp(a) ?: return "bad-address"
            if (c != a) return "non-canonical-address"
            if (!isPublicAddress(a)) return "private-address"
        }
        for (p in o.prefixes) {
            val parsed = parsePrefix(p) ?: return "bad-prefix"
            if (formatPrefix(parsed) != p) return "non-canonical-address"
            if (parsed.length < (if (parsed.ip.family == 4) MIN_PREFIX_V4 else MIN_PREFIX_V6)) return "prefix-too-wide"
            if (!isPublicAddress(formatIp(parsed.ip))) return "private-address"
        }
        if (o.addresses.toSet().size != o.addresses.size || o.prefixes.toSet().size != o.prefixes.size) return "duplicate"
        return null
    }

    fun canonical(o: Order): ByteArray = listOf(
        TAG_ORDER, o.serverDomain, if (o.enabled) "on" else "off",
        o.addresses.sorted().joinToString(","), o.prefixes.sorted().joinToString(","),
        o.port.toString(), o.issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    fun orderSha256(o: Order): String = HexUtil.encode(MessageDigest.getInstance("SHA-256").digest(canonical(o)))

    /** Sign with the sensitive-order key (admin root; the IRK only where none is pinned). Callers gate it behind biometrics. */
    fun sign(o: Order, key: Ed25519Sign): String {
        problem(o)?.let { throw IllegalArgumentException("direct-access order refused: $it") }
        return HexUtil.encode(key.sign(canonical(o)))
    }

    fun verify(o: Order, signatureHex: String, pub: ByteArray): Boolean {
        if (problem(o) != null) return false
        val sig = HexUtil.decode(signatureHex) ?: return false
        return ed25519Valid(sig, canonical(o), pub)
    }

    /** Verified under any of [authorityPubs] (the account's admin root, or its IRK when it pins none). */
    fun verify(s: SignedOrder, authorityPubs: List<ByteArray>): Boolean = authorityPubs.any { verify(s.order, s.signatureHex, it) }

    fun allows(o: Order, address: String): Boolean {
        if (!o.enabled || !isPublicAddress(address) || canonicalIp(address) != address) return false
        if (address in o.addresses) return true
        return o.prefixes.any { p -> parsePrefix(p)?.let { prefixContains(it, address) } ?: false }
    }

    private fun ed25519Valid(sig: ByteArray, msg: ByteArray, pub: ByteArray): Boolean = try {
        Ed25519Verify(pub).verify(sig, msg)
        true
    } catch (_: Throwable) {
        false
    }

    // ---- the box's address update

    @Serializable
    data class AddressUpdate(
        val serverDomain: String,
        val orderSha256: String,
        val addresses: List<String>,
        val port: Int,
        val issuedAt: Long,
    )

    fun canonical(u: AddressUpdate): ByteArray = listOf(
        TAG_ADDRESS, u.serverDomain, u.orderSha256, u.addresses.sorted().joinToString(","), u.port.toString(), u.issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Null when acceptable; otherwise the reason. [order] must already be verified under the owner's key. */
    fun reject(u: AddressUpdate, signature: ByteArray, stkPub: ByteArray, order: Order, serverDomain: String, nowMs: Long): String? {
        if (!ed25519Valid(signature, canonical(u), stkPub)) return "bad-signature"
        if (!u.serverDomain.equals(serverDomain, ignoreCase = true) || !order.serverDomain.equals(u.serverDomain, ignoreCase = true)) return "wrong-server"
        if (!HEX64.matches(u.orderSha256) || u.orderSha256 != orderSha256(order)) return "order-mismatch"
        if (!order.enabled) return "direct-access-off"
        if (u.issuedAt > nowMs + CLOCK_SKEW_MS) return "not-yet-valid"
        if (u.addresses.isEmpty() || u.addresses.size > MAX_ADDRESSES) return "bad-endpoint-count"
        if (u.addresses.toSet().size != u.addresses.size) return "duplicate"
        if (u.port != order.port) return "bad-port"
        for (a in u.addresses) {
            if (canonicalIp(a) != a) return "non-canonical-address"
            if (!isPublicAddress(a)) return "private-address"
            if (!allows(order, a)) return "outside-grant"
        }
        return null
    }

    // ---- hint v2

    @Serializable
    data class HintV2(
        val serverDomain: String,
        val certSha256: String,
        val lan: List<LanHint.Endpoint>,
        val direct: List<LanHint.Endpoint>,
        val orderSha256: String,
        val issuedAt: Long,
        val expiresAt: Long,
    )

    /** `GET /api/screens/lan-hint/v2` body. */
    @Serializable
    data class HintV2Envelope(val hint: HintV2, val signatureHex: String, val directAccess: SignedOrder? = null)

    fun canonical(h: HintV2): ByteArray = listOf(
        TAG_HINT_V2, h.serverDomain, h.certSha256,
        h.lan.map(LanHint::format).sorted().joinToString(","),
        h.direct.map(LanHint::format).sorted().joinToString(","),
        h.orderSha256, h.issuedAt.toString(), h.expiresAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    sealed class HintVerdict {
        data class Accepted(val useDirect: Boolean) : HintVerdict()
        data class Refused(val reason: String) : HintVerdict()
    }

    /** v1's rules for the whole hint; the `direct` part only inside [order] (already verified by the caller). */
    fun check(h: HintV2, signature: ByteArray, stkPub: ByteArray, serverDomain: String, certSha256: String, nowMs: Long, order: Order?): HintVerdict {
        fun no(r: String) = HintVerdict.Refused(r)
        if (!ed25519Valid(signature, canonical(h), stkPub)) return no("bad-signature")
        if (!h.serverDomain.equals(serverDomain, ignoreCase = true)) return no("wrong-server")
        if (!HEX64.matches(h.certSha256) || h.certSha256 != certSha256.lowercase()) return no("cert-mismatch")
        if (h.issuedAt > nowMs + CLOCK_SKEW_MS) return no("not-yet-valid")
        if (h.expiresAt <= nowMs) return no("expired")
        if (h.expiresAt - h.issuedAt > LanHint.MAX_TTL_MS) return no("ttl-too-long")
        if (h.lan.size > LanHint.MAX_ENDPOINTS || h.direct.size > MAX_ADDRESSES || (h.lan.isEmpty() && h.direct.isEmpty())) return no("bad-endpoint-count")
        if ((h.lan + h.direct).any { it.port !in 1..65535 }) return no("bad-port")
        if (h.lan.any { !LanHint.isLanAddress(it.address) }) return no("non-lan-endpoint")
        if (h.direct.isEmpty()) return if (h.orderSha256.isEmpty()) HintVerdict.Accepted(false) else no("order-mismatch")
        if (h.direct.any { canonicalIp(it.address) != it.address || !isPublicAddress(it.address) }) return no("private-address")
        if (!HEX64.matches(h.orderSha256)) return no("order-mismatch")
        if (order == null) return if (h.lan.isEmpty()) no("direct-without-order") else HintVerdict.Accepted(false)
        if (orderSha256(order) != h.orderSha256 || !order.serverDomain.equals(h.serverDomain, ignoreCase = true)) return no("order-mismatch")
        if (!order.enabled) return no("direct-access-off")
        for (e in h.direct) {
            if (e.port != order.port) return no("bad-port")
            if (!allows(order, e.address)) return no("outside-grant")
        }
        return HintVerdict.Accepted(true)
    }
}
