// Pin the cert-pinning policy: flagshipserver.com gets STATIC SPKI pins;
// box hostnames are intentionally NOT statically pinned (their LE certs
// rotate every ~60d) — they get DYNAMIC whole-cert pins instead, via the
// STK-signed daemon-status fingerprint (CertPinRegistry), enforced on both
// seams: the hostname verifier (every TLS handshake, WebSockets included)
// and the network interceptor (per request on pooled connections).
//
// CertificatePinner.findMatchingPins(hostname) returns the (possibly
// empty) list of pins configured for that hostname. We use that to
// answer "is this hostname pinned?" without needing real certificates.

package com.flagshipserver.app.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpClientFactoryTest {

    @After fun reset() = Endpoints.setOverride(null) // never leak a gym override

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

    @Test fun boxCertPinSeamsAreBothWired() {
        // A′ phase 4 — the dynamic box pin must ride BOTH seams: the
        // hostname verifier is the only one OkHttp runs for WebSocket
        // upgrades; the interceptor is the only one that re-checks a
        // pooled connection after a pin lands.
        val client = HttpClientFactory.build()
        assertTrue(client.hostnameVerifier is CertPinHostnameVerifier)
        assertTrue(client.networkInterceptors.any { it is CertPinInterceptor })
    }

    @Test fun perUserPodHostnamesAreNotStaticallyPinned() {
        // Box hostnames must stay out of the STATIC pinner: their LE
        // certs rotate every ~60 days, so the static pin would break the
        // box on renewal. They are pinned DYNAMICALLY via CertPinRegistry,
        // which re-pins from each fresh STK-signed daemon-status report.
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

    @Test fun gymApexSkipsTheProdSpkiPins() {
        // G2 — a gym test build points Endpoints at a non-prod apex served
        // behind a different LE chain; the prod Cloudflare-intermediate pins
        // would HARD-FAIL TLS there, so the pinner must NOT pin the gym apex.
        // (Box hostnames still get dynamic pins via the registry — unaffected.)
        Endpoints.setOverride(controlHost = "gym.flagshipserver.com")
        val client = HttpClientFactory.build()
        assertTrue(client.certificatePinner.findMatchingPins("gym.flagshipserver.com").isEmpty())
        // And the prod apex isn't pinned either while overridden (it's not the
        // configured host) — no stray prod pin leaks into a gym build.
        assertTrue(client.certificatePinner.findMatchingPins("flagshipserver.com").isEmpty())
    }
}
