// LAN-direct (docs/lan-direct.md): reach a box over the local network
// instead of the .services relay when the phone is next to it.
//
// The box advertises its LAN endpoints in an STK-signed hint (LanHint). A hint
// is only ever USED after a probe proves the box is really there on THIS
// network: a TLS handshake to the endpoint with SNI = the box hostname, whose
// leaf must match the pinned fingerprint. The same private address can belong
// to a different device on another network, and a pin failure is not a
// connection failure OkHttp retries on another route — so the probe, not the
// hint, decides. Probes are cached per network and dropped on any change.
//
// Routing is a custom OkHttp Dns: for a box host it returns the LAN address
// first, then the normal addresses, so SNI, hostname verification and the cert
// pin all still run against the hostname, and a dead LAN route falls through
// to the relay.

package com.flagshipserver.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Dns
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

fun interface LanProber {
    /** True only if [address]:[port] completes a TLS handshake for [sniHost]
     *  whose leaf matches [certSha256]. */
    fun probe(sniHost: String, address: String, port: Int, certSha256: String): Boolean
}

class TlsPinProber(
    private val connectTimeoutMs: Int = 400,
    private val handshakeTimeoutMs: Int = 1_500,
) : LanProber {
    override fun probe(sniHost: String, address: String, port: Int, certSha256: String): Boolean = try {
        Socket().use { raw ->
            // An IP literal: getByName parses it without a DNS lookup.
            raw.connect(InetSocketAddress(InetAddress.getByName(address), port), connectTimeoutMs)
            raw.soTimeout = handshakeTimeoutMs
            val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
            (factory.createSocket(raw, sniHost, port, true) as SSLSocket).use { ssl ->
                ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(sniHost)) }
                ssl.startHandshake()
                leafDerSha256Hex(ssl.session.peerCertificates.firstOrNull()?.encoded) == certSha256
            }
        }
    } catch (_: Throwable) {
        false
    }
}

class LanDirectRegistry(
    private val prober: LanProber = TlsPinProber(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    companion object {
        val shared = LanDirectRegistry()
        const val PROBE_TTL_MS = 5L * 60_000
        const val REFRESH_INTERVAL_MS = 10L * 60_000
        /** OkHttp keeps the URL's port, so only :443 endpoints are usable. */
        const val HTTPS_PORT = 443
    }

    private data class Entry(val endpoints: List<LanHint.Endpoint>, val certSha256: String, val expiresAt: Long)

    private val hints = ConcurrentHashMap<String, Entry>()
    private val probes = ConcurrentHashMap<String, Pair<Boolean, Long>>()
    private val lastRefresh = ConcurrentHashMap<String, Long>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Verify and keep a hint for [box]. Returns why it was refused, or null. */
    fun accept(box: String, envelope: LanHint.Envelope, stkPub: ByteArray, pinnedCertSha256: String): String? {
        val sig = HexUtil.decode(envelope.signatureHex) ?: return "bad-signature".also { forget(box) }
        val why = LanHint.reject(envelope.hint, sig, stkPub, box, pinnedCertSha256, clock())
        if (why == null) {
            hints[box.lowercase()] = Entry(envelope.hint.endpoints, envelope.hint.certSha256, envelope.hint.expiresAt)
        } else {
            forget(box)
        }
        return why
    }

    fun forget(box: String) {
        val b = box.lowercase()
        hints.remove(b)
        probes.keys.removeIf { it.startsWith("$b|") }
    }

    /** Any network change voids every probe (and re-allows a hint refresh). */
    fun onNetworkChanged() {
        probes.clear()
        lastRefresh.clear()
    }

    /**
     * Fetch, verify and store [box]'s hint in the background, at most once per
     * [REFRESH_INTERVAL_MS]. Needs the cert pin already learned from /pods —
     * the hint is bound to it.
     */
    fun refresh(
        box: String,
        stkPub: ByteArray,
        pinnedCertSha256: String?,
        fetch: suspend () -> LanHint.Envelope?,
    ) {
        if (pinnedCertSha256 == null) return
        val now = clock()
        val b = box.lowercase()
        val last = lastRefresh[b]
        if (last != null && now - last < REFRESH_INTERVAL_MS) return
        lastRefresh[b] = now
        scope.launch {
            val envelope = runCatching { fetch() }.getOrNull()
            if (envelope == null) forget(b) else accept(b, envelope, stkPub, pinnedCertSha256)
        }
    }

    /** The LAN address to try for [host] — the box or a name under it — or
     *  null. Probes (blocking, bounded) on first use per network. */
    fun lanAddressFor(host: String): String? {
        val h = host.lowercase()
        val (box, entry) = hints.entries.firstOrNull { h == it.key || h.endsWith(".${it.key}") }
            ?.let { it.key to it.value } ?: return null
        if (entry.expiresAt <= clock()) {
            forget(box)
            return null
        }
        for (e in entry.endpoints) {
            if (e.port != HTTPS_PORT) continue
            val key = "$box|${e.address}"
            val cached = probes[key]
            val ok = if (cached != null && clock() - cached.second < PROBE_TTL_MS) {
                cached.first
            } else {
                prober.probe(box, e.address, e.port, entry.certSha256).also { probes[key] = it to clock() }
            }
            if (ok) return e.address
        }
        return null
    }
}

class LanDirectDns(
    private val registry: LanDirectRegistry = LanDirectRegistry.shared,
    private val delegate: Dns = Dns.SYSTEM,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val lan = registry.lanAddressFor(hostname) ?: return delegate.lookup(hostname)
        val lanAddr = InetAddress.getByName(lan)
        // The relay addresses stay as fallback routes; a LAN-only moment
        // (internet down) still works because the LAN address comes first.
        val rest = try {
            delegate.lookup(hostname)
        } catch (_: UnknownHostException) {
            emptyList()
        }
        return listOf(lanAddr) + rest.filter { it != lanAddr }
    }
}
