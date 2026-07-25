// Pin the cert-pinning POLICY (owner decision 2026-07-25):
//  - The control apex (flagshipserver.com) is NOT statically cert-pinned. It
//    is fronted by a third-party edge (Cloudflare) that rotates certs and even
//    swaps CAs, so a static SPKI pin is fragile and once hard-failed every
//    request. Standard system CA trust applies — like any normal app. The only
//    thing the system pins is the maintainer authority from our own ceremonies
//    (MAINTAINER_PINNED_MANDATE_HASH → MaintainersTrust), which is transport-
//    independent.
//  - Box hostnames (<server>.<user>.flagship.services) are NOT statically
//    pinned either, but DO get DYNAMIC whole-cert pins via the STK-signed
//    daemon-status fingerprint (CertPinRegistry) — enforced on both seams: the
//    hostname verifier (every TLS handshake, WebSockets included) and the
//    network interceptor (per request on pooled connections).
//
// CertificatePinner.findMatchingPins(hostname) returns the (possibly empty)
// list of STATIC pins configured for that hostname — we use it to assert that
// nothing is statically pinned anymore.

package com.flagshipserver.app.core

import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpClientFactoryTest {

    @After fun reset() = Endpoints.setOverride(null) // never leak a gym override

    @Test fun controlApexIsNotStaticallyPinned() {
        // The whole point of the 2026-07-25 change: flagshipserver.com uses
        // standard system CA validation, NOT a static SPKI pin (which broke on
        // the Cloudflare→Google-Trust-Services edge-cert migration).
        val client = HttpClientFactory.build()
        assertTrue(client.certificatePinner.findMatchingPins("flagshipserver.com").isEmpty())
        assertTrue(client.certificatePinner.findMatchingPins("www.flagshipserver.com").isEmpty())
    }

    @Test fun boxHostnamesAreNotStaticallyPinned() {
        // Box hostnames must stay out of any STATIC pinner: their LE certs
        // rotate every ~60 days, so a static pin would break the box on
        // renewal. They are pinned DYNAMICALLY via CertPinRegistry, which
        // re-pins from each fresh STK-signed daemon-status report.
        val client = HttpClientFactory.build()
        assertTrue(client.certificatePinner.findMatchingPins("home.harry.flagship.services").isEmpty())
        assertTrue(client.certificatePinner.findMatchingPins("office.alice.flagship.services").isEmpty())
        // .services apex itself is also not pinned (it's the Fly app, not a pod).
        assertTrue(client.certificatePinner.findMatchingPins("flagship.services").isEmpty())
    }

    @Test fun boxCertPinSeamsAreBothWired() {
        // A′ phase 4 — the dynamic box pin must ride BOTH seams: the hostname
        // verifier is the only one OkHttp runs for WebSocket upgrades; the
        // interceptor is the only one that re-checks a pooled connection after
        // a pin lands. (This layer is KEPT — it pins the box's OWN, phone-
        // verified, self-healing cert, not a third-party edge cert.)
        val client = HttpClientFactory.build()
        assertTrue(client.hostnameVerifier is CertPinHostnameVerifier)
        assertTrue(client.networkInterceptors.any { it is CertPinInterceptor })
    }

    @Test fun timeoutsAreReasonable() {
        // Smoke-check the connection envelope so a future refactor can't
        // silently bump connectTimeout to 5 minutes.
        val client = HttpClientFactory.build()
        assertTrue("connect timeout should be ≤30s", client.connectTimeoutMillis <= 30_000)
        assertTrue("read timeout should be ≤120s",  client.readTimeoutMillis    <= 120_000)
        assertTrue("write timeout should be ≤120s", client.writeTimeoutMillis   <= 120_000)
    }
}
