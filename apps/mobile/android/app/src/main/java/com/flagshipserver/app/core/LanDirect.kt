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
//
// Failure is a no-op: probes run in the background (a request never waits for
// one), a LAN connect gives up after LAN_CONNECT_TIMEOUT_MS, and a request
// that fails on the LAN route stops LAN use on this network and, when it is
// safe to replay, is sent again over the relay (LanDirectFallbackInterceptor).

package com.flagshipserver.app.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import javax.net.SocketFactory
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
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
    /** Runs a probe off the request path; tests pass `{ it() }`. */
    private val launch: (() -> Unit) -> Unit = { block -> backgroundScope.launch { block() } },
    private val log: (String) -> Unit = { m -> runCatching { android.util.Log.i("LanDirect", m) } },
) {
    companion object {
        private val backgroundScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val shared = LanDirectRegistry()
        const val PROBE_TTL_MS = 5L * 60_000
        const val REFRESH_INTERVAL_MS = 10L * 60_000
        /** OkHttp keeps the URL's port, so only :443 endpoints are usable. */
        const val HTTPS_PORT = 443
    }

    private data class Entry(val endpoints: List<LanHint.Endpoint>, val certSha256: String, val expiresAt: Long)

    private val hints = ConcurrentHashMap<String, Entry>()
    private val probes = ConcurrentHashMap<String, Pair<Boolean, Long>>()
    private val probing = ConcurrentHashMap.newKeySet<String>()
    private val lastRefresh = ConcurrentHashMap<String, Long>()

    /** Verify and keep a hint for [box]. Returns why it was refused, or null. */
    fun accept(box: String, envelope: LanHint.Envelope, stkPub: ByteArray, pinnedCertSha256: String): String? {
        val sig = HexUtil.decode(envelope.signatureHex) ?: return "bad-signature".also { forget(box) }
        val why = LanHint.reject(envelope.hint, sig, stkPub, box, pinnedCertSha256, clock())
        if (why == null) {
            hints[box.lowercase()] = Entry(envelope.hint.endpoints, envelope.hint.certSha256, envelope.hint.expiresAt)
        } else {
            forget(box)
            log("refused $box's LAN hint ($why); staying on the relay")
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
        backgroundScope.launch {
            val envelope = runCatching { fetch() }.getOrNull()
            if (envelope == null) forget(b) else accept(b, envelope, stkPub, pinnedCertSha256)
        }
    }

    private fun entryFor(host: String): Pair<String, Entry>? {
        val h = host.lowercase()
        val (box, entry) = hints.entries.firstOrNull { h == it.key || h.endsWith(".${it.key}") }
            ?.let { it.key to it.value } ?: return null
        if (entry.expiresAt <= clock()) {
            forget(box)
            return null
        }
        return box to entry
    }

    /** A proven LAN address for [host] right now, without starting a probe. */
    fun provenAddressFor(host: String): String? {
        val (box, entry) = entryFor(host) ?: return null
        val now = clock()
        return entry.endpoints.firstOrNull { e ->
            if (e.port != HTTPS_PORT) return@firstOrNull false
            val p = probes["$box|${e.address}"]
            p != null && p.first && now - p.second < PROBE_TTL_MS
        }?.address
    }

    /**
     * The LAN address to try for [host] — the box or a name under it — or
     * null. Never blocks: when no fresh probe result exists, one starts in the
     * background and this request uses the relay.
     */
    fun lanAddressFor(host: String): String? {
        val (box, entry) = entryFor(host) ?: return null
        val now = clock()
        val stale = entry.endpoints.any { e ->
            e.port == HTTPS_PORT && probes["$box|${e.address}"].let { it == null || now - it.second >= PROBE_TTL_MS }
        }
        val proven = provenAddressFor(host)
        if (proven == null && stale && probing.add(box)) {
            launch {
                try {
                    for (e in entry.endpoints) {
                        if (e.port != HTTPS_PORT) continue
                        val key = "$box|${e.address}"
                        val cached = probes[key]
                        if (cached != null && clock() - cached.second < PROBE_TTL_MS) continue
                        val ok = prober.probe(box, e.address, e.port, entry.certSha256)
                        probes[key] = ok to clock()
                        log(if (ok) "$box proved itself at ${e.address}; using the local network" else "$box isn't at ${e.address} on this network; using the relay")
                    }
                } finally {
                    probing.remove(box)
                }
            }
        }
        return proven ?: provenAddressFor(host)
    }

    /** The LAN route to [host] just failed: stop using it on this network. */
    fun markFailed(host: String, why: String) {
        val h = host.lowercase()
        val now = clock()
        var any = false
        for (key in probes.keys) {
            val box = key.substringBefore('|')
            if (h == box || h.endsWith(".$box")) {
                probes[key] = false to now
                any = true
            }
        }
        if (any) log("the local route to $host failed ($why); using the relay on this network")
    }

    /** A connection to [address] (a LAN address) failed: stop using it. */
    fun markAddressFailed(address: String, why: String) {
        val now = clock()
        val want = normalized(address)
        for ((key, v) in probes) {
            if (v.first && normalized(key.substringAfter('|')) == want) {
                probes[key] = false to now
                log("${key.substringBefore('|')} stopped answering at $address ($why); using the relay on this network")
            }
        }
    }
}

/** One spelling per address (IPv6 has several); literals only, so no DNS. */
private fun normalized(address: String): String =
    runCatching { InetAddress.getByName(address).hostAddress }.getOrNull() ?: address

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

/**
 * Sockets that give a LAN address [lanConnectTimeoutMs] to answer instead of
 * the client's whole connect timeout, so a box that left the network costs a
 * moment before OkHttp moves on to the relay route, not 15 s.
 */
class LanAwareSocketFactory(
    private val registry: LanDirectRegistry = LanDirectRegistry.shared,
    private val lanConnectTimeoutMs: Int = LAN_CONNECT_TIMEOUT_MS,
    private val delegate: SocketFactory = SocketFactory.getDefault(),
) : SocketFactory() {
    companion object {
        const val LAN_CONNECT_TIMEOUT_MS = 1_500

        /** The connect timeout for [address]: capped for LAN addresses only (0 = none). */
        fun connectTimeoutFor(address: String, timeout: Int, lanCapMs: Int = LAN_CONNECT_TIMEOUT_MS): Int = when {
            !LanHint.isLanAddress(address.substringBefore('%')) -> timeout
            timeout == 0 -> lanCapMs
            else -> minOf(timeout, lanCapMs)
        }
    }

    private inner class LanAwareSocket : Socket() {
        override fun connect(endpoint: SocketAddress, timeout: Int) {
            val address = (endpoint as? InetSocketAddress)?.address?.hostAddress
            if (address == null || !LanHint.isLanAddress(address.substringBefore('%'))) {
                return super.connect(endpoint, timeout)
            }
            try {
                super.connect(endpoint, connectTimeoutFor(address, timeout, lanConnectTimeoutMs))
            } catch (e: IOException) {
                registry.markAddressFailed(address, e.javaClass.simpleName)
                throw e
            }
        }
    }

    override fun createSocket(): Socket = LanAwareSocket()
    override fun createSocket(host: String, port: Int): Socket = delegate.createSocket(host, port)
    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
        delegate.createSocket(host, port, localHost, localPort)
    override fun createSocket(host: InetAddress, port: Int): Socket = delegate.createSocket(host, port)
    override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
        delegate.createSocket(address, port, localAddress, localPort)
}

/**
 * A request that was routed to a box's LAN address and failed there: stop
 * using the LAN on this network, and send it again over the relay when that
 * can't apply a change twice — the failure came before the box could have
 * read it (TLS refused, nothing answered), or the request only reads.
 * A pin or hostname failure on the LAN route means another device holds that
 * address, which is not an interception of the relay path.
 */
class LanDirectFallbackInterceptor(
    private val registry: LanDirectRegistry = LanDirectRegistry.shared,
) : Interceptor {
    companion object {
        fun failedBeforeDelivery(e: IOException): Boolean =
            e is SSLHandshakeException || e is SSLPeerUnverifiedException ||
                e is ConnectException || e is NoRouteToHostException

        private val READS = setOf("GET", "HEAD", "OPTIONS")
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val host = request.url.host
        if (registry.provenAddressFor(host) == null) return chain.proceed(request)
        return try {
            chain.proceed(request)
        } catch (e: IOException) {
            registry.markFailed(host, e.javaClass.simpleName)
            if (!failedBeforeDelivery(e) && request.method !in READS) throw e
            chain.proceed(request)
        }
    }
}
