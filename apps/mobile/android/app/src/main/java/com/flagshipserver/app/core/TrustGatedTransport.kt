// Maintainer-trust short-circuit for the `.com` HTTP transport.
//
// Wraps any JsonHttpTransport: before EVERY request it consults the trust gate
// (the app's TrustCenter.isServerTrusted) and throws ControlServerUntrusted
// BEFORE any bytes leave the device when the control server is positively
// untrusted. A null/true gate ⇒ the call proceeds — UNKNOWN/TRUSTED verdicts
// and any network-error "no verdict" all return true, so we never brick on the
// absence of a positive-untrusted verdict, only on a valid blessing that fails.

package com.flagshipserver.app.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

/** Thrown when the control server failed maintainer-trust verification and the
 *  owner has not granted an exception. Distinct from [HttpException] (a real
 *  server response) and a network IOException. */
class ControlServerUntrustedException :
    RuntimeException("control server failed maintainer-trust verification")

class TrustGatedTransport(
    private val delegate: JsonHttpTransport,
    /** Returns the app's current isServerTrusted. False ⇒ halt every call. */
    private val isTrusted: () -> Boolean,
) : JsonHttpTransport {
    override val json: Json get() = delegate.json

    private fun gate() {
        if (!isTrusted()) throw ControlServerUntrustedException()
    }

    override suspend fun execute(
        method: String,
        url: String,
        body: ByteArray?,
        contentType: String?,
        extraHeaders: Map<String, String>,
        accept: Set<Int>,
    ): HttpResponse {
        gate()
        return delegate.execute(method, url, body, contentType, extraHeaders, accept)
    }

    override suspend fun <T> postJson(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        accept: Set<Int>,
        extraHeaders: Map<String, String>,
    ) {
        gate()
        delegate.postJson(url, body, serializer, accept, extraHeaders)
    }

    override suspend fun <T, R> postJsonForResponse(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String>,
    ): R {
        gate()
        return delegate.postJsonForResponse(url, body, serializer, responseSerializer, extraHeaders)
    }

    override suspend fun <R> getJson(
        url: String,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String>,
    ): R {
        gate()
        return delegate.getJson(url, responseSerializer, extraHeaders)
    }

    override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) {
        gate()
        delegate.deleteJson(url, accept, extraHeaders)
    }
}
