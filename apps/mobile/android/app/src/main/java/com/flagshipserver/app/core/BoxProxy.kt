// A box's outbound proxy (docs/outbound-proxy.md). Kotlin mirror of
// packages/protocol/src/boxProxy.ts; the pinned vectors in
// packages/protocol/test-vectors/box-proxy/ lock the bytes and the messages.
//
// The order is signed with the sensitive-order key (admin root when held,
// else the IRK). Credentials never enter the signed bytes: they travel beside
// the order (the paired session, or the recipe when the owner typed them).

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.serialization.Serializable
import java.security.SecureRandom

@Serializable
data class BoxProxy(
    val serverDomain: String,
    /** "none", "socks5" or "http". */
    val kind: String,
    val host: String,
    val port: Int,
    val auth: Boolean,
    val fallbackDirect: Boolean,
    val issuedAt: Long,
    /** 32 random bytes, lowercase hex. */
    val nonce: String,
)

/** The signed order as it travels: the recipe's `outboundProxy` sibling and the POST body. */
@Serializable
data class BoxProxyWire(val proxy: BoxProxy, val signature: String)

@Serializable
data class BoxProxyCredentials(val username: String, val password: String)

object BoxProxyProtocol {
    const val TAG = "flagship/box-proxy/v1"
    const val PATH = "/api/screens/outbound-proxy"
    const val MAX_SKEW_MS = 10 * 60_000L
    val KINDS = listOf("none", "socks5", "http")

    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX128 = Regex("^[0-9a-f]{128}$")
    private val LABEL = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    private val IPV4 = Regex("^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$")
    private val IPV6 = Regex("^[0-9a-f:.]{2,45}$")
    private val DIGITS_DOTS = Regex("^[0-9.]+$")

    /** Why [host] is not an acceptable proxy host, or null. Expects normalized input. */
    fun hostError(host: String): String? {
        if (host.isEmpty()) return "Enter the proxy's address."
        if (host.length > 253) return "That address is too long."
        if (host.contains(':')) {
            return if (IPV6.matches(host) && host.split(":").size >= 3) null else "That isn't a valid IPv6 address."
        }
        if (IPV4.matches(host)) return null
        if (DIGITS_DOTS.matches(host)) return "That isn't a valid IPv4 address."
        if (host.split(".").all { LABEL.matches(it) }) return null
        return "Use a host name or an IP address, without a scheme, path or port."
    }

    /** Trim, lowercase and drop IPv6 brackets: what the app does to typed input before signing. */
    fun normalizeHost(raw: String): String {
        var h = raw.trim().lowercase()
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length - 1)
        if (h.endsWith(".")) h = h.dropLast(1)
        return h
    }

    /** Why the credentials can't be used, or null. SOCKS5 caps both at 255 bytes. */
    fun credentialsError(username: String, password: String): String? {
        val u = username.toByteArray(Charsets.UTF_8).size
        val p = password.toByteArray(Charsets.UTF_8).size
        if (u == 0 || p == 0) return "Enter a username and password."
        if (u > 255 || p > 255) return "The username and password can be at most 255 bytes each."
        if (username.contains(':')) return "The username can't contain a colon."
        val bad = { s: String -> s.any { it.code <= 0x1f || it.code == 0x7f } }
        if (bad(username) || bad(password)) return "The username and password can't contain control characters."
        return null
    }

    /** Throws IllegalArgumentException on anything the TS reference refuses. */
    fun canonicalBytes(p: BoxProxy): ByteArray {
        require(p.serverDomain.isNotEmpty() && p.serverDomain.none { it == '|' || it.code < 0x20 || it.code == 0x7f }) { "bad serverDomain" }
        require(p.serverDomain == p.serverDomain.lowercase()) { "serverDomain must be lowercase" }
        require(p.kind in KINDS) { "kind must be none, socks5 or http" }
        if (p.kind == "none") {
            require(p.host.isEmpty() && p.port == 0 && !p.auth && !p.fallbackDirect) {
                "kind none carries no host, port, auth or fallback"
            }
        } else {
            require(normalizeHost(p.host) == p.host) { "host must be normalized" }
            hostError(p.host)?.let { throw IllegalArgumentException("host: $it") }
            require(p.port in 1..65535) { "port must be 1..65535" }
        }
        require(HEX64.matches(p.nonce)) { "nonce must be 32-byte lowercase hex" }
        require(p.issuedAt > 0) { "issuedAt must be positive" }
        return listOf(
            TAG,
            p.serverDomain,
            p.kind,
            p.host,
            p.port.toString(),
            if (p.auth) "1" else "0",
            if (p.fallbackDirect) "1" else "0",
            p.issuedAt.toString(),
            p.nonce,
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun sign(p: BoxProxy, signer: Ed25519Sign): String = HexUtil.encode(signer.sign(canonicalBytes(p)))

    fun verify(p: BoxProxy, signatureHex: String, pub: ByteArray): Boolean = runCatching {
        if (!HEX128.matches(signatureHex)) return false
        Ed25519Verify(pub).verify(HexUtil.decode(signatureHex)!!, canonicalBytes(p))
        true
    }.getOrDefault(false)

    fun defaultPort(kind: String): Int = if (kind == "http") 3128 else 1080

    fun kindLabel(kind: String): String = when (kind) {
        "socks5" -> "SOCKS5"
        "http" -> "HTTP"
        else -> "Off"
    }
}

/**
 * What the owner typed in a proxy form (create flow and server page). Turns
 * into a [BoxProxy] once it validates.
 */
data class BoxProxyDraft(
    val kind: String = "none",
    val host: String = "",
    val port: String = "",
    val username: String = "",
    val password: String = "",
    val fallbackDirect: Boolean = false,
) {
    val hasCredentials: Boolean get() = username.isNotEmpty() || password.isNotEmpty()

    /** The first problem with the form, or null when it can be signed. Username and password go together. */
    fun error(): String? {
        if (kind == "none") return null
        BoxProxyProtocol.hostError(BoxProxyProtocol.normalizeHost(host))?.let { return it }
        val p = port.trim().toIntOrNull()
        if (p == null || p !in 1..65535) return "Enter a port from 1 to 65535."
        if (hasCredentials) return BoxProxyProtocol.credentialsError(username, password)
        return null
    }

    /** The order for [serverDomain]; [auth] says whether the proxy needs a password. */
    fun order(
        serverDomain: String,
        auth: Boolean,
        now: Long = System.currentTimeMillis(),
        random: (Int) -> ByteArray = { n -> ByteArray(n).also(SecureRandom()::nextBytes) },
    ): BoxProxy =
        if (kind == "none") {
            BoxProxy(serverDomain.lowercase(), "none", "", 0, false, false, now, HexUtil.encode(random(32)))
        } else {
            BoxProxy(
                serverDomain = serverDomain.lowercase(),
                kind = kind,
                host = BoxProxyProtocol.normalizeHost(host),
                port = port.trim().toInt(),
                auth = auth,
                fallbackDirect = fallbackDirect,
                issuedAt = now,
                nonce = HexUtil.encode(random(32)),
            )
        }

    fun credentials(): BoxProxyCredentials? =
        if (kind != "none" && hasCredentials) BoxProxyCredentials(username, password) else null

    fun withKind(next: String): BoxProxyDraft {
        val switchingPort = port.isEmpty() || port == BoxProxyProtocol.defaultPort(kind).toString()
        return copy(
            kind = next,
            port = if (next == "none") port else if (switchingPort) BoxProxyProtocol.defaultPort(next).toString() else port,
        )
    }

    companion object {
        /** A form prefilled from the box's current setting (credentials are never sent back). */
        fun from(summary: com.flagshipserver.app.api.OutboundProxySummary?): BoxProxyDraft {
            val p = summary?.proxy ?: return BoxProxyDraft()
            return BoxProxyDraft(kind = p.kind, host = p.host, port = p.port.toString(), fallbackDirect = p.fallbackDirect)
        }
    }
}
