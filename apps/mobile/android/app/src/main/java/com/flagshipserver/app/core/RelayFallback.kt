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
//    addresses of the apex itself, the same relay that carries every box's
//    :443 traffic by SNI passthrough. The URL host stays the box's name, so SNI,
//    hostname verification and the box's cert pin all still run against it; if
//    the relay answers for a box that isn't there, the handshake fails like any
//    wrong box would.
//  - DnsRetryInterceptor: a lookup failure happens before anything is sent, so
//    any request may be sent again; it is, after a short pause, twice.

package com.flagshipserver.app.core

import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Response
import java.net.InetAddress
import java.net.UnknownHostException

class RelayFallbackDns(
    private val delegate: Dns,
    /** The relay's own name: the data apex, which resolves on its own. */
    private val relayHost: () -> String = { Endpoints.dataApex },
    private val log: (String) -> Unit = { m -> runCatching { android.util.Log.i("RelayFallback", m) } },
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        try {
            return delegate.lookup(hostname)
        } catch (e: UnknownHostException) {
            val relay = relayHost().lowercase()
            if (!hostname.lowercase().endsWith(".$relay")) throw e
            val addresses = try {
                delegate.lookup(relay)
            } catch (_: UnknownHostException) {
                throw e
            }
            if (addresses.isEmpty()) throw e
            log("$hostname didn't resolve; reaching it through the relay at $relay")
            return addresses
        }
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
