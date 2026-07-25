// Builds the shared OkHttp client used by Live{Screens,FlagshipServer,
// QrRelay,SecretMailbox}Client (and the browser-stream WebSocket, which
// upgrades through the same chain).
//
// TLS trust policy (owner decision 2026-07-25): the control apex
// (flagshipserver.com) uses STANDARD system CA validation — like any normal
// app — and is NOT statically cert-pinned. Pinning a domain fronted by a
// third-party edge (Cloudflare) to specific SPKIs is fragile: the edge
// rotates certs and even swaps CAs (it silently migrated to Google Trust
// Services), which hard-failed every request. The ONLY thing this system
// pins is the maintainer authority from our own ceremonies
// (MAINTAINER_PINNED_MANDATE_HASH → MaintainersTrust), which is transport-
// independent, so a rotated edge cert can never break the app.
//
// The DYNAMIC box-cert layer below is a DIFFERENT mechanism: it pins each box
// hostname (<server>.<user>.flagship.services) to the box's OWN STK-signed
// leaf-cert fingerprint, which THIS phone verified via the box's signed
// daemon-status report — i.e. it is anchored in our own account ceremony, not
// a third party, and self-heals on every renewal.

package com.flagshipserver.app.core

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object HttpClientFactory {
    fun build(): OkHttpClient =
        OkHttpClient.Builder()
            // No static control-apex cert pin — standard system CA trust (see
            // the header note). Box cert-fingerprint pinning (A′ phase 4,
            // hard-fail) stays, on two seams: the hostname verifier runs on
            // every TLS handshake (WebSocket upgrades included — OkHttp skips
            // network interceptors for those); the network interceptor
            // re-checks per request on pooled connections.
            .hostnameVerifier(CertPinHostnameVerifier(CertPinRegistry.shared::pinFor))
            .addNetworkInterceptor(CertPinInterceptor(CertPinRegistry.shared::pinFor))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
}
