// The relay addresses `.com` recommends (docs/relay-addresses.md). When DNS cannot
// resolve a box's name, RelayFallbackDns connects to the relay directly; these
// are the addresses it tries after `relay-fallback.<apex>` and before the
// compiled-in seed.
//
// The app asks `.com`, which it already reaches over ordinary TLS, via
// `GET /api/services/endpoints` (passthroughIPv4 / passthroughIPv6). Nothing
// here is trusted with the box: the connection must still show the box's own
// pinned certificate, so a wrong address can only fail to connect. The request
// is one anonymous GET, and failure changes nothing.

package com.flagshipserver.app.core

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress

object RelayAddressRules {
    const val MAX_ADDRESSES = 8

    /** A public unicast address: not the phone, the local network, a shared range or multicast. */
    fun isPublic(a: InetAddress): Boolean {
        if (a.isAnyLocalAddress || a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isMulticastAddress) return false
        val b = a.address
        return when (a) {
            is Inet4Address -> (b[0].toInt() and 0xff) < 240 && !((b[0].toInt() and 0xff) == 100 && (b[1].toInt() and 0xc0) == 0x40)
            is Inet6Address -> (b[0].toInt() and 0xfe) != 0xfc && (b[0].toInt() and 0xe0) == 0x20
            else -> false
        }
    }

    /** An IP literal (never a hostname, so parsing it cannot cause a lookup), public, or null. */
    fun parse(text: String): InetAddress? {
        val t = text.trim()
        val literal = if (':' in t) t.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' || it == ':' } else
            Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(t)
        if (!literal) return null
        val a = runCatching { InetAddress.getByName(t) }.getOrNull() ?: return null
        return a.takeIf(::isPublic)
    }

    /** The address named in a relay echo reply (an HTTP response with a JSON `reachedAt`), or null. */
    fun parseEchoReply(raw: String): InetAddress? {
        val body = raw.substringAfter("\r\n\r\n", "")
        val o = runCatching { SecurityNoticeProtocol.json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
        val text = (o["reachedAt"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        return parse(text)
    }

    /** The recommended addresses in a `/api/services/endpoints` body: IPv4 then IPv6, public ones only. */
    fun fromEndpoints(body: String): List<InetAddress> {
        val o = runCatching { SecurityNoticeProtocol.json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return emptyList()
        return listOf("passthroughIPv4", "passthroughIPv6")
            .mapNotNull { (o[it] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            .mapNotNull(::parse)
            .distinct()
            .take(MAX_ADDRESSES)
    }
}

/**
 * Is [address] the relay, up, forwarding to the box named [sniHost]? A handshake to it
 * under that name that ends in the box's own pinned certificate says so: a relay that
 * is down or stale fails, and one that isn't authorized for the box cannot show the pin.
 */
fun interface RelayProber {
    fun probe(address: InetAddress, sniHost: String, pinSha256: String): Boolean
}

class TlsPinRelayProber(private val timeoutMs: Int = 2_500) : RelayProber {
    override fun probe(address: InetAddress, sniHost: String, pinSha256: String): Boolean = try {
        val plain = java.net.Socket()
        plain.connect(java.net.InetSocketAddress(address, 443), timeoutMs)
        plain.soTimeout = timeoutMs
        val ssl = (javax.net.ssl.SSLSocketFactory.getDefault() as javax.net.ssl.SSLSocketFactory)
            .createSocket(plain, sniHost, 443, true) as javax.net.ssl.SSLSocket
        ssl.use {
            val params = it.sslParameters
            params.serverNames = listOf(javax.net.ssl.SNIHostName(sniHost))
            it.sslParameters = params
            it.startHandshake()
            val leaf = it.session.peerCertificates.firstOrNull()?.encoded
            leafDerSha256Hex(leaf)?.equals(pinSha256, ignoreCase = true) == true
        }
    } catch (_: Throwable) {
        false
    }
}

/**
 * Did [address] answer "which address did you reach me at" with itself? A forwarder in front
 * of the relay has to dial the relay's own address, so its answer names that one instead. The
 * answer is read over TLS with the relay's own public certificate, so a forwarder cannot write it.
 */
fun interface RelayEcho {
    fun reachedAt(address: InetAddress): InetAddress?
}

class TlsRelayEcho(private val timeoutMs: Int = 2_500) : RelayEcho {
    override fun reachedAt(address: InetAddress): InetAddress? = try {
        val plain = java.net.Socket()
        plain.connect(java.net.InetSocketAddress(address, PORT), timeoutMs)
        plain.soTimeout = timeoutMs
        val ssl = (javax.net.ssl.SSLSocketFactory.getDefault() as javax.net.ssl.SSLSocketFactory)
            .createSocket(plain, HOST, PORT, true) as javax.net.ssl.SSLSocket
        ssl.use {
            val params = it.sslParameters
            params.serverNames = listOf(javax.net.ssl.SNIHostName(HOST))
            params.endpointIdentificationAlgorithm = "HTTPS"
            it.sslParameters = params
            it.startHandshake()
            it.outputStream.write("GET /echo HTTP/1.1\r\nHost: $HOST\r\nConnection: close\r\n\r\n".toByteArray())
            it.outputStream.flush()
            val raw = it.inputStream.readNBytes(MAX_REPLY).toString(Charsets.UTF_8)
            RelayAddressRules.parseEchoReply(raw)
        }
    } catch (_: Throwable) {
        null
    }

    companion object {
        const val HOST = "flagship-services.fly.dev"
        const val PORT = 8444
        private const val MAX_REPLY = 4096
    }
}

class RelayAddressCenter(
    private val backend: NoticeStoreBackend,
    private val fetcher: () -> NoticeFetcher,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val prober: RelayProber = TlsPinRelayProber(),
    private val echo: RelayEcho = TlsRelayEcho(),
    /** A box name and its pin to test addresses with, or null when no box is known yet. */
    private val pinTarget: () -> Pair<String, String>? = { CertPinRegistry.shared.anyPin() },
) {
    private val lock = Mutex()
    private val tested = java.util.concurrent.ConcurrentHashMap<InetAddress, Pair<Boolean, Long>>()

    /**
     * The recommended addresses (then [seed]) that pass the test right now, best first.
     * An address `.com` recommended that is not in [seed] must also answer the relay echo with
     * itself (it is the relay, not a forwarder in front of it); the compiled-in seed needs the
     * box's pinned handshake only. Empty when no box is known to test with or none pass; the
     * caller then goes on to DNS's label and the rest. Results are kept for [GOOD_MS] (passed)
     * or [BAD_MS] (failed).
     */
    fun proven(seed: List<InetAddress>): List<InetAddress> {
        val target = pinTarget() ?: return emptyList()
        val candidates = (stored() + seed).distinct()
        val now = clock()
        val stale = candidates.filter { a -> tested[a]?.let { (ok, at) -> now - at >= if (ok) GOOD_MS else BAD_MS } ?: true }
        val threads = stale.map { a ->
            Thread { tested[a] = (prober.probe(a, target.first, target.second) && (a in seed || echo.reachedAt(a) == a)) to clock() }.also { it.isDaemon = true; it.start() }
        }
        threads.forEach { it.join(PROBE_WAIT_MS) }
        return candidates.filter { tested[it]?.first == true }
    }

    @Volatile private var lastFetchAt = 0L

    /** The last good answer, or empty (a corrupt store is an empty one). */
    fun stored(): List<InetAddress> = try {
        val o = SecurityNoticeProtocol.json.parseToJsonElement(backend.read() ?: "") as JsonObject
        (o["addresses"] as JsonArray).mapNotNull { (it as? JsonPrimitive)?.content?.let(RelayAddressRules::parse) }.distinct()
    } catch (_: Throwable) {
        emptyList()
    }

    /**
     * What to try when DNS fails and nothing could be tested: the compiled-in [seed] only. An
     * address `.com` recommended is used only once it has passed the test, never untested.
     */
    @Suppress("UNUSED_PARAMETER")
    fun addresses(seed: List<InetAddress>): List<InetAddress> = seed

    /** One anonymous GET; a usable answer replaces the stored one, anything else leaves it. Never throws. */
    suspend fun refresh(): Boolean = try {
        lock.withLock {
            lastFetchAt = clock()
            val body = (fetcher().fetch() as? NoticeFetch.Document)?.body
            val found = body?.let(RelayAddressRules::fromEndpoints).orEmpty()
            if (found.isEmpty()) {
                false
            } else {
                backend.write(buildJsonObject {
                    put("addresses", JsonArray(found.map { JsonPrimitive(it.hostAddress ?: "") }))
                    put("at", clock())
                }.toString())
                true
            }
        }
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Throwable) {
        false
    }

    /** Fetch shortly after launch and then about daily; it waits a little so it never competes with start-up. */
    fun start() {
        if (clock() - lastFetchAt < POLL_INTERVAL_MS) return
        lastFetchAt = clock()
        scope.launch {
            delay(START_DELAY_MS)
            refresh()
        }
    }

    companion object {
        const val PATH = "/api/services/endpoints"
        const val POLL_INTERVAL_MS = 24L * 3600_000
        const val GOOD_MS = 10L * 60_000
        const val BAD_MS = 2L * 60_000
        private const val PROBE_WAIT_MS = 3_000L
        private const val START_DELAY_MS = 20_000L

        @Volatile var shared: RelayAddressCenter? = null
            private set

        @Synchronized
        fun install(context: Context): RelayAddressCenter {
            shared?.let { return it }
            val c = RelayAddressCenter(
                backend = PrefsRelayAddressBackend(context),
                fetcher = { AnonymousNoticeFetcher(path = PATH) },
                clock = { Variant.noticeNowMs() },
            )
            shared = c
            return c
        }

        /** The addresses for [apex] that were tested against a known box just now (prod apex only). */
        fun provenFor(apex: String): List<InetAddress> {
            if (apex != Endpoints.PROD_DATA_APEX) return emptyList()
            return runCatching { (shared ?: return emptyList()).proven(RelayAddresses.prod) }.getOrDefault(emptyList())
        }

        /** The addresses for [apex] when DNS has failed and none could be tested: the compiled-in seed (prod apex only). */
        fun addressesFor(apex: String): List<InetAddress> {
            if (apex != Endpoints.PROD_DATA_APEX) return emptyList()
            return shared?.addresses(RelayAddresses.prod) ?: RelayAddresses.prod
        }
    }
}

class PrefsRelayAddressBackend(context: Context) : NoticeStoreBackend {
    private val prefs = context.applicationContext.getSharedPreferences("flagship-relay-addresses", Context.MODE_PRIVATE)
    override fun read(): String? = runCatching { prefs.getString(KEY, null) }.getOrNull()
    override fun write(value: String) {
        runCatching { prefs.edit().putString(KEY, value).commit() }
    }

    private companion object {
        const val KEY = "store.v1"
    }
}
