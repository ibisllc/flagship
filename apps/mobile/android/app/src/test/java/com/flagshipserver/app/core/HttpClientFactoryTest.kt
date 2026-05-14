// Pin the cert-pinning policy: flagshipserver.com is pinned, per-user
// pod hostnames are intentionally NOT pinned (their LE certs rotate
// every ~60d so pinning would break failover + lineage breaks).
//
// CertificatePinner.findMatchingPins(hostname) returns the (possibly
// empty) list of pins configured for that hostname. We use that to
// answer "is this hostname pinned?" without needing real certificates.

package com.flagshipserver.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpClientFactoryTest {

    @Test fun flagshipserverComHasExactlyTwoPins() {
        // Two pins: the Cloudflare ECC CA-3 intermediate + the RSA
        // CA-2 fallback. Keeping the assertion on the count guards
        // against an accidental drop during a future rotation.
        val client = HttpClientFactory.build()
        val pins = client.certificatePinner.findMatchingPins("flagshipserver.com")
        assertEquals(2, pins.size)
        // Both pins serialize back to the sha256/<base64> form used in
        // the source code's CertificatePinner.Builder.add(...) calls.
        assertTrue(pins.all { it.toString().startsWith("sha256/") })
    }

    @Test fun perUserPodHostnamesAreNotPinned() {
        // The whole point of NOT pinning user pods is that their
        // Let's Encrypt certs rotate every ~60 days and pinning would
        // break the user's failover the moment a renewal happens.
        val client = HttpClientFactory.build()
        assertTrue(client.certificatePinner.findMatchingPins("home.harry.flagship.services").isEmpty())
        assertTrue(client.certificatePinner.findMatchingPins("office.alice.flagship.services").isEmpty())
        // .services apex itself is also not pinned (it's the Fly app,
        // not the user's pod).
        assertTrue(client.certificatePinner.findMatchingPins("flagship.services").isEmpty())
    }

    @Test fun wwwSubdomainOfFlagshipserverIsNotPinned() {
        // Pinning is keyed by exact hostname; www isn't apex. If we
        // ever want to add it, this test will need an explicit pin.
        val client = HttpClientFactory.build()
        assertTrue(client.certificatePinner.findMatchingPins("www.flagshipserver.com").isEmpty())
    }

    @Test fun timeoutsAreReasonable() {
        // Smoke-check the connection envelope so a future refactor
        // can't silently bump connectTimeout to 5 minutes.
        val client = HttpClientFactory.build()
        assertTrue("connect timeout should be ≤30s", client.connectTimeoutMillis <= 30_000)
        assertTrue("read timeout should be ≤120s",  client.readTimeoutMillis    <= 120_000)
        assertTrue("write timeout should be ≤120s", client.writeTimeoutMillis   <= 120_000)
    }

    @Test fun pinnerIsNotTheNoOpDefault() {
        // CertificatePinner.DEFAULT pins nothing; we explicitly build a
        // configured one. Assert we didn't accidentally ship the
        // default during a refactor.
        val client = HttpClientFactory.build()
        assertNotEquals(okhttp3.CertificatePinner.DEFAULT, client.certificatePinner)
    }
}
