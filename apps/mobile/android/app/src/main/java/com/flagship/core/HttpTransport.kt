// Minimal JSON/HTTP wrapper around OkHttp used by every live API
// client. Wraps non-2xx statuses (outside the per-call accept set) into
// a structured HttpException so callers can branch on status.
//
// Callers always pass an explicit KSerializer — no reflection / codegen
// dependency, no runtime surprises. The BFF is small enough that the
// extra arg is cheaper than the Retrofit dependency.

package com.flagship.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

class HttpException(val status: Int, val body: String) :
    RuntimeException("HTTP $status: $body")

interface JsonHttpTransport {
    val json: Json

    suspend fun execute(
        method: String,
        url: String,
        body: ByteArray? = null,
        contentType: String? = null,
        extraHeaders: Map<String, String> = emptyMap(),
        accept: Set<Int> = setOf(200, 201, 204),
    ): HttpResponse

    suspend fun <T> postJson(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        accept: Set<Int> = setOf(200, 201, 204),
        extraHeaders: Map<String, String> = emptyMap(),
    )

    suspend fun <T, R> postJsonForResponse(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String> = emptyMap(),
    ): R

    suspend fun <R> getJson(
        url: String,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String> = emptyMap(),
    ): R

    suspend fun deleteJson(
        url: String,
        accept: Set<Int> = setOf(200, 204),
        extraHeaders: Map<String, String> = emptyMap(),
    )
}

data class HttpResponse(
    val status: Int,
    val body: ByteArray,
    val headers: Map<String, String>,
)

class OkHttpJsonTransport(
    private val client: OkHttpClient = OkHttpClient(),
    override val json: Json = defaultJson,
) : JsonHttpTransport {
    companion object {
        val defaultJson = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
            explicitNulls = false
        }
        private val JSON_MT = "application/json; charset=utf-8".toMediaType()
    }

    override suspend fun execute(
        method: String,
        url: String,
        body: ByteArray?,
        contentType: String?,
        extraHeaders: Map<String, String>,
        accept: Set<Int>,
    ): HttpResponse {
        val req = Request.Builder().url(url).apply {
            val mt = (contentType ?: "application/octet-stream").toMediaType()
            if (body != null) method(method, body.toRequestBody(mt)) else method(method, null)
            extraHeaders.forEach { (k, v) -> header(k, v) }
        }.build()
        val resp = suspendCoroutine<okhttp3.Response> { cont ->
            client.newCall(req).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: IOException) { cont.resumeWithException(e) }
                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) { cont.resume(response) }
            })
        }
        val status = resp.code
        val bodyBytes = resp.body?.bytes() ?: ByteArray(0)
        val headers = (0 until resp.headers.size).associate { resp.headers.name(it) to resp.headers.value(it) }
        resp.close()
        if (status !in accept) {
            throw HttpException(status, String(bodyBytes, Charsets.UTF_8))
        }
        return HttpResponse(status, bodyBytes, headers)
    }

    override suspend fun <T> postJson(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        accept: Set<Int>,
        extraHeaders: Map<String, String>,
    ) {
        val bytes = json.encodeToString(serializer, body).toByteArray(Charsets.UTF_8)
        execute("POST", url, bytes, JSON_MT.toString(), extraHeaders, accept)
    }

    override suspend fun <T, R> postJsonForResponse(
        url: String,
        body: T,
        serializer: KSerializer<T>,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String>,
    ): R {
        val bytes = json.encodeToString(serializer, body).toByteArray(Charsets.UTF_8)
        val resp = execute("POST", url, bytes, JSON_MT.toString(), extraHeaders)
        return json.decodeFromString(responseSerializer, String(resp.body, Charsets.UTF_8))
    }

    override suspend fun <R> getJson(
        url: String,
        responseSerializer: KSerializer<R>,
        extraHeaders: Map<String, String>,
    ): R {
        val resp = execute("GET", url, extraHeaders = extraHeaders)
        return json.decodeFromString(responseSerializer, String(resp.body, Charsets.UTF_8))
    }

    override suspend fun deleteJson(url: String, accept: Set<Int>, extraHeaders: Map<String, String>) {
        execute("DELETE", url, extraHeaders = extraHeaders, accept = accept)
    }
}
