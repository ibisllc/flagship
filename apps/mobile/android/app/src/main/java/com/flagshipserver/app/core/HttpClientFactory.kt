// Builds the shared OkHttp client used by Live{Screens,FlagshipServer,
// QrRelay,SecretMailbox}Client (and the browser-stream WebSocket, which
// upgrades through the same chain).
//
// Two pinning layers:
//  - STATIC SPKI pins for flagshipserver.com only (CertificatePinner below).
//  - DYNAMIC whole-cert pins for box hostnames (<server>.<user>.
//    flagship.services + anything under them), enforced by
//    CertPinInterceptor against CertPinRegistry — the pin is the box's OWN
//    STK-signed leaf-cert fingerprint relayed via /pods, so it tracks every
//    healthy renewal (each fresh daemon-status report re-pins) yet HARD-FAILS
//    a rogue cert minted by anyone else, .com included (cert-model A′,
//    phase 4). A box with no verified report has no pin and keeps default
//    Let's Encrypt validation.

package com.flagshipserver.app.core

import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object HttpClientFactory {
    /**
     * Pins are the public-key SHA-256 of Cloudflare's intermediate roots
     * (Cloudflare ECC CA-3 + the Lets Encrypt R3 fallback chain). The
     * Worker is served behind Cloudflare's full-strict TLS so leaf
     * rotation is fine as long as the intermediate is honored.
     *
     * If the user is doing local-dev against a staging Worker / mock
     * server, the pinner gracefully no-ops because the hostnames don't
     * match — only `flagshipserver.com` is in the pin set.
     *
     * Update procedure: run
     *   openssl s_client -connect flagshipserver.com:443 -servername flagshipserver.com -showcerts
     *   openssl pkey -in <intermediate.pem> -pubkey -noout |
     *     openssl pkey -pubin -outform DER |
     *     openssl dgst -sha256 -binary | base64
     * and add the resulting "sha256/…" line to the builder below.
     */
    /**
     * Static SPKI pins for the PROD control apex (`flagshipserver.com`) only.
     * A gym test build points [Endpoints] at a non-prod apex
     * (gym.flagshipserver.com) served behind a different LE chain — these
     * Cloudflare-intermediate pins would HARD-FAIL TLS there — so the pinner
     * is built against the CONFIGURED control host and is EMPTY (a no-op)
     * unless that host is the prod apex. Prod is byte-identical: with no
     * override the host is `flagshipserver.com`, so both pins apply exactly as
     * before. (The dynamic box-cert interceptor below is unaffected — it is
     * host-gated by the registry and covers `*.flagship.services` either way.)
     */
    private fun pinner(): CertificatePinner {
        val builder = CertificatePinner.Builder()
        if (Endpoints.isProdControlApex) {
            builder
                // Cloudflare's "Cloudflare Inc ECC CA-3" intermediate.
                .add(Endpoints.controlHost,
                    "sha256/3GwlKvsefAVKRfQGB9ZRSXIXX7TmlXMrcdfQyId3wl0=")
                // Cloudflare's "Cloudflare Inc RSA CA-2" intermediate (fallback).
                .add(Endpoints.controlHost,
                    "sha256/V8/g9SnyOPS7vRZAGwL+y/Mht8GFkrqHHNQYTcCStvE=")
        }
        return builder.build()
    }

    fun build(): OkHttpClient =
        OkHttpClient.Builder()
            .certificatePinner(pinner())
            // Box cert-fingerprint pinning (A′ phase 4, hard-fail), two
            // seams: the hostname verifier runs on every TLS handshake
            // (WebSocket upgrades included — OkHttp skips network
            // interceptors for those); the network interceptor re-checks
            // per request on pooled connections.
            .hostnameVerifier(CertPinHostnameVerifier(CertPinRegistry.shared::pinFor))
            .addNetworkInterceptor(CertPinInterceptor(CertPinRegistry.shared::pinFor))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
}
