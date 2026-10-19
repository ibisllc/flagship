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
    private val label = "relay-fallback.flagship.services"
    private val box = "home.alice.flagship.services"
    private val relayAddr = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 7))
    private val cloudflare = InetAddress.getByAddress(byteArrayOf(172.toByte(), 67, 185.toByte(), 244.toByte()))
    private val baked = InetAddress.getByAddress(byteArrayOf(10, 9, 9, 9))

    /** The phone's resolver after a negative-cached lookup: the box's name is unknown, the label is not. */
    private class Resolver(private val known: Map<String, List<InetAddress>>) : Dns {
        val asked = mutableListOf<String>()
        override fun lookup(hostname: String): List<InetAddress> {
            asked += hostname
            return known[hostname] ?: throw UnknownHostException("Unable to resolve host \"$hostname\": No address associated with hostname")
        }
    }

    private fun dns(resolver: Dns) = RelayFallbackDns(resolver, { apex }, { }, { listOf(baked) })

    @Test fun anUnknownBoxNameUsesTheRelayFallbackLabel() {
        val resolver = Resolver(mapOf(label to listOf(relayAddr), apex to listOf(cloudflare)))
        assertEquals(listOf(relayAddr), dns(resolver).lookup(box))
        assertEquals(listOf(box, label), resolver.asked)
    }

    @Test fun whenTheLabelIsUnknownTooTheBuiltInRelayAddressesAreUsed() {
        val resolver = Resolver(mapOf(apex to listOf(cloudflare)))
        assertEquals(listOf(baked), dns(resolver).lookup(box))
        assertEquals(listOf(box, label), resolver.asked)
    }

    @Test fun theApexAndItsCloudflareAddressesAreNeverUsed() {
        val resolver = Resolver(mapOf(apex to listOf(cloudflare)))
        assertEquals(false, dns(resolver).lookup(box).contains(cloudflare))
        assertEquals(false, resolver.asked.contains(apex))
        // With nothing to fall back to, the original failure stands rather than the apex.
        val none = RelayFallbackDns(resolver, { apex }, { }, { emptyList() })
        assertThrows(UnknownHostException::class.java) { none.lookup(box) }
        assertEquals(false, resolver.asked.contains(apex))
    }

    @Test fun aNameThatResolvesIsLeftAlone() {
        val own = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 9))
        val resolver = Resolver(mapOf(box to listOf(own), label to listOf(relayAddr)))
        assertEquals(listOf(own), dns(resolver).lookup(box))
        assertEquals(listOf(box), resolver.asked)
    }

    @Test fun aNameOutsideTheDataApexStaysUnknown() {
        val resolver = Resolver(mapOf(label to listOf(relayAddr)))
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup("example.invalid") }
        // Only the data apex's own boxes may fall back; a lookalike suffix may not.
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup("home.alice.notflagship.services") }
        assertEquals(listOf("example.invalid", "home.alice.notflagship.services"), resolver.asked)
    }

    @Test fun theApexAndTheLabelAreNotRetriedThroughThemselves() {
        val resolver = Resolver(emptyMap())
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup(apex) }
        assertThrows(UnknownHostException::class.java) { dns(resolver).lookup(label) }
        assertEquals(listOf(apex, label), resolver.asked)
    }

    @Test fun theDefaultLastResortIsTheProdRelayOnlyOnTheProdApex() {
        assertEquals(
            listOf(InetAddress.getByName("149.248.216.86"), InetAddress.getByName("2a09:8280:1::110:d2b6:0")),
            RelayAddresses.prod,
        )
        val prod = RelayFallbackDns(Resolver(emptyMap()), { apex }, { })
        assertEquals(RelayAddresses.prod, prod.lookup(box))
        val gym = RelayFallbackDns(Resolver(emptyMap()), { "gym.flagship.services" }, { })
        assertThrows(UnknownHostException::class.java) { gym.lookup("home.alice.gym.flagship.services") }
    }

    // The whole OkHttp path: the box's name doesn't resolve, the relay answers
    // under it, and the request still names the box (Host header, and so SNI and
    // the pin on https) rather than the relay.
    @Test fun aRealRequestReachesTheRelayAndStillNamesTheBox() {
        val relay = okhttp3.mockwebserver.MockWebServer()
        relay.enqueue(okhttp3.mockwebserver.MockResponse().setBody("ok"))
        relay.start()
        try {
            val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
            val resolver = Resolver(mapOf(label to listOf(loopback), apex to listOf(cloudflare)))
            val client = okhttp3.OkHttpClient.Builder().dns(dns(resolver)).build()
            client.newCall(Request.Builder().url("http://$box:${relay.port}/api/screens/apps").build()).execute().use {
                assertEquals(200, it.code)
            }
            assertEquals("$box:${relay.port}", relay.takeRequest().getHeader("Host"))
            assertEquals(false, resolver.asked.contains(apex))
        } finally {
            relay.shutdown()
        }
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

    // The relay addresses are a hint. A hint that fails, for any reason, must not
    // read as a problem with the box; a name DNS answered keeps its real errors.
    private class Failing(private val request: Request, private val error: java.io.IOException) : Interceptor.Chain by Chain(request, 0) {
        override fun request() = request
        override fun proceed(request: Request): Response = throw error
    }

    private fun hintDns(): RelayFallbackDns {
        val d = dns(Resolver(mapOf(label to listOf(relayAddr))))
        d.lookup(box)
        return d
    }

    @Test fun aFailedHintReadsAsAnUnresolvedName() {
        val failures = listOf(
            javax.net.ssl.SSLHandshakeException("connection closed"),
            javax.net.ssl.SSLPeerUnverifiedException("Certificate for $box does not match the server's STK-signed fingerprint"),
            java.net.ConnectException("refused"),
            java.net.SocketTimeoutException("timeout"),
        )
        for (f in failures) {
            val err = assertThrows(UnknownHostException::class.java) {
                RelayHintFailureInterceptor(hintDns(), { }).intercept(Failing(req, f))
            }
            assertEquals(f, err.cause)
        }
    }

    @Test fun aNameDnsAnsweredKeepsItsRealErrors() {
        val own = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 9))
        val d = dns(Resolver(mapOf(box to listOf(own))))
        d.lookup(box)
        val pin = javax.net.ssl.SSLPeerUnverifiedException("pin")
        val thrown = assertThrows(javax.net.ssl.SSLPeerUnverifiedException::class.java) {
            RelayHintFailureInterceptor(d, { }).intercept(Failing(req, pin))
        }
        assertEquals(pin, thrown)
    }

    @Test fun aHintStopsCountingOnceDnsAnswersAgain() {
        val resolver = object : Dns {
            var up = false
            override fun lookup(hostname: String): List<InetAddress> = when {
                up && hostname == box -> listOf(relayAddr)
                hostname == label -> listOf(relayAddr)
                else -> throw UnknownHostException(hostname)
            }
        }
        val d = RelayFallbackDns(resolver, { apex }, { }, { emptyList() })
        d.lookup(box)
        assertEquals(true, d.servedByHint(box))
        resolver.up = true
        d.lookup(box)
        assertEquals(false, d.servedByHint(box))
    }

    @Test fun aHintMarkExpires() {
        val d = hintDns()
        assertEquals(true, d.servedByHint(box))
        assertEquals(false, d.servedByHint(box, System.currentTimeMillis() + RelayFallbackDns.HINT_MARK_MS + 1))
    }

    @Test fun aSuccessfulRequestPassesThroughUntouched() {
        val out = RelayHintFailureInterceptor(hintDns(), { }).intercept(Chain(req, 0))
        assertEquals(200, out.code)
    }
}
