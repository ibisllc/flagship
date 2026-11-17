// Vouchers and the plan on `.com` (docs/payments-privacy-and-rails.md "As built"). Wire only: core/payments builds
// and checks every body. `.com` answers refusals as {error, code, ...}; the app writes the sentences (PaymentsCopy).
//
//   GET  /api/payments/config                none                 → {config, keys:[{keyId,nHex,eHex,...}], testIssue}
//   GET  /api/accounts/<u>/voucher-wallet    read token           → {version, nonce, ct} | 404
//   PUT  /api/accounts/<u>/voucher-wallet    device headers       → {ok, version} | 409 {code:"version-conflict", wallet}
//   POST /api/vouchers/redeem                NONE (no token, no device headers: a spend names nobody but the account),
//                                            sent through the OHTTP relays `.com` lists in the config's `ohttp`
//   POST /api/vouchers/test-issue            none (the gym only)  → {k, sigs}
//   POST /api/vouchers/paid-issue            NONE (a payment buys signatures, never an account link) → {k, sigs, units}
//   POST /api/vouchers/exchange              NONE (spends vouchers, blind-signs as many fresh ones) → {k, sigs}
//   GET  /api/users/<u>/plan-attestation     read token           → {tier, paidUntil, ...}
//   GET  /api/users/<u>/allowance            read token           → {tier, usedBytes, quotaBytes, remainingBytes, ...}

package com.flagshipserver.app.api

import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.ohttp.OhttpClient
import com.flagshipserver.app.core.ohttp.OhttpPublicConfig
import com.flagshipserver.app.core.ohttp.PrivateRequest
import com.flagshipserver.app.core.ohttp.raw
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder
import java.security.SecureRandom

/**
 * A `.com` refusal: [code] is the machine code (`voucher-spent`, `version-conflict`, ...), [body] the whole answer.
 * [via] is "ohttp" when a relay carried the refusal (the relay worked), "direct" when it went straight to `.com`.
 */
class PaymentsHttpError(val status: Int, val code: String?, val body: JsonObject, val via: String? = null) : RuntimeException("payments $status ${code ?: ""}")

/** The account's plan as `.com` signs it for its boxes: [tier] free | hobby (Pro) | maker (Pro Max). */
data class PlanState(val tier: String, val paidUntil: Long)

/** A paid issue's answer: the blind signatures under [k], in order, for the [units] the payment bought. */
data class PaidIssue(val k: String, val sigs: List<String>, val units: Long)

data class AllowanceState(val usedBytes: Long, val quotaBytes: Long, val remainingBytes: Long)

/** A spend's answer and how it travelled: [path] "ohttp" or "direct"; [fallbackReason] why it went direct. */
data class Redeemed(val answer: JsonObject, val path: String = "ohttp", val fallbackReason: String? = null)

interface PaymentsClient {
    suspend fun config(): JsonObject?
    suspend fun wallet(username: String): JsonObject?
    /** [PaymentsHttpError] 409 `version-conflict` carries the stored `wallet`. */
    suspend fun putWallet(username: String, device: VoiciDeviceSigner, blob: JsonObject)
    suspend fun plan(username: String): PlanState?
    suspend fun allowance(username: String): AllowanceState?
    /** The answer on 200, else [PaymentsHttpError]. */
    suspend fun redeem(body: JsonObject): JsonObject
    /**
     * The spend through the private relays in [relay] (docs/outbound-proxy.md "Failure handling"). When every relay
     * failed, [mayGoDirect] decides whether it goes straight to `.com`, marked; if not, it throws
     * [com.flagshipserver.app.core.ohttp.RelayUnavailableException]. The inner answer is handled like [redeem]'s.
     * Fakes that don't model the relay answer as if it carried the spend.
     */
    suspend fun redeemPrivately(body: JsonObject, relay: OhttpPublicConfig, mayGoDirect: (reason: String) -> Boolean): Redeemed =
        Redeemed(redeem(body))
    /** The blind signatures, in order. */
    suspend fun testIssue(keyId: String, blinded: List<String>): List<String>
    /**
     * Blind signatures bought by a store payment ([rail] `google` with proof `{productId, purchaseToken}`). Idempotent:
     * the same payment with the same blinded set answers the same signatures. Refusals are [PaymentsHttpError] with
     * `payment-invalid`, `payment-unpaid`, `payment-refunded`, `payment-used`, `wrong-count` (+`units`), `rail-off`,
     * `no-key`, `rail-unreachable`, `malformed` or `too-many`.
     */
    suspend fun paidIssue(rail: String, proof: JsonObject, keyId: String, blinded: List<String>): PaidIssue

    /**
     * Spends [vouchers] and blind-signs as many fresh requests under [keyId] (all or nothing): an org wallet after its
     * key rotated, so an admin who left can't spend what they could read. Refusals: `voucher-spent`, `no-key`, `bad-voucher`.
     */
    suspend fun exchange(keyId: String, vouchers: List<JsonObject>, blinded: List<String>): Pair<String, List<String>> =
        throw PaymentsHttpError(404, "unavailable", JsonObject(emptyMap()))
}

class LivePaymentsClient(
    private val transport: JsonHttpTransport,
    private val base: () -> String = { Endpoints.controlBaseUrl.trimEnd('/') },
    private val now: () -> Long = System::currentTimeMillis,
) : PaymentsClient {
    private val rng = SecureRandom()
    private fun enc(s: String) = URLEncoder.encode(s.lowercase(), "UTF-8")
    private fun parse(b: ByteArray): JsonObject? = runCatching { Json.parseToJsonElement(b.decodeToString()) as? JsonObject }.getOrNull()
    private fun JsonObject.long(k: String) = (this[k] as? JsonPrimitive)?.longOrNull

    private suspend fun <T> call(block: suspend () -> T): T = try {
        block()
    } catch (e: HttpException) {
        val body = runCatching { Json.parseToJsonElement(e.body) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        throw PaymentsHttpError(e.status, (body["code"] as? JsonPrimitive)?.contentOrNull, body)
    }

    private fun deviceHeaders(username: String, d: VoiciDeviceSigner, method: String, path: String): Map<String, String> {
        val requestId = HexUtil.encode(ByteArray(16).also(rng::nextBytes))
        val at = now()
        val sig = d.signer.sign(AccountMetadata.canonicalDirectoryRequest(username, d.deviceId, d.pubHex, method, path, requestId, at))
        return mapOf(
            "x-flagship-device-id" to d.deviceId,
            "x-flagship-device-pub" to d.pubHex,
            "x-flagship-request-id" to requestId,
            "x-flagship-issued-at" to at.toString(),
            "x-flagship-signature" to HexUtil.encode(sig),
            "cache-control" to "no-store",
        )
    }

    override suspend fun config(): JsonObject? = runCatching {
        parse(transport.execute("GET", "${base()}/api/payments/config", accept = setOf(200)).body)
    }.getOrNull()

    override suspend fun wallet(username: String): JsonObject? = call {
        AccountReadTokens.authorize(username) { auth ->
            val r = transport.execute("GET", "${base()}/api/accounts/${enc(username)}/voucher-wallet", extraHeaders = auth, accept = setOf(200, 404))
            if (r.status == 404) null else parse(r.body)
        }
    }

    override suspend fun putWallet(username: String, device: VoiciDeviceSigner, blob: JsonObject) {
        val path = "/api/accounts/${enc(username)}/voucher-wallet"
        call { transport.execute("PUT", base() + path, blob.toString().toByteArray(), "application/json; charset=utf-8", deviceHeaders(username, device, "PUT", path), setOf(200, 204)) }
    }

    override suspend fun plan(username: String): PlanState? = call {
        AccountReadTokens.authorize(username) { auth ->
            val o = parse(transport.execute("GET", "${base()}/api/users/${enc(username)}/plan-attestation", extraHeaders = auth, accept = setOf(200)).body)
            o?.let { PlanState((it["tier"] as? JsonPrimitive)?.contentOrNull ?: "free", it.long("paidUntil") ?: 0) }
        }
    }

    override suspend fun allowance(username: String): AllowanceState? = runCatching {
        AccountReadTokens.authorize(username) { auth ->
            val o = parse(transport.execute("GET", "${base()}/api/users/${enc(username)}/allowance", extraHeaders = auth, accept = setOf(200)).body)
            o?.let { AllowanceState(it.long("usedBytes") ?: 0, it.long("quotaBytes") ?: 0, it.long("remainingBytes") ?: 0) }
        }
    }.getOrNull()

    override suspend fun redeem(body: JsonObject): JsonObject = call {
        // No authorization, no device headers, no cookies: anyone may pay any account's bill, and a spend says nothing
        // about who sent it (the route is also open through the OHTTP relay).
        val r = transport.execute("POST", "${base()}/api/vouchers/redeem", body.toString().toByteArray(), "application/json; charset=utf-8", emptyMap(), setOf(200))
        parse(r.body) ?: JsonObject(emptyMap())
    }

    override suspend fun redeemPrivately(body: JsonObject, relay: OhttpPublicConfig, mayGoDirect: (reason: String) -> Boolean): Redeemed {
        // The relay is a third-party https host, checked by the system trust store like any web host; only `.com`
        // and the boxes carry Flagship's own pins, and the shared client applies them by host.
        val r = OhttpClient.sendThroughRelays(
            transport.raw(),
            PrivateRequest("${base()}/api/vouchers/redeem", "POST", listOf("content-type" to "application/json"), body.toString().toByteArray()),
            relay.keyConfig,
            relay.relays.map { it.url },
            mayGoDirect,
        )
        val parsed = parse(r.body)
        if (r.status != 200) {
            val b = parsed ?: JsonObject(emptyMap())
            throw PaymentsHttpError(r.status, (b["code"] as? JsonPrimitive)?.contentOrNull, b, r.path)
        }
        return Redeemed(parsed ?: JsonObject(emptyMap()), r.path, r.fallbackReason)
    }

    override suspend fun testIssue(keyId: String, blinded: List<String>): List<String> = call {
        val body = JsonObject(mapOf("k" to JsonPrimitive(keyId), "blinded" to JsonArray(blinded.map(::JsonPrimitive))))
        val r = transport.execute("POST", "${base()}/api/vouchers/test-issue", body.toString().toByteArray(), "application/json; charset=utf-8", emptyMap(), setOf(200))
        (parse(r.body)?.get("sigs") as? JsonArray).orEmpty().map { (it as JsonPrimitive).content }
    }

    override suspend fun exchange(keyId: String, vouchers: List<JsonObject>, blinded: List<String>): Pair<String, List<String>> = call {
        // Like redeem: no authorization, no device headers. It names no org and no account.
        val body = JsonObject(
            linkedMapOf(
                "v" to JsonPrimitive(1),
                "k" to JsonPrimitive(keyId),
                "vouchers" to JsonArray(vouchers),
                "blinded" to JsonArray(blinded.map(::JsonPrimitive)),
            ),
        )
        val r = transport.execute("POST", "${base()}/api/vouchers/exchange", body.toString().toByteArray(), "application/json; charset=utf-8", emptyMap(), setOf(200))
        val o = parse(r.body) ?: JsonObject(emptyMap())
        ((o["k"] as? JsonPrimitive)?.contentOrNull ?: keyId) to (o["sigs"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    }

    override suspend fun paidIssue(rail: String, proof: JsonObject, keyId: String, blinded: List<String>): PaidIssue = call {
        // Like redeem: no authorization, no device headers, no cookies. The proof of payment is the only thing it carries.
        val body = JsonObject(
            linkedMapOf(
                "v" to JsonPrimitive(1),
                "rail" to JsonPrimitive(rail),
                "proof" to proof,
                "k" to JsonPrimitive(keyId),
                "blinded" to JsonArray(blinded.map(::JsonPrimitive)),
            ),
        )
        val r = transport.execute("POST", "${base()}/api/vouchers/paid-issue", body.toString().toByteArray(), "application/json; charset=utf-8", emptyMap(), setOf(200))
        val o = parse(r.body) ?: JsonObject(emptyMap())
        PaidIssue(
            (o["k"] as? JsonPrimitive)?.contentOrNull ?: keyId,
            (o["sigs"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
            o.long("units") ?: 0,
        )
    }
}
