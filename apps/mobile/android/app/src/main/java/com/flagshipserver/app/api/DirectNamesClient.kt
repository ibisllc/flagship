// Direct access on `.com` (docs/direct-access-and-domains.md §8):
//
//   GET  /api/accounts/:u/direct-access                 read token
//   POST /api/accounts/:u/direct-access                 the owner's signed direct-access order
//   POST /api/accounts/:u/direct-names                  the owner's signed direct-name order
//   POST /api/accounts/:u/direct-names/:label/probe     read token, the outside check
//
// Mirrors iOS `DirectNamesClient.swift` and the webapp's `lib/directNames.js`.

package com.flagshipserver.app.api

import com.flagshipserver.app.R
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.DirectAccess
import com.flagshipserver.app.core.DirectName
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URLEncoder

interface DirectNamesClient {
    suspend fun state(username: String): DirectAccountState
    suspend fun postAccessOrder(username: String, signed: DirectAccess.SignedOrder)
    suspend fun postNameOrder(username: String, signed: DirectName.SignedOrder)
    suspend fun probe(username: String, label: String): DirectProbe
}

/** `GET /api/accounts/:u/direct-access`. */
@Serializable
data class DirectAccountState(
    val apex: String = DirectName.APEX,
    val servers: List<DirectServerState> = emptyList(),
    val names: List<DirectNameState> = emptyList(),
) {
    fun server(domain: String): DirectServerState? = servers.firstOrNull { it.serverDomain.equals(domain, ignoreCase = true) }
    fun name(fqdn: String): DirectNameState? = names.firstOrNull { it.name.equals(fqdn, ignoreCase = true) }
}

@Serializable
data class DirectServerState(
    val serverDomain: String,
    val on: Boolean,
    val addresses: List<String> = emptyList(),
    val prefixes: List<String> = emptyList(),
    val port: Int? = 443,
    val issuedAt: Long? = null,
    val boxAddresses: List<String>? = null,
    val boxReportedAt: Long? = null,
)

/** One name with its zone state (`state`: published, pending or empty; `reason` says why it has no records). */
@Serializable
data class DirectNameState(
    val name: String,
    val serverDomain: String,
    val enabled: Boolean,
    val caa: String = DirectName.CAA_PIN,
    val addresses: List<String> = emptyList(),
    val issuedAt: Long? = null,
    val state: String,
    val reason: String? = null,
    val publishedAt: Long? = null,
    val suspended: DirectSuspension? = null,
    val probe: DirectProbe? = null,
) {
    val isPublished: Boolean get() = state == "published"
}

@Serializable
data class DirectSuspension(val at: Long? = null, val reason: String? = null)

/** The outside check: [reachable] is null when nothing was published to check ([why] is then `not-published`). */
@Serializable
data class DirectProbe(
    val at: Long? = null,
    val reachable: Boolean? = null,
    val why: String? = null,
    val https: DirectProbeHttps? = null,
)

@Serializable
data class DirectProbeHttps(val ok: Boolean, val status: Int? = null)

/** A refusal from `.com` or the box: [code] picks the app's sentence ([DirectAccessText.refusal]). */
class DirectAccessRefusal(
    val status: Int,
    val code: String?,
    val serverMessage: String? = null,
) : RuntimeException(code ?: serverMessage ?: "direct access refused") {
    val sentence: String get() = DirectAccessText.refusal(code, serverMessage)

    companion object {
        fun fromBody(status: Int, body: String): DirectAccessRefusal {
            val obj = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()
            return DirectAccessRefusal(
                status,
                (obj?.get("code") as? JsonPrimitive)?.contentOrNull,
                (obj?.get("error") as? JsonPrimitive)?.contentOrNull,
            )
        }
    }
}

/** The app's own sentence for every refusal, publish reason and probe answer (docs/direct-access-and-domains.md §8). */
object DirectAccessText {
    fun refusal(code: String?, fallback: String? = null): String = when (code) {
        "malformed", "bad-time", "off-with-addresses", "bad-caa", "no-server" -> FSStrings.get(R.string.da_refusal_unreadable)
        "private-address" -> FSStrings.get(R.string.da_refusal_private_address)
        "bad-address", "non-canonical-address" -> FSStrings.get(R.string.da_refusal_bad_address)
        "bad-prefix" -> FSStrings.get(R.string.da_refusal_bad_prefix)
        "prefix-too-wide" -> FSStrings.get(R.string.da_refusal_prefix_too_wide)
        "no-addresses" -> FSStrings.get(R.string.da_refusal_no_addresses)
        "too-many" -> FSStrings.get(R.string.da_refusal_too_many)
        "duplicate" -> FSStrings.get(R.string.da_refusal_duplicate)
        "bad-port" -> FSStrings.get(R.string.da_refusal_bad_port)
        "bad-name" -> FSStrings.get(R.string.da_refusal_bad_name)
        "not-yet-valid", "stale" -> FSStrings.get(R.string.da_refusal_clock)
        "unknown-account" -> FSStrings.get(R.string.da_refusal_unknown_account)
        "not-your-server", "wrong-server", "unknown-server" -> FSStrings.get(R.string.da_refusal_not_your_server)
        "not-admin" -> FSStrings.get(R.string.da_refusal_not_admin)
        "replayed" -> FSStrings.get(R.string.da_refusal_replayed)
        "vanity-not-available" -> FSStrings.get(R.string.da_refusal_vanity)
        "not-your-name" -> FSStrings.get(R.string.da_refusal_not_your_name)
        "taken" -> FSStrings.get(R.string.da_refusal_taken)
        "unknown-name" -> FSStrings.get(R.string.da_refusal_unknown_name)
        "probe-too-soon" -> FSStrings.get(R.string.da_refusal_probe_too_soon)
        else -> fallback?.takeIf { it.isNotEmpty() } ?: FSStrings.get(R.string.da_refusal_generic)
    }

    /** The line under a name: its state, and why it has no records. */
    fun state(n: DirectNameState): String {
        if (n.suspended != null) return FSStrings.get(R.string.da_state_suspended)
        return when (n.state) {
            "published" -> FSStrings.get(R.string.da_state_published)
            "pending" -> FSStrings.get(R.string.da_state_pending)
            else -> reason(n.reason) ?: FSStrings.get(R.string.da_state_not_published)
        }
    }

    fun reason(code: String?): String? = when (code) {
        "off" -> FSStrings.get(R.string.da_reason_off)
        "suspended" -> FSStrings.get(R.string.da_state_suspended)
        "account-gone" -> FSStrings.get(R.string.da_reason_account_gone)
        "server-gone" -> FSStrings.get(R.string.da_reason_server_gone)
        "order-unverified" -> FSStrings.get(R.string.da_reason_order_unverified)
        "direct-access-off" -> FSStrings.get(R.string.da_reason_access_off)
        "no-addresses" -> FSStrings.get(R.string.da_reason_no_addresses)
        "caa-account-unknown" -> FSStrings.get(R.string.da_reason_caa_unknown)
        else -> null
    }

    fun probe(p: DirectProbe): String = when (p.reachable) {
        true -> FSStrings.get(R.string.da_probe_reachable)
        false -> FSStrings.get(R.string.da_probe_unreachable)
        null -> FSStrings.get(R.string.da_probe_nothing)
    }
}

class LiveDirectNamesClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = Endpoints.controlBaseUrl,
) : DirectNamesClient {
    private val base = baseUrl.trimEnd('/')

    private fun enc(s: String): String = URLEncoder.encode(s.lowercase(), "UTF-8")

    override suspend fun state(username: String): DirectAccountState = wrap {
        AccountReadTokens.authorize(username) { auth ->
            transport.getJson("$base/api/accounts/${enc(username)}/direct-access", DirectAccountState.serializer(), auth)
        }
    }

    override suspend fun postAccessOrder(username: String, signed: DirectAccess.SignedOrder) = wrap {
        transport.postJson("$base/api/accounts/${enc(username)}/direct-access", signed, DirectAccess.SignedOrder.serializer())
    }

    override suspend fun postNameOrder(username: String, signed: DirectName.SignedOrder) = wrap {
        transport.postJson("$base/api/accounts/${enc(username)}/direct-names", signed, DirectName.SignedOrder.serializer())
    }

    override suspend fun probe(username: String, label: String): DirectProbe = wrap {
        AccountReadTokens.authorize(username) { auth ->
            val r = transport.execute(
                "POST",
                "$base/api/accounts/${enc(username)}/direct-names/${enc(label)}/probe",
                ByteArray(0),
                "application/json",
                auth,
                setOf(200),
            )
            transport.json.decodeFromString(DirectProbe.serializer(), String(r.body, Charsets.UTF_8))
        }
    }

    private inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: HttpException) {
        throw DirectAccessRefusal.fromBody(e.status, e.body)
    }
}
