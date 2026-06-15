// OkHttp-backed BuildClient. Talks to the paired pod at
// `<server>.<user>.flagship.services` and signs every request with the
// 32-byte hex session token in the `x-flagship-session` header — exactly
// like LiveScreensClient, but against the `/api/build/*` surface.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipAPI/Client/LiveBuildClient.swift
// Wire format mirrors apps/web/public/webapp/views/build-*.js + the daemon
// contract in packages/server-daemon/src/buildmodes/buildModesHttp.ts.

package com.flagshipserver.app.api

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

class LiveBuildClient(
    private val client: OkHttpClient = OkHttpClient(),
    private val store: SessionStoring,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    },
) : BuildClient {

    private val jsonMt = "application/json; charset=utf-8".toMediaType()

    private suspend fun base(): String = store.podBaseUrl.value
        ?.trimEnd('/')
        ?: throw ScreensError.NotPaired

    private suspend fun token(): String = store.sessionToken.value
        ?: throw ScreensError.NoSessionToken

    private suspend fun <R> request(
        path: String,
        deserializer: DeserializationStrategy<R>?,
        method: String = "GET",
        body: ByteArray? = null,
    ): R {
        val base = base()
        val token = token()
        val req = Request.Builder()
            .url(base + path)
            .header("x-flagship-session", token)
            .apply {
                if (body != null) {
                    method(method, body.toRequestBody(jsonMt))
                    header("content-type", jsonMt.toString())
                } else {
                    method(method, null)
                }
            }
            .build()
        val resp = suspendCoroutine<okhttp3.Response> { cont ->
            client.newCall(req).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: IOException) { cont.resumeWithException(e) }
                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) { cont.resume(response) }
            })
        }
        val status = resp.code
        val bytes = resp.body?.bytes() ?: ByteArray(0)
        resp.close()
        if (status !in 200..299) throw ScreensError.Http(status, String(bytes, Charsets.UTF_8))
        @Suppress("UNCHECKED_CAST")
        if (deserializer == null) return Unit as R
        return try {
            json.decodeFromString(deserializer, String(bytes, Charsets.UTF_8))
        } catch (t: Throwable) {
            throw ScreensError.Decoding(t.message ?: "decode failed")
        }
    }

    override suspend fun gitImport(req: BuildGitRequest): BuildGitResponse {
        val body = json.encodeToString(BuildGitRequest.serializer(), req).toByteArray()
        return request("/api/build/git", BuildGitResponse.serializer(), "POST", body)
    }

    override suspend fun adapt(buildId: String, req: BuildAdaptRequest): BuildAdaptResponse {
        val body = json.encodeToString(BuildAdaptRequest.serializer(), req).toByteArray()
        return request("/api/build/sessions/$buildId/adapt", BuildAdaptResponse.serializer(), "POST", body)
    }

    override suspend fun mcpCreate(req: BuildMcpRequest): BuildMcpResponse {
        val body = json.encodeToString(BuildMcpRequest.serializer(), req).toByteArray()
        return request("/api/build/mcp", BuildMcpResponse.serializer(), "POST", body)
    }

    override suspend fun mcpGet(buildId: String): BuildMcpResponse =
        request("/api/build/sessions/$buildId/mcp", BuildMcpResponse.serializer())

    override suspend fun mcpRotate(buildId: String, req: BuildMcpRequest): BuildMcpResponse {
        val body = json.encodeToString(BuildMcpRequest.serializer(), req).toByteArray()
        return request("/api/build/sessions/$buildId/mcp/rotate", BuildMcpResponse.serializer(), "POST", body)
    }

    override suspend fun envRequests(buildId: String): BuildEnvRequestsResponse =
        request("/api/build/sessions/$buildId/env-requests", BuildEnvRequestsResponse.serializer())

    override suspend fun sessions(): BuildSessionsResponse =
        request("/api/build/sessions", BuildSessionsResponse.serializer())

    override suspend fun journal(buildId: String): BuildJournalResponse =
        request("/api/build/sessions/$buildId/journal", BuildJournalResponse.serializer())

    override suspend fun deploy(buildId: String): BuildDeployResponse =
        request("/api/build/sessions/$buildId/deploy", BuildDeployResponse.serializer(), "POST", ByteArray(0))
}
