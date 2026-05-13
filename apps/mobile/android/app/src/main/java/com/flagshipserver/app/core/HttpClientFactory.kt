// Builds the shared OkHttp client used by Live{Screens,FlagshipServer,
// QrRelay}Client. Adds certificate pinning for flagshipserver.com
// only — the per-user pod hostnames (<server>.<user>.flagship.services)
// use user-managed Let's Encrypt certs that rotate every ~60 days,
// so we DELIBERATELY don't pin them (would break failover, lineage
// breaks, and any healthy renewal cycle).

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
    private val pinner: CertificatePinner = CertificatePinner.Builder()
        // Cloudflare's "Cloudflare Inc ECC CA-3" intermediate.
        .add("flagshipserver.com",
            "sha256/3GwlKvsefAVKRfQGB9ZRSXIXX7TmlXMrcdfQyId3wl0=")
        // Cloudflare's "Cloudflare Inc RSA CA-2" intermediate (fallback).
        .add("flagshipserver.com",
            "sha256/V8/g9SnyOPS7vRZAGwL+y/Mht8GFkrqHHNQYTcCStvE=")
        .build()

    fun build(): OkHttpClient =
        OkHttpClient.Builder()
            .certificatePinner(pinner)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
}
