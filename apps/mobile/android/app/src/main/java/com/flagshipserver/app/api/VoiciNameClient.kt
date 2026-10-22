// Custom voi.ci names (`.com`) — Kotlin mirror of the webapp lib/voiciName.js
// wire calls (docs/named-links.md):
//
//   GET  /api/users/:u/voici-name-check?name=&service=   account read token
//   GET  /api/users/:u/voici-names                       account read token
//   POST /api/users/:u/apps/:id/voici-name               signed order { order, signature }
//
// Wire types are pure; the VM signs with the sensitive-order key via core.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder

interface VoiciNameClient {
    suspend fun check(username: String, serviceId: String, name: String): VoiciNameCheck
    suspend fun list(username: String): List<VoiciNameEntry>
    /** Set (order.name given) or clear (order.name ""): the service's new link state. */
    suspend fun save(username: String, serviceId: String, body: VoiciNameOrderBody): AppLinkState
}

/** `.com`'s answer to a check: available, current, invalid, reserved, taken, dibs (+`domain`) or dibs-unchecked. */
@Serializable
data class VoiciNameCheck(
    val status: String,
    val domain: String? = null,
    val until: Long? = null,
)

/** One live custom name of the account, for the "Free one up" list. */
@Serializable
data class VoiciNameEntry(
    val serviceId: String,
    val name: String,
    val setAt: Long = 0,
)

@Serializable
data class VoiciNameList(val names: List<VoiciNameEntry> = emptyList())

@Serializable
data class VoiciNameOrderFields(
    val user: String,
    val serviceId: String,
    val name: String,
    val op: String,
    val issuedAt: Long,
    val nonce: String,
)

@Serializable
data class VoiciNameOrderBody(val order: VoiciNameOrderFields, val signature: String)

@Serializable
data class VoiciNameSaved(val link: AppLinkState)

/** A `.com` refusal: [code] says why (taken, reserved, dibs, change-limit, name-limit, ...), [data] is the rest of the body. */
class VoiciNameException(
    val status: Int,
    val code: String?,
    val data: JsonObject,
    override val message: String,
) : RuntimeException(message) {
    fun long(key: String): Long? = (data[key] as? JsonPrimitive)?.longOrNull
    fun int(key: String): Int? = long(key)?.toInt()
    fun string(key: String): String? = (data[key] as? JsonPrimitive)?.contentOrNull
}

class LiveVoiciNameClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = DEFAULT_BASE_URL,
) : VoiciNameClient {
    private val base = baseUrl.trimEnd('/')

    companion object {
        val DEFAULT_BASE_URL: String get() = Endpoints.controlBaseUrl
        private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
    }

    override suspend fun check(username: String, serviceId: String, name: String): VoiciNameCheck = wrap {
        val q = "name=${enc(name.lowercase())}" + if (serviceId.isEmpty()) "" else "&service=${enc(serviceId)}"
        AccountReadTokens.authorize(username) { auth ->
            transport.getJson(
                url = "$base/api/users/${enc(username)}/voici-name-check?$q",
                responseSerializer = VoiciNameCheck.serializer(),
                extraHeaders = auth,
            )
        }
    }

    override suspend fun list(username: String): List<VoiciNameEntry> = wrap {
        AccountReadTokens.authorize(username) { auth ->
            transport.getJson(
                url = "$base/api/users/${enc(username)}/voici-names",
                responseSerializer = VoiciNameList.serializer(),
                extraHeaders = auth,
            )
        }.names
    }

    override suspend fun save(username: String, serviceId: String, body: VoiciNameOrderBody): AppLinkState = wrap {
        transport.postJsonForResponse(
            url = "$base/api/users/${enc(username)}/apps/${enc(serviceId)}/voici-name",
            body = body,
            serializer = VoiciNameOrderBody.serializer(),
            responseSerializer = VoiciNameSaved.serializer(),
        ).link
    }

    private inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: HttpException) {
        val data = runCatching { Json.parseToJsonElement(e.body).jsonObject }.getOrNull() ?: JsonObject(emptyMap())
        throw VoiciNameException(
            status = e.status,
            code = (data["code"] as? JsonPrimitive)?.contentOrNull,
            data = data,
            message = (data["error"] as? JsonPrimitive)?.contentOrNull ?: FSStrings.get(R.string.http_2, e.status),
        )
    }
}
