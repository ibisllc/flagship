// Name dibs client (`.com`) — Kotlin mirror of iOS NameDibsClient.swift and the
// webapp lib/nameDibs.js wire bodies:
//
//   GET  /api/name-dibs/window     public
//   POST /api/name-dibs/initiate   IRK-signed { request, signature }
//   POST /api/name-dibs/verify     IRK-signed { request, signature }
//
// Wire types are pure; the VM signs with the IRK via core.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

interface NameDibsClient {
    suspend fun window(): DibsWindow
    suspend fun initiate(body: DibsInitiateBody): DibsClaim
    suspend fun verify(body: DibsVerifyBody): DibsVerifyResult
}

@Serializable
data class DibsWindow(
    val configured: Boolean = false,
    val open: Boolean = false,
    val start: Long? = null,
    val end: Long? = null,
    val priceUsd: Int? = null,
)

@Serializable
data class DibsInitiateRequest(val username: String, val name: String, val irkPubHex: String, val issuedAt: Long)

@Serializable
data class DibsInitiateBody(val request: DibsInitiateRequest, val signature: String)

@Serializable
data class DibsVerifyRequest(val username: String, val name: String, val nonce: String, val issuedAt: Long)

@Serializable
data class DibsVerifyBody(val request: DibsVerifyRequest, val signature: String)

@Serializable
data class DibsPublishDns(val name: String, val type: String = "TXT")

@Serializable
data class DibsPublishHttps(val url: String)

@Serializable
data class DibsPublishAt(val dns: DibsPublishDns, val https: DibsPublishHttps)

/** `.com`'s answer to initiate: what to publish and where. */
@Serializable
data class DibsClaim(
    val name: String,
    val nonce: String,
    val challenge: String,
    val record: String,
    val publishAt: DibsPublishAt,
    val expiresAt: Long = 0,
    val verified: Boolean = false,
)

@Serializable
data class DibsVerifyResult(val name: String, val verified: Boolean, val method: String? = null)

/** A `.com` refusal, carrying its `{ error }` text as the message. */
class DibsClientException(val status: Int, override val message: String) : RuntimeException(message)

class LiveNameDibsClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = DEFAULT_BASE_URL,
) : NameDibsClient {
    private val base = baseUrl.trimEnd('/')

    companion object {
        val DEFAULT_BASE_URL: String get() = Endpoints.controlBaseUrl
    }

    override suspend fun window(): DibsWindow = wrap {
        transport.getJson("$base/api/name-dibs/window", DibsWindow.serializer())
    }

    override suspend fun initiate(body: DibsInitiateBody): DibsClaim = wrap {
        transport.postJsonForResponse(
            "$base/api/name-dibs/initiate", body,
            serializer = DibsInitiateBody.serializer(),
            responseSerializer = DibsClaim.serializer(),
        )
    }

    override suspend fun verify(body: DibsVerifyBody): DibsVerifyResult = wrap {
        transport.postJsonForResponse(
            "$base/api/name-dibs/verify", body,
            serializer = DibsVerifyBody.serializer(),
            responseSerializer = DibsVerifyResult.serializer(),
        )
    }

    private inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: HttpException) {
        val message = runCatching {
            Json.parseToJsonElement(e.body).jsonObject["error"]?.jsonPrimitive?.content
        }.getOrNull()
        throw DibsClientException(e.status, message ?: "HTTP ${e.status}")
    }
}

/** Scriptable broker for previews and tests. Records every signed body. */
class MockNameDibsClient : NameDibsClient {
    var scriptedWindow = DibsWindow()
    var initiateError: DibsClientException? = null
    var verifyError: DibsClientException? = null
    val initiates = mutableListOf<DibsInitiateBody>()
    val verifies = mutableListOf<DibsVerifyBody>()

    override suspend fun window(): DibsWindow = scriptedWindow

    override suspend fun initiate(body: DibsInitiateBody): DibsClaim {
        initiates += body
        initiateError?.let { throw it }
        val name = body.request.name
        return DibsClaim(
            name = name,
            nonce = "0".repeat(63) + "1",
            challenge = "mock-challenge",
            record = "flagship-claim:mock-challenge",
            publishAt = DibsPublishAt(
                DibsPublishDns("_flagship-claim.$name.com"),
                DibsPublishHttps("https://$name.com/.well-known/flagship-claim"),
            ),
        )
    }

    override suspend fun verify(body: DibsVerifyBody): DibsVerifyResult {
        verifies += body
        verifyError?.let { throw it }
        return DibsVerifyResult(name = body.request.name, verified = true, method = "dns")
    }
}
