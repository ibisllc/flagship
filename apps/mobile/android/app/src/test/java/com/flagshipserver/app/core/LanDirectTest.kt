package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

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

    private fun registry(prober: LanProber) = LanDirectRegistry(prober) { now }

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
}
