package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import okhttp3.Call
import okhttp3.Connection
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLPeerUnverifiedException

class LanDirectTest {
    private val box = "home.alice.flagship.services"
    private val umk = ByteArray(32) { 3 }
    private val stkPub = ServerKeys.deriveStkPub(umk, box)
    private val signer = Ed25519Sign(ServerKeys.deriveStkSeed(umk, box))
    private val pin = "cd".repeat(32)
    private var now = 1_000_000L

    private fun envelope(vararg eps: LanHint.Endpoint, expires: Long = now + 3_600_000): LanHint.Envelope {
        val h = LanHint.Hint(box, pin, eps.toList(), now, expires)
        return LanHint.Envelope(h, HexUtil.encode(signer.sign(LanHint.canonical(h))))
    }

    private class FakeProber(var reachable: Set<String>) : LanProber {
        var calls = 0
        override fun probe(sniHost: String, address: String, port: Int, certSha256: String): Boolean {
            calls++
            return address in reachable
        }
    }

    private val logs = mutableListOf<String>()
    private fun registry(prober: LanProber) = LanDirectRegistry(prober, { now }, { it() }, { logs += it })

    @Test fun noHintMeansNoLanRoute() {
        assertNull(registry(FakeProber(setOf("192.168.1.20"))).lanAddressFor(box))
    }

    @Test fun aRefusedHintIsNotStored() {
        val r = registry(FakeProber(setOf("192.168.1.20")))
        val bad = envelope(LanHint.Endpoint("192.168.1.20", 443)).let { it.copy(hint = it.hint.copy(issuedAt = now + 1)) }
        assertEquals("bad-signature", r.accept(box, bad, stkPub, pin))
        assertNull(r.lanAddressFor(box))
    }

    @Test fun routesOnlyAfterTheProbeProvesTheBoxIsThere() {
        val prober = FakeProber(emptySet())
        val r = registry(prober)
        assertNull(r.accept(box, envelope(LanHint.Endpoint("192.168.1.20", 443)), stkPub, pin))
        assertNull(r.lanAddressFor(box))
        prober.reachable = setOf("192.168.1.20")
        assertNull(r.lanAddressFor(box)) // the failed probe is cached for this network
        r.onNetworkChanged()
        assertEquals("192.168.1.20", r.lanAddressFor(box))
    }

    @Test fun servesTheBoxAndNamesUnderItButNothingElse() {
        val r = registry(FakeProber(setOf("10.0.0.7")))
        r.accept(box, envelope(LanHint.Endpoint("10.0.0.7", 443)), stkPub, pin)
        assertEquals("10.0.0.7", r.lanAddressFor("photos.$box"))
        assertNull(r.lanAddressFor("x$box"))
        assertNull(r.lanAddressFor("other.bob.flagship.services"))
    }

    @Test fun skipsEndpointsNotOn443AndProbesOncePerNetwork() {
        val prober = FakeProber(setOf("10.0.0.7", "10.0.0.8"))
        val r = registry(prober)
        r.accept(box, envelope(LanHint.Endpoint("10.0.0.8", 8443), LanHint.Endpoint("10.0.0.7", 443)), stkPub, pin)
        assertEquals("10.0.0.7", r.lanAddressFor(box))
        assertEquals("10.0.0.7", r.lanAddressFor(box))
        assertEquals(1, prober.calls)
    }

    @Test fun anExpiredHintIsDropped() {
        val r = registry(FakeProber(setOf("10.0.0.7")))
        r.accept(box, envelope(LanHint.Endpoint("10.0.0.7", 443), expires = now + 1000), stkPub, pin)
        now += 2000
        assertNull(r.lanAddressFor(box))
    }

    @Test fun dnsPutsTheLanAddressFirstAndKeepsTheRelayAsFallback() {
        val r = registry(FakeProber(setOf("192.168.1.20")))
        r.accept(box, envelope(LanHint.Endpoint("192.168.1.20", 443)), stkPub, pin)
        val relay = InetAddress.getByName("149.248.216.86")
        val dns = LanDirectDns(r, object : Dns { override fun lookup(hostname: String) = listOf(relay) })
        assertEquals(listOf(InetAddress.getByName("192.168.1.20"), relay), dns.lookup(box))
        assertEquals(listOf(relay), dns.lookup("example.com"))
    }

    @Test fun dnsStillReturnsTheLanAddressWhenInternetDnsIsDown() {
        val r = registry(FakeProber(setOf("192.168.1.20")))
        r.accept(box, envelope(LanHint.Endpoint("192.168.1.20", 443)), stkPub, pin)
        val dns = LanDirectDns(r, object : Dns { override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException(hostname) })
        assertEquals(listOf(InetAddress.getByName("192.168.1.20")), dns.lookup(box))
    }

    @Test fun aRequestNeverWaitsForAProbe() {
        val queued = mutableListOf<() -> Unit>()
        val prober = FakeProber(setOf("192.168.1.20"))
        val r = LanDirectRegistry(prober, { now }, { queued += it }, { logs += it })
        r.accept(box, envelope(LanHint.Endpoint("192.168.1.20", 443)), stkPub, pin)
        assertNull(r.lanAddressFor(box)) // this request takes the relay
        assertNull(r.lanAddressFor(box)) // one probe at a time
        assertEquals(1, queued.size)
        assertEquals(0, prober.calls)
        queued.removeAt(0)()
        assertEquals("192.168.1.20", r.lanAddressFor(box))
        assertTrue(logs.any { "proved itself" in it })
    }

    @Test fun aFailedProbeIsLoggedAndTheRelayStays() {
        val r = registry(FakeProber(emptySet()))
        r.accept(box, envelope(LanHint.Endpoint("192.168.1.20", 443)), stkPub, pin)
        assertNull(r.lanAddressFor(box))
        assertTrue(logs.any { "using the relay" in it })
    }

    @Test fun aFailedLanRequestStopsLanUseOnThisNetwork() {
        val r = registry(FakeProber(setOf("10.0.0.7")))
        r.accept(box, envelope(LanHint.Endpoint("10.0.0.7", 443)), stkPub, pin)
        assertEquals("10.0.0.7", r.lanAddressFor(box))
        r.markFailed("photos.$box", "SocketTimeoutException")
        assertNull(r.lanAddressFor(box))
        assertTrue(logs.any { "local route to photos.$box failed" in it })
        r.onNetworkChanged()
        assertEquals("10.0.0.7", r.lanAddressFor(box))
    }

    @Test fun aLanConnectFailureMatchesTheAddressHoweverItIsSpelled() {
        val r = registry(FakeProber(setOf("fd12:3456::7")))
        r.accept(box, envelope(LanHint.Endpoint("fd12:3456::7", 443)), stkPub, pin)
        assertEquals("fd12:3456::7", r.lanAddressFor(box))
        r.markAddressFailed(InetAddress.getByName("fd12:3456::7").hostAddress!!, "ConnectException")
        assertNull(r.provenAddressFor(box))
    }

    @Test fun onlyLanAddressesGetTheShortConnectTimeout() {
        assertEquals(1_500, LanAwareSocketFactory.connectTimeoutFor("192.168.1.20", 15_000))
        assertEquals(1_500, LanAwareSocketFactory.connectTimeoutFor("fd12:3456:0:0:0:0:0:7", 0))
        assertEquals(800, LanAwareSocketFactory.connectTimeoutFor("10.0.0.7", 800))
        assertEquals(15_000, LanAwareSocketFactory.connectTimeoutFor("149.248.216.86", 15_000))
    }

    /** A chain whose first proceed (the LAN route) fails with [first]. */
    private class FlakyChain(private val request: Request, private val first: IOException) : Interceptor.Chain {
        var proceeds = 0
        override fun request() = request
        override fun proceed(request: Request): Response {
            proceeds++
            if (proceeds == 1) throw first
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

    private fun provenRegistry() = registry(FakeProber(setOf("192.168.1.20"))).also {
        it.accept(box, envelope(LanHint.Endpoint("192.168.1.20", 443)), stkPub, pin)
        assertEquals("192.168.1.20", it.lanAddressFor(box))
    }
    private val read = Request.Builder().url("https://$box/api/screens/server-detail").build()
    private val change = Request.Builder().url("https://$box/api/screens/services/copy").post("{}".toRequestBody()).build()

    @Test fun aReadThatFailsOnTheLanIsSentAgainOverTheRelay() {
        val r = provenRegistry()
        val chain = FlakyChain(read, SocketTimeoutException("timeout"))
        assertEquals(200, LanDirectFallbackInterceptor(r).intercept(chain).code)
        assertEquals(2, chain.proceeds)
        assertNull(r.provenAddressFor(box))
    }

    @Test fun aChangeIsReplayedOnlyWhenTheBoxCannotHaveSeenIt() {
        val r = provenRegistry()
        // Another device answered at the address: TLS refused it before anything was sent.
        val refused = FlakyChain(change, SSLPeerUnverifiedException("Hostname $box not verified"))
        assertEquals(200, LanDirectFallbackInterceptor(r).intercept(refused).code)
        assertEquals(2, refused.proceeds)

        val r2 = provenRegistry()
        val lost = SocketTimeoutException("timeout")
        val midway = FlakyChain(change, lost)
        assertSame(lost, assertThrows(SocketTimeoutException::class.java) { LanDirectFallbackInterceptor(r2).intercept(midway) })
        assertEquals(1, midway.proceeds)
        assertNull(r2.provenAddressFor(box)) // the user's retry goes over the relay
    }

    @Test fun requestsNotRoutedToTheLanAreLeftAlone() {
        val r = registry(FakeProber(emptySet()))
        val chain = FlakyChain(read, SocketTimeoutException("timeout"))
        assertThrows(SocketTimeoutException::class.java) { LanDirectFallbackInterceptor(r).intercept(chain) }
        assertEquals(1, chain.proceeds)
    }
}
