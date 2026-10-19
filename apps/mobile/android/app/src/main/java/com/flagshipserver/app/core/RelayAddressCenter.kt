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
            is Inet4Address -> !((b[0].toInt() and 0xff) == 100 && (b[1].toInt() and 0xc0) == 0x40)
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

class RelayAddressCenter(
    private val backend: NoticeStoreBackend,
    private val fetcher: () -> NoticeFetcher,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Mutex()

    @Volatile private var lastFetchAt = 0L

    /** The last good answer, or empty (a corrupt store is an empty one). */
    fun stored(): List<InetAddress> = try {
        val o = SecurityNoticeProtocol.json.parseToJsonElement(backend.read() ?: "") as JsonObject
        (o["addresses"] as JsonArray).mapNotNull { (it as? JsonPrimitive)?.content?.let(RelayAddressRules::parse) }.distinct()
    } catch (_: Throwable) {
        emptyList()
    }

    /** What to try when DNS fails: what `.com` last recommended, then [seed]. Never throws. */
    fun addresses(seed: List<InetAddress>): List<InetAddress> = (stored() + seed).distinct()

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

        /** The addresses for [apex] when DNS has failed: what `.com` recommends, then the compiled-in seed (prod apex only). */
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
