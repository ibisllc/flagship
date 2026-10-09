// STK-signed LAN hint — Kotlin mirror of packages/protocol/src/lanHint.ts
// (docs/lan-direct.md). The box serves it to paired devices; this side checks
// it under the STK derived from the phone's own UMK before ever dialing a local
// address. Byte-identical canonical form, pinned by LanHintTest against the
// shared vector.

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable

object LanHint {
    @Serializable
    data class Endpoint(val address: String, val port: Int)

    @Serializable
    data class Hint(
        val serverDomain: String,
        val certSha256: String,
        val endpoints: List<Endpoint>,
        val issuedAt: Long,
        val expiresAt: Long,
    )

    /** `GET /api/screens/lan-hint` body. */
    @Serializable
    data class Envelope(val hint: Hint, val signatureHex: String)

    private const val TAG = "flagship/lan-hint/v1"
    const val MAX_TTL_MS = 24L * 60 * 60_000
    const val MAX_ENDPOINTS = 8
    private const val CLOCK_SKEW_MS = 5L * 60_000
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val V4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
    private val V6 = Regex("^[0-9a-fA-F:]+$")

    /** RFC 1918 IPv4 and fc00::/7 IPv6 only — see isLanAddress in lanHint.ts. */
    fun isLanAddress(address: String): Boolean {
        V4.matchEntire(address)?.let { m ->
            val o = m.groupValues.drop(1).map { it.toInt() }
            if (o.any { it > 255 }) return false
            val (a, b) = o
            return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
        }
        if (!address.contains(':') || address.contains('.') || !V6.matches(address)) return false
        val first = address.substringBefore(':')
        if (first.isEmpty() || first.length > 4) return false
        return (first.toInt(16) and 0xfe00) == 0xfc00
    }

    fun format(e: Endpoint): String =
        if (e.address.contains(':')) "[${e.address.lowercase()}]:${e.port}" else "${e.address}:${e.port}"

    fun canonical(h: Hint): ByteArray = listOf(
        TAG,
        h.serverDomain,
        h.certSha256,
        h.endpoints.map(::format).sorted().joinToString(","),
        h.issuedAt.toString(),
        h.expiresAt.toString(),
    ).joinToString("|").toByteArray(Charsets.UTF_8)

    /** Null when the hint is acceptable; otherwise why it was refused. */
    fun reject(
        h: Hint,
        signature: ByteArray,
        stkPub: ByteArray,
        serverDomain: String,
        certSha256: String,
        nowMs: Long,
    ): String? {
        val sigOk = try {
            Ed25519Verify(stkPub).verify(signature, canonical(h))
            true
        } catch (_: Throwable) {
            false
        }
        return when {
            !sigOk -> "bad-signature"
            !h.serverDomain.equals(serverDomain, ignoreCase = true) -> "wrong-server"
            !HEX64.matches(h.certSha256) || h.certSha256 != certSha256.lowercase() -> "cert-mismatch"
            h.issuedAt > nowMs + CLOCK_SKEW_MS -> "not-yet-valid"
            h.expiresAt <= nowMs -> "expired"
            h.expiresAt - h.issuedAt > MAX_TTL_MS -> "ttl-too-long"
            h.endpoints.isEmpty() || h.endpoints.size > MAX_ENDPOINTS -> "bad-endpoint-count"
            h.endpoints.any { !isLanAddress(it.address) } -> "non-lan-endpoint"
            h.endpoints.any { it.port !in 1..65535 } -> "bad-port"
            else -> null
        }
    }
}
