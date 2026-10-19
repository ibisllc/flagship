// A relay hint (docs/relay-hints.md): a maintainer-signed list of the relay's
// well-known addresses, an ADVISORY the app uses only when DNS cannot resolve a
// box's name. The envelope and rules are packages/protocol/src/relayHint.ts; the
// shared vectors (test-vectors/relay-hint/vectors.json) pin this port to it.
//
// It carries no trust of its own: a box is still authenticated by TLS to its
// own name and its pinned certificate. The signature only stops a network or
// `.com` from steering every phone's fallback somewhere useless. Everything
// fails open: unverifiable, expired or malformed means the compiled-in seed.

package com.flagshipserver.app.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class RelayHintException(val code: String) : Exception("flagship/relay-hint/v1: $code")

data class RelayHint(
    val seq: Long,
    val validFrom: Long,
    val validUntil: Long,
    val addresses: List<String>,
    val signedBy: String,
    val signature: String,
    val raw: JsonObject,
)

data class RelayHintStore(val highestSeq: Long, val hint: RelayHint?)

data class RelayHintAccept(val store: RelayHintStore, val refused: String?)

object RelayHintProtocol {
    const val TAG = "flagship/relay-hint/v1"
    const val MAX_WINDOW_MS = 180L * 24 * 3600_000
    const val MAX_ADDRESSES = 8

    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX128 = Regex("^[0-9a-f]{128}$")
    private const val MAX_SAFE = 9_007_199_254_740_991L

    private fun fail(code: String): Nothing = throw RelayHintException(code)

    private fun uint(e: JsonElement?): Long? {
        val p = e as? JsonPrimitive ?: return null
        if (p.isString) return null
        val s = p.content
        if (s.isEmpty() || s.length > 16 || !s.all { it in '0'..'9' }) return null
        val v = s.toLongOrNull() ?: return null
        return if (v in 0..MAX_SAFE) v else null
    }

    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun ipv4Problem(a: String): String? {
        val m = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(a) ?: return "bad-address"
        val parts = m.groupValues.drop(1)
        val o = parts.map { it.toInt() }
        if (o.indices.any { o[it] > 255 || o[it].toString() != parts[it] }) return "bad-address"
        val (a0, a1) = o
        if (a0 == 0 || a0 == 10 || a0 == 127 || a0 >= 224) return "not-public"
        if (a0 == 100 && a1 in 64..127) return "not-public"
        if (a0 == 169 && a1 == 254) return "not-public"
        if (a0 == 172 && a1 in 16..31) return "not-public"
        if (a0 == 192 && a1 == 168) return "not-public"
        return null
    }

    private fun ipv6Problem(a: String): String? {
        if (!a.all { it in '0'..'9' || it in 'a'..'f' || it == ':' } || ':' !in a || a.length > 39) return "bad-address"
        if (a.split("::").size > 2 || ":::" in a) return "bad-address"
        val groups = a.split(":")
        if (groups.any { it.length > 4 }) return "bad-address"
        val hasGap = "::" in a
        val filled = groups.count { it.isNotEmpty() }
        if (if (hasGap) filled > 7 else groups.size != 8 || filled != 8) return "bad-address"
        val first = groups[0].ifEmpty { "0" }.toInt(16)
        if (a == "::" || a == "::1") return "not-public"
        if ((first and 0xfe00) == 0xfc00 || (first and 0xffc0) == 0xfe80 || (first and 0xff00) == 0xff00) return "not-public"
        if ((first and 0xe000) != 0x2000) return "not-public"
        return null
    }

    /** Null when [a] is a lowercase, public unicast IPv4 or IPv6 literal, else why not. */
    fun addressProblem(a: String): String? = if (':' in a) ipv6Problem(a) else ipv4Problem(a)

    /** Check the whole rule set and return the bytes the signature covers. */
    fun canonical(b: JsonObject, signedBy: String): ByteArray {
        if (!HEX64.matches(signedBy)) fail("bad-signer")
        val seq = uint(b["seq"])?.takeIf { it >= 1 } ?: fail("bad-seq")
        val from = uint(b["validFrom"]) ?: fail("bad-time")
        val until = uint(b["validUntil"]) ?: fail("bad-time")
        if (until <= from) fail("window-order")
        if (until - from > MAX_WINDOW_MS) fail("window-too-long")
        val arr = b["addresses"] as? JsonArray ?: fail("addresses-required")
        if (arr.isEmpty()) fail("addresses-required")
        if (arr.size > MAX_ADDRESSES) fail("too-many-addresses")
        val seen = HashSet<String>()
        val addrs = arr.map { e ->
            val a = str(e) ?: fail("bad-address")
            addressProblem(a)?.let { fail(it) }
            if (!seen.add(a)) fail("duplicate-address")
            a
        }
        return listOf(TAG, signedBy, seq.toString(), from.toString(), until.toString(), addrs.joinToString(","))
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    /** Shape-check an untrusted hint and enforce every rule (no signature check). Null when it fails. */
    fun parse(v: JsonElement?): RelayHint? {
        val o = v as? JsonObject ?: return null
        if (str(o["type"]) != "RelayHint" || uint(o["version"]) != 1L) return null
        val signedBy = str(o["signedBy"]) ?: return null
        val signature = str(o["signature"]) ?: return null
        if (!HEX64.matches(signedBy) || !HEX128.matches(signature)) return null
        try {
            canonical(o, signedBy)
        } catch (_: RelayHintException) {
            return null
        }
        return RelayHint(
            seq = uint(o["seq"])!!,
            validFrom = uint(o["validFrom"])!!,
            validUntil = uint(o["validUntil"])!!,
            addresses = (o["addresses"] as JsonArray).map { str(it)!! },
            signedBy = signedBy,
            signature = signature,
            raw = o,
        )
    }

    /** Is the signature good, and is the signer one of [authorityKeys]? Null when yes, else the reason. */
    fun verify(h: RelayHint, authorityKeys: List<String>): String? {
        val bytes = try {
            canonical(h.raw, h.signedBy)
        } catch (_: RelayHintException) {
            return "malformed"
        }
        if (!HEX128.matches(h.signature)) return "malformed"
        if (h.signedBy !in authorityKeys) return "unauthorized-signer"
        return if (MaintainersEd25519.verify(h.signature, bytes, h.signedBy)) null else "signature-invalid"
    }

    /** Fold a candidate into the store; a refused one leaves the store as it was. */
    fun accept(store: RelayHintStore, candidate: JsonElement?, authorityKeys: List<String>): RelayHintAccept {
        if (candidate == null || candidate is kotlinx.serialization.json.JsonNull) return RelayHintAccept(store, null)
        val h = parse(candidate) ?: return RelayHintAccept(store, "malformed")
        verify(h, authorityKeys)?.let { return RelayHintAccept(store, it) }
        if (h.seq <= store.highestSeq) return RelayHintAccept(store, "stale")
        return RelayHintAccept(RelayHintStore(h.seq, h), null)
    }

    /**
     * The addresses to try when DNS fails, in order: the stored hint's if it is
     * in its window and still verifies against the authority now, then the
     * compiled-in [seed] (deduplicated). Never throws.
     */
    fun addresses(store: RelayHintStore, authorityKeys: List<String>, seed: List<String>, now: Long): List<String> {
        val out = ArrayList<String>()
        val h = store.hint
        if (h != null && now >= h.validFrom && now < h.validUntil && verify(h, authorityKeys) == null) out.addAll(h.addresses)
        for (a in seed) if (a !in out) out.add(a)
        return out
    }
}
