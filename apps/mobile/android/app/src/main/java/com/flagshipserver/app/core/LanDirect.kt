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

import com.flagshipserver.app.R
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
    /** A public (direct-access) endpoint crosses the internet, so it gets longer to answer. */
    private val publicConnectTimeoutMs: Int = 1_500,
    private val publicHandshakeTimeoutMs: Int = 3_000,
) : LanProber {
    override fun probe(sniHost: String, address: String, port: Int, certSha256: String): Boolean = try {
        val lan = LanHint.isLanAddress(address)
        Socket().use { raw ->
            // An IP literal: getByName parses it without a DNS lookup.
            raw.connect(InetSocketAddress(InetAddress.getByName(address), port), if (lan) connectTimeoutMs else publicConnectTimeoutMs)
            raw.soTimeout = if (lan) handshakeTimeoutMs else publicHandshakeTimeoutMs
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

    /** [endpoints]: LAN first, then direct-access ones, so a proven LAN route wins. */
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
            // Offline control starts from where this box was last seen (docs/data-sovereignty.md 4.9).
            if (this === shared) {
                for (e in envelope.hint.endpoints.reversed()) {
                    RescueServerBook.shared.saw(box, if (':' in e.address) "[${e.address}]:${e.port}" else "${e.address}:${e.port}")
                }
            }
        } else {
            forget(box)
            log("refused $box's LAN hint ($why); staying on the relay")
        }
        return why
    }

    /**
     * Verify and keep a v2 hint for [box] (direct access, docs/direct-access-and-domains.md). Its public
     * endpoints are kept only when the owner's order beside it verifies under one of [authorityPubs] (the
     * account's admin root, or its IRK when it pins none) and the hint sits inside it. Returns why it was
     * refused, or null.
     */
    fun accept(box: String, envelope: DirectAccess.HintV2Envelope, stkPub: ByteArray, pinnedCertSha256: String, authorityPubs: List<ByteArray>): String? {
        val sig = HexUtil.decode(envelope.signatureHex) ?: return "bad-signature".also { forget(box) }
        val order = envelope.directAccess?.takeIf { DirectAccess.verify(it, authorityPubs) }?.order
        if (envelope.directAccess != null && order == null && envelope.hint.direct.isNotEmpty()) {
            log("not using the public addresses of $box: its direct-access order doesn't verify under the account's key")
        }
        return when (val v = DirectAccess.check(envelope.hint, sig, stkPub, box, pinnedCertSha256, clock(), order)) {
            is DirectAccess.HintVerdict.Refused -> {
                forget(box)
                log("refused $box's hint (${v.reason}); staying on the relay")
                v.reason
            }
            is DirectAccess.HintVerdict.Accepted -> {
                val endpoints = envelope.hint.lan + if (v.useDirect) envelope.hint.direct else emptyList()
                hints[box.lowercase()] = Entry(endpoints, envelope.hint.certSha256, envelope.hint.expiresAt)
                // Offline control is LAN-only: only the LAN endpoints go into its book.
                if (this === shared) {
                    for (e in envelope.hint.lan.reversed()) {
                        RescueServerBook.shared.saw(box, if (':' in e.address) "[${e.address}]:${e.port}" else "${e.address}:${e.port}")
                    }
                }
                null
            }
        }
    }

    /** True when [address] is a direct-access endpoint of a hint this registry holds. */
    fun isDirectAddress(address: String): Boolean {
        val want = normalized(address)
        return hints.values.any { e -> e.endpoints.any { !LanHint.isLanAddress(it.address) && normalized(it.address) == want } }
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
        fetchV2: (suspend () -> DirectAccess.HintV2Envelope?)? = null,
        authorityPubs: () -> List<ByteArray> = { emptyList() },
    ) {
        if (pinnedCertSha256 == null) return
        val now = clock()
        val b = box.lowercase()
        val last = lastRefresh[b]
        if (last != null && now - last < REFRESH_INTERVAL_MS) return
        lastRefresh[b] = now
        backgroundScope.launch {
            // An older box answers nothing on the v2 path; its v1 hint is used.
            val v2 = fetchV2?.let { f -> runCatching { f() }.getOrNull() }
            if (v2 != null) {
                accept(b, v2, stkPub, pinnedCertSha256, authorityPubs())
                return@launch
            }
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
                        log(if (ok) FSStrings.get(R.string.proved_itself_at_using_the_local, box, e.address) else FSStrings.get(R.string.isnt_at_on_this_network_using, box, e.address))
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

    /** A connection to [address] (a LAN or direct-access address) failed: stop using it. */
    fun markAddressFailed(address: String, why: String) {
        val now = clock()
        val want = normalized(address)
        for ((key, v) in probes) {
            if (v.first && normalized(key.substringAfter('|')) == want) {
                probes[key] = false to now
                log(FSStrings.get(R.string.stopped_answering_at_using_the_relay, key.substringBefore('|'), address, why))
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
        /** A proven direct-access (public) endpoint gets a little longer before OkHttp moves to the relay. */
        const val DIRECT_CONNECT_TIMEOUT_MS = 3_000

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
            val lan = address != null && LanHint.isLanAddress(address.substringBefore('%'))
            val direct = address != null && !lan && registry.isDirectAddress(address)
            if (address == null || (!lan && !direct)) {
                return super.connect(endpoint, timeout)
            }
            try {
                val cap = if (direct) (if (timeout == 0) DIRECT_CONNECT_TIMEOUT_MS else minOf(timeout, DIRECT_CONNECT_TIMEOUT_MS))
                else connectTimeoutFor(address, timeout, lanConnectTimeoutMs)
                super.connect(endpoint, cap)
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
