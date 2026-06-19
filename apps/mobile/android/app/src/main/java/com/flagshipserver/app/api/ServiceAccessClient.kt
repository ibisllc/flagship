// Box- AND `.com`-direct client for per-service access gating
// (docs/service-access-gating.md). Mirrors FrontPageClient / LockPowerClient.
//
// BOX (pod-direct, owner-IRK or friend-AID signed):
//   GET  https://<pod>/api/service-access/<serviceRef>   → { mode, allowCount }
//   POST https://<pod>/api/service-access                ({ request, signature })  (IRK)
//   POST https://<pod>/api/service-invites/redeem        ({ secret, visitorAID, aidSig, redeemedAt })  (AID)
//
// `.com` (public CA), author IRK-signed create/revoke + metadata list:
//   POST https://<control>/api/users/<u>/service-invites          ({ request, signature })
//   GET  https://<control>/api/users/<u>/service-invites?authorAID=…
//   POST https://<control>/api/users/<u>/service-invites/revoke    ({ request, signature })

package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HttpClientFactory
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder

data class ServiceAccessState(val mode: String, val allowCount: Int) {
    val isRestricted: Boolean get() = mode == "restricted"
}

data class RedeemResult(val serviceRef: String, val boundAidHex: String, val firstBind: Boolean)

/** The box's response to a successful knock authorize — the phone-held
 *  `secretId` is the only handle to the new browser session. */
data class KnockAuthorizeResult(
    val secretId: String,
    val serviceRef: String,
    val browserAgent: String,
    val startedAt: Long,
    val expiresAt: Long,
)

/** Distinct errors the knock-authorize surfaces so the UI can speak plainly. */
sealed class KnockAuthorizeError(message: String) : RuntimeException(message) {
    object NotAllowed : KnockAuthorizeError("not allow-listed")     // 401
    object Refused : KnockAuthorizeError("refused")                 // 403
    object PageExpired : KnockAuthorizeError("page expired")        // 404
}

/** A `.com` invite row (metadata only — `.com` never stores the secret). The
 *  bundle is ciphertext; decrypt it locally with the household key. */
data class ServiceInviteRow(
    val inviteId: String,
    val serviceRef: String,
    val encryptedBundleHex: String,
    val boundAidHex: String?,
    val boundAt: Long?,
    val createdAt: Long?,
    val revokedAt: Long?,
)

/** Distinct errors the redeem surfaces so the UI can speak plainly. */
sealed class ServiceAccessError(message: String) : RuntimeException(message) {
    object InviteUnknown : ServiceAccessError("unknown invite")          // 404
    object InviteAlreadyBound : ServiceAccessError("already bound")      // 409
    object InviteRevoked : ServiceAccessError("invite revoked")          // 403
}

/** Box calls ride the box transport (the pod-pinned OkHttp — set-mode/redeem
 *  are signature-authed daemon endpoints, so a rogue cert must not intercept);
 *  `.com` calls ride a separate (public-CA) transport. Pluggable for tests. */
class ServiceAccessClient(
    private val boxTransport: JsonHttpTransport = OkHttpJsonTransport(HttpClientFactory.build()),
    private val comTransport: JsonHttpTransport = OkHttpJsonTransport(),
    private val podBaseUrl: (serverDomain: String) -> String = { "https://$it" },
    private val controlBase: () -> String = { Endpoints.controlBaseUrl },
) {
    private val json: Json get() = boxTransport.json

    // ── box ───────────────────────────────────────────────────────────────

    suspend fun getAccessState(serverDomain: String, serviceRef: String): ServiceAccessState {
        val enc = URLEncoder.encode(serviceRef, "UTF-8")
        val resp = boxTransport.execute("GET", "${podBaseUrl(serverDomain)}/api/service-access/$enc", accept = setOf(200))
        val obj = json.parseToJsonElement(String(resp.body, Charsets.UTF_8)).jsonObject
        val mode = obj["mode"]?.jsonPrimitive?.contentOrNull ?: "open"
        val count = obj["allowCount"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0
        return ServiceAccessState(mode, count)
    }

    /** POST a signed set-service-access-mode envelope (IRK). Returns the box's mode. */
    suspend fun setAccessMode(serverDomain: String, request: JsonObject, signatureHex: String): String {
        val body = buildJsonObject {
            put("request", request)
            put("signature", JsonPrimitive(signatureHex))
        }
        val resp = boxTransport.execute(
            "POST", "${podBaseUrl(serverDomain)}/api/service-access",
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200),
        )
        val obj = json.parseToJsonElement(String(resp.body, Charsets.UTF_8)).jsonObject
        return obj["mode"]?.jsonPrimitive?.contentOrNull
            ?: request["mode"]?.jsonPrimitive?.contentOrNull ?: "open"
    }

    /** Friend AID-signed redeem. Maps 404/409/403 to ServiceAccessError. */
    suspend fun redeemInvite(
        serverDomain: String,
        secretHex: String,
        visitorAidHex: String,
        aidSigHex: String,
        redeemedAt: Long,
    ): RedeemResult {
        val body = buildJsonObject {
            put("secret", JsonPrimitive(secretHex.lowercase()))
            put("visitorAID", JsonPrimitive(visitorAidHex.lowercase()))
            put("aidSig", JsonPrimitive(aidSigHex.lowercase()))
            put("redeemedAt", JsonPrimitive(redeemedAt))
        }
        val resp = boxTransport.execute(
            "POST", "${podBaseUrl(serverDomain)}/api/service-invites/redeem",
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200, 403, 404, 409),
        )
        when (resp.status) {
            404 -> throw ServiceAccessError.InviteUnknown
            409 -> throw ServiceAccessError.InviteAlreadyBound
            403 -> throw ServiceAccessError.InviteRevoked
        }
        val obj = json.parseToJsonElement(String(resp.body, Charsets.UTF_8)).jsonObject
        return RedeemResult(
            serviceRef = obj["serviceRef"]?.jsonPrimitive?.contentOrNull ?: "",
            boundAidHex = obj["boundAID"]?.jsonPrimitive?.contentOrNull ?: "",
            firstBind = obj["firstBind"]?.jsonPrimitive?.contentOrNull == "true",
        )
    }

    // ── web-experience gating: knock authorize + session lifecycle ──────────

    /**
     * Phone AID-signed authorize of a browser's knock pageId
     * (docs/service-access-gating.md, "Web-experience gating"). POSTs the signed
     * `KnockAuthorization` to the BOX (over its pinned pipe — `.com` is never in
     * the path). Maps the documented 401/403/404 to [KnockAuthorizeError].
     */
    suspend fun authorizeKnock(
        request: JsonObject,
        signatureHex: String,
    ): KnockAuthorizeResult {
        val serverId = request["serverId"]?.jsonPrimitive?.contentOrNull
            ?: error("authorization.serverId required")
        val body = buildJsonObject {
            put("authorization", request)
            put("signature", JsonPrimitive(signatureHex.lowercase()))
            // The daemon reads `sig`; include both keys so a wire-name skew
            // can't silently 400 (the box ignores the unknown one).
            put("sig", JsonPrimitive(signatureHex.lowercase()))
        }
        val resp = boxTransport.execute(
            "POST", "${podBaseUrl(serverId)}/api/service-access/knock/authorize",
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200, 401, 403, 404),
        )
        when (resp.status) {
            401 -> throw KnockAuthorizeError.NotAllowed
            403 -> throw KnockAuthorizeError.Refused
            404 -> throw KnockAuthorizeError.PageExpired
        }
        val obj = json.parseToJsonElement(String(resp.body, Charsets.UTF_8)).jsonObject
        return KnockAuthorizeResult(
            secretId = obj["secretId"]?.jsonPrimitive?.contentOrNull ?: "",
            serviceRef = obj["serviceRef"]?.jsonPrimitive?.contentOrNull ?: "",
            browserAgent = obj["browserAgent"]?.jsonPrimitive?.contentOrNull ?: "",
            startedAt = obj["startedAt"]?.jsonPrimitive?.longOrNull ?: 0L,
            expiresAt = obj["expiresAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        )
    }

    /**
     * Phone session status. secretId rides the BODY (never the URL). Returns
     * "online" | "offline" (unknown ⇒ "offline" — no enumeration oracle). The
     * box rate-limits ~1/min/secretId; a 429 throws [HttpException] (429) so the
     * caller can keep its last-known state (debounce ≥60s client-side too).
     */
    suspend fun sessionStatus(serverDomain: String, secretId: String): String {
        val body = buildJsonObject { put("secretId", JsonPrimitive(secretId.lowercase())) }
        val resp = boxTransport.execute(
            "POST", "${podBaseUrl(serverDomain)}/api/service-access/session/status",
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200),
        )
        val obj = json.parseToJsonElement(String(resp.body, Charsets.UTF_8)).jsonObject
        return obj["status"]?.jsonPrimitive?.contentOrNull ?: "offline"
    }

    /** Phone-initiated close (kills the browser cookie). Idempotent + oracle-free
     *  (always 200 `{closed:true}`). */
    suspend fun closeSession(serverDomain: String, secretId: String) {
        val body = buildJsonObject { put("secretId", JsonPrimitive(secretId.lowercase())) }
        boxTransport.execute(
            "POST", "${podBaseUrl(serverDomain)}/api/service-access/session/close",
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200),
        )
    }

    // ── .com ────────────────────────────────────────────────────────────────

    private fun comUrl(username: String, suffix: String, query: String? = null): String {
        val u = URLEncoder.encode(username, "UTF-8")
        var s = controlBase().trimEnd('/') + "/api/users/$u/service-invites" + suffix
        if (query != null) s += "?$query"
        return s
    }

    suspend fun createInvite(username: String, request: JsonObject, signatureHex: String) {
        val body = buildJsonObject {
            put("request", request)
            put("signature", JsonPrimitive(signatureHex))
        }
        comTransport.execute(
            "POST", comUrl(username, ""),
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200, 201),
        )
    }

    suspend fun listInvites(username: String, authorAidHex: String): List<ServiceInviteRow> {
        val resp = comTransport.execute(
            "GET", comUrl(username, "", "authorAID=${authorAidHex.lowercase()}"),
            accept = setOf(200),
        )
        val obj = json.parseToJsonElement(String(resp.body, Charsets.UTF_8)).jsonObject
        val rows = obj["invites"]?.jsonArray ?: return emptyList()
        return rows.mapNotNull { el ->
            val r = el.jsonObject
            val inviteId = r["inviteId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val serviceRef = r["serviceRef"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val bundle = r["encryptedBundle"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            ServiceInviteRow(
                inviteId = inviteId,
                serviceRef = serviceRef,
                encryptedBundleHex = bundle,
                boundAidHex = r["boundAID"]?.jsonPrimitive?.contentOrNull,
                boundAt = r["boundAt"]?.jsonPrimitive?.longOrNull,
                createdAt = r["createdAt"]?.jsonPrimitive?.longOrNull,
                revokedAt = r["revokedAt"]?.jsonPrimitive?.longOrNull,
            )
        }
    }

    suspend fun revokeInvite(username: String, request: JsonObject, signatureHex: String) {
        val body = buildJsonObject {
            put("request", request)
            put("signature", JsonPrimitive(signatureHex))
        }
        comTransport.execute(
            "POST", comUrl(username, "/revoke"),
            body = body.toString().toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200),
        )
    }
}
