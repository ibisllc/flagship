package com.flagshipserver.app.core

import okhttp3.Call
import okhttp3.Connection
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

// A box name the phone's resolver can't find (a home router's cached "no such
// name" from before the box registered its DNS) is reached through the relay,
// and a failed lookup is tried again: never "Couldn't reach the server" for a
// server that is online.
class RelayFallbackTest {
    private val apex = "flagship.services"
    private val box = "home.alice.flagship.services"
    private val relayAddr = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 7))

    /** The phone's resolver after a negative-cached lookup: the box's name is unknown, the apex is not. */
    private class Resolver(private val known: Map<String, List<InetAddress>>) : Dns {
        val asked = mutableListOf<String>()
        override fun lookup(hostname: String): List<InetAddress> {
            asked += hostname
            return known[hostname] ?: throw UnknownHostException("Unable to resolve host \"$hostname\": No address associated with hostname")
        }
    }

    private fun dns(resolver: Dns) = RelayFallbackDns(resolver, { apex }, { })

    @Test fun anUnknownBoxNameUsesTheRelaysAddresses() {
        val resolver = Resolver(mapOf(apex to listOf(relayAddr)))
        assertEquals(listOf(relayAddr), dns(resolver).lookup(box))
        assertEquals(listOf(box, apex), resolver.asked)
    }

    @Test fun aNameThatResolvesIsLeftAlone() {
        val own = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 9))
        val resolver = Resolver(mapOf(box to listOf(own), apex to listOf(relayAddr)))
        assertEquals(listOf(own), dns(resolver).lookup(box))
        assertEquals(listOf(box), resolver.asked)
    }

    @Test fun aNameOutsideTheDataApexStaysUnknown() {
        val resolver = Resolver(mapOf(apex to listOf(relayAddr)))
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup("example.invalid") }
        // Only the data apex's own boxes may fall back; a lookalike suffix may not.
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup("home.alice.notflagship.services") }
        assertEquals(listOf("example.invalid", "home.alice.notflagship.services"), resolver.asked)
    }

    @Test fun whenTheRelayIsUnknownTooTheOriginalFailureStands() {
        val resolver = Resolver(emptyMap())
        val e = assertThrows(UnknownHostException::class.java) { dns(resolver).lookup(box) }
        assertEquals(true, e.message?.contains(box))
    }

    @Test fun theApexItselfIsNotRetriedThroughItself() {
        val resolver = Resolver(emptyMap())
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup(apex) }
        assertEquals(listOf(apex), resolver.asked)
    }

    private class Chain(private val request: Request, private val failures: Int) : Interceptor.Chain {
        var proceeds = 0
        override fun request() = request
        override fun proceed(request: Request): Response {
            proceeds++
            if (proceeds <= failures) throw UnknownHostException("Unable to resolve host")
            return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").build()
        }
        override fun connection(): Connection? = null
        override fun call(): Call = throw UnsupportedOperationException()
        override fun connectTimeoutMillis() = 0
        override fun withConnectTimeout(timeout: Int, unit: TimeUnit) = this
        override fun readTimeoutMillis() = 0
        override fun withReadTimeout(timeout: Int, unit: TimeUnit) = this
        override fun writeTimeoutMillis() = 0
        override fun withWriteTimeout(timeout: Int, unit: TimeUnit) = this
    }

    private val req = Request.Builder().url("https://$box/api/screens/apps").build()

    @Test fun aFailedLookupIsTriedAgainWithABackoff() {
        val pauses = mutableListOf<Long>()
        val chain = Chain(req, failures = 2)
        val out = DnsRetryInterceptor(listOf(400, 1_200), { pauses += it }).intercept(chain)
        assertEquals(200, out.code)
        assertEquals(3, chain.proceeds)
        assertEquals(listOf(400L, 1_200L), pauses)
    }

    @Test fun aLookupThatKeepsFailingGivesUpAfterTheBackoffs() {
        val chain = Chain(req, failures = 10)
        assertThrows(UnknownHostException::class.java) { DnsRetryInterceptor(listOf(1, 1), { }).intercept(chain) }
        assertEquals(3, chain.proceeds)
    }

    @Test fun otherFailuresAreNotRetriedHere() {
        val chain = object : Interceptor.Chain by Chain(req, 0) {
            var n = 0
            override fun proceed(request: Request): Response { n++; throw java.io.IOException("reset") }
        }
        assertThrows(java.io.IOException::class.java) { DnsRetryInterceptor(listOf(1, 1), { }).intercept(chain) }
        assertEquals(1, chain.n)
    }
}
