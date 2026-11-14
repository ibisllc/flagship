// Direct names — Kotlin mirror of packages/protocol/src/directName.ts
// (docs/direct-access-and-domains.md §8). The owner's admin device signs one
// order per name on the direct domain; `.com` publishes exactly what it says.
// Pinned by packages/protocol/test-vectors/direct-name/vectors.json (DirectNameVectorsTest).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable

object DirectName {
    private const val TAG = "flagship/direct-name/v1"
    const val APEX = "fshp.app"
    const val CAA_PIN = "pin"
    const val CAA_OFF = "off"

    @Serializable
    data class Order(
        val name: String,
        val serverDomain: String,
        val enabled: Boolean,
        val addresses: List<String>,
        /** [CAA_PIN] or [CAA_OFF]. */
        val caa: String,
        val issuedAt: Long,
    )

    @Serializable
    data class SignedOrder(val order: Order, val signatureHex: String)

    sealed class Kind {
        data class Derived(val slug: String, val creator: String) : Kind()
        object Vanity : Kind()
    }

    val RESERVED_LABELS: Set<String> = setOf(
        "www", "webapp", "remote", "recovery", "boot", "web", "api", "app", "apps", "admin", "mail", "smtp", "imap",
        "ns", "ns1", "ns2", "dns", "relay", "status", "docs", "help", "support", "security", "abuse", "flagship",
        "flagshipserver", "fshp", "voici", "inference", "_psl",
    )

    private val LABEL = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    private val USER = Regex("^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")
    private val SLUG = Regex("^[a-z0-9](?:-?[a-z0-9]){0,29}$")

    /** The label of [name] under [apex], or null when it isn't exactly one valid label deeper. */
    fun labelOf(name: String, apex: String = APEX): String? {
        if (name != name.lowercase() || !name.endsWith(".$apex")) return null
        val label = name.dropLast(apex.length + 1)
        return label.takeIf { LABEL.matches(it) }
    }

    /** What a label is, or null when it may not be held (reserved, punycode, two `--`, a bad half). */
    fun kind(label: String): Kind? {
        if (!LABEL.matches(label) || label.startsWith("xn--") || label in RESERVED_LABELS) return null
        val parts = label.split("--")
        if (parts.size == 1) return Kind.Vanity
        if (parts.size != 2 || !SLUG.matches(parts[0]) || !USER.matches(parts[1])) return null
        return Kind.Derived(parts[0], parts[1])
    }

    /** `<slug>--<creator>.<apex>`, or null when the label can't be held. */
    fun derivedName(slug: String, creator: String, apex: String = APEX): String? {
        val label = "${slug.lowercase()}--${creator.lowercase()}"
        return if (kind(label) is Kind.Derived) "$label.$apex" else null
    }

    /** The reason code an order can't be signed or taken, or null. */
    fun problem(o: Order, apex: String = APEX): String? {
        val label = labelOf(o.name, apex)
        if (label == null || kind(label) == null) return "bad-name"
        if (o.serverDomain.isEmpty() || o.serverDomain.any { it == '|' || it == ',' || it.isWhitespace() }) return "no-server"
        if (o.caa != CAA_PIN && o.caa != CAA_OFF) return "bad-caa"
        if (o.issuedAt <= 0) return "bad-time"
        if (!o.enabled) return if (o.addresses.isEmpty()) null else "off-with-addresses"
        if (o.addresses.size > DirectAccess.MAX_ADDRESSES) return "too-many"
        for (a in o.addresses) {
            val c = DirectAccess.canonicalIp(a) ?: return "bad-address"
            if (c != a) return "non-canonical-address"
            if (!DirectAccess.isPublicAddress(a)) return "private-address"
        }
        if (o.addresses.toSet().size != o.addresses.size) return "duplicate"
        return null
    }

    fun canonical(o: Order): ByteArray = listOf(
        TAG, o.name, o.serverDomain, if (o.enabled) "on" else "off",
        o.addresses.sorted().joinToString(","), o.caa, o.issuedAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Sign with the sensitive-order key (admin root; the IRK only where none is pinned). Callers gate it behind biometrics. */
    fun sign(o: Order, key: Ed25519Sign): String {
        problem(o)?.let { throw IllegalArgumentException("direct-name order refused: $it") }
        return HexUtil.encode(key.sign(canonical(o)))
    }

    fun verify(o: Order, signatureHex: String, pub: ByteArray): Boolean {
        if (problem(o) != null) return false
        val sig = HexUtil.decode(signatureHex) ?: return false
        return try {
            Ed25519Verify(pub).verify(sig, canonical(o))
            true
        } catch (_: Throwable) {
            false
        }
    }
}
