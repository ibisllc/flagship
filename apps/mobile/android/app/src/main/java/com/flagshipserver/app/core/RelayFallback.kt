// A box's name that won't resolve is not a box that is down.
//
// The box-direct calls go to <server>.<user>.flagship.services, whose DNS
// records appear when the box registers. A resolver that looked the name up
// BEFORE that (a home router's negative cache keeps the "no such name" answer
// for the zone's SOA minimum, 30 minutes) answers UnknownHostException while
// the box is online and `.com` says so. That must never read as "Couldn't
// reach the server".
//
// Two layers, both transparent to the callers:
//  - RelayFallbackDns: when a name under the data apex doesn't resolve, use the
//    relay's addresses. The apex itself is NEVER the source: `flagship.services`
//    is Cloudflare-proxied, so its addresses are Cloudflare's edge, not the
//    relay. The relay comes from (1) `relay-fallback.<apex>`, which the root
//    wildcard `*.<apex>` (A/AAAA = the relay, DNS only) answers with the relay,
//    then (2) a compiled-in list of the relay's anycast addresses (prod apex
//    only; RelayAddresses). The URL host stays the box's name, so SNI, hostname
//    verification and the box's cert pin all still run against it; a wrong
//    address can only fail the handshake like any wrong box would, never reach
//    the wrong server undetected.
//  - DnsRetryInterceptor: a lookup failure happens before anything is sent, so
//    any request may be sent again; it is, after a short pause, twice.

package com.flagshipserver.app.core

import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap

/**
 * The relay's anycast addresses (Fly dedicated pair, the same values as
 * SERVICES_PASSTHROUGH_IPV4/IPV6 in apps/com/wrangler.toml and the root
 * wildcard in docs/wildcard-dns.md). The last resort of RelayFallbackDns, for
 * the prod apex only. If Fly ever re-addresses the relay, change these in a
 * release and publish a security notice (docs/security-notices.md) telling
 * people to update; the `relay-fallback` DNS name follows the zone's wildcard, so
 * a re-addressing reaches every phone without a release, and a stale constant
 * only fails closed (TLS runs against the
 * box's own name).
 */
object RelayAddresses {
    val prod: List<InetAddress> = listOf(
        InetAddress.getByAddress(byteArrayOf(149.toByte(), 248.toByte(), 216.toByte(), 86)),
        InetAddress.getByName("2a09:8280:1::110:d2b6:0"),
    )
}

class RelayFallbackDns(
    private val delegate: Dns,
    /** The data apex whose boxes may fall back. Never looked up itself. */
    private val apex: () -> String = { Endpoints.dataApex },
    private val log: (String) -> Unit = { m -> runCatching { android.util.Log.i("RelayFallback", m) } },
    /** Last resort when `relay-fallback.<apex>` doesn't resolve either. */
    private val lastResort: (String) -> List<InetAddress> = RelayAddressCenter.Companion::addressesFor,
    /** The addresses `.com` recommends that a test just showed to be the relay answering for a box: tried before DNS's label. */
    private val proven: (String) -> List<InetAddress> = RelayAddressCenter.Companion::provenFor,
) : Dns {
    private val viaHint = ConcurrentHashMap<String, Long>()

    /** True while [hostname] was last answered with relay addresses (a hint), not by DNS. */
    fun servedByHint(hostname: String, now: Long = System.currentTimeMillis()): Boolean {
        val at = viaHint[hostname.lowercase()] ?: return false
        return now - at < HINT_MARK_MS
    }

    override fun lookup(hostname: String): List<InetAddress> {
        try {
            return delegate.lookup(hostname).also { viaHint.remove(hostname.lowercase()) }
        } catch (e: UnknownHostException) {
            val base = apex().lowercase()
            val name = hostname.lowercase()
            val label = "$LABEL.$base"
            if (!name.endsWith(".$base") || name == label) throw e
            val tested = proven(base)
            val resolved = if (tested.isNotEmpty()) tested else try {
                delegate.lookup(label)
            } catch (_: UnknownHostException) {
                emptyList()
            }
            val addresses = resolved.ifEmpty { lastResort(base) }
            if (addresses.isEmpty()) throw e
            log("$hostname didn't resolve; reaching it through the relay (${if (tested.isNotEmpty()) "addresses .com recommended, tested" else if (resolved.isEmpty()) "built-in addresses" else label})")
            viaHint[name] = System.currentTimeMillis()
            return addresses
        }
    }

    companion object {
        /** Answered by the zone's root wildcard, so it is the relay. */
        const val LABEL = "relay-fallback"

        /** How long a name stays marked as served by a hint. */
        const val HINT_MARK_MS = 60_000L
    }
}

class DnsRetryInterceptor(
    /** Pauses before the 2nd and 3rd try. */
    private val backoffMs: List<Long> = listOf(400L, 1_200L),
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var attempt = 0
        while (true) {
            try {
                return chain.proceed(chain.request())
            } catch (e: UnknownHostException) {
                if (attempt >= backoffMs.size) throw e
                sleep(backoffMs[attempt])
                attempt++
            }
        }
    }
}

/**
 * The relay addresses are only a hint. When DNS has failed and the hint is used,
 * a connection that then fails, whatever the reason (a stale address, a host
 * that is not the box, a refused handshake, a pin that does not match), says
 * nothing about the box. It reads as what it was before the hint, "that name
 * didn't resolve", never as a TLS or trust error. A host that DNS answered is
 * never touched here, so a real pin or certificate failure still surfaces.
 */
class RelayHintFailureInterceptor(
    private val dns: RelayFallbackDns,
    private val log: (String) -> Unit = { m -> runCatching { android.util.Log.i("RelayFallback", m) } },
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val host = chain.request().url.host
        try {
            return chain.proceed(chain.request())
        } catch (e: UnknownHostException) {
            throw e
        } catch (e: IOException) {
            if (!dns.servedByHint(host)) throw e
            log("the relay hint for $host didn't work (${e.javaClass.simpleName}); treating the name as unresolved")
            throw UnknownHostException("Unable to resolve host \"$host\"").also { it.initCause(e) }
        }
    }
}
