// voi.ci pages and Messages on `.com` (docs/voici-and-messages.md §3, §6.3, §6.4, §8.3, §9.2, §10.1). Wire only:
// every body is built and checked by core/voici (chunk A), this client moves JSON. `.com` answers refusals as
// {error, code, retryAfterSec?}; the apps write the sentences (VoiciCopy).
//
//   POST /api/voici/pages/<u>/pieces            sensitive-key headers, body = the piece bytes
//   POST /api/voici/pages/<u>/publish           {index}                         → {index} | 409 {code:"seq-conflict", index}
//   GET  /api/voici/pages/<u>                   none                            → {index} | 404
//   GET  /api/voici/pages/<u>/pieces/<sha256>   none                            → piece bytes (only listed pieces)
//   POST /api/accounts/<u>/voici-drafts         device headers, {envelope}
//   GET  /api/accounts/<u>/voici-drafts         read token                      → {drafts:[envelope]}
//   POST /api/accounts/<u>/voici-drafts/consume {consume:{username, opIds, issuedAt}, signature}
//   GET  /api/voici/pages/<u>/inbox?since=      read token                      → {items, cursor, more, blocks, revoked}
//   POST /api/voici/web/send                    {envelope, direct?}             → {accepted, msgId}
//   POST /api/voici/pages/<u>/block             {block, signature}
//   POST /api/voici/web/revoke                  {revoke, principalPub, signature}
//   POST /api/voici/reports                     {kind:"message", pageId, envelope, reason, attached, issuedAt, signature}
//   GET/PUT /api/accounts/<u>/messages-state    read token / device headers     → the blob | 409 {code, state}
//   POST /api/accounts/<u>/messages-attestation device headers, {request, signature, integrity?, previous?} → {attestation}
//   GET  /api/username/<u>                      none                            → {irkPub, adminRootPub?}
//   POST /api/voici/web/thread                  {conv, since, issuedAt, sig, cred} → {items, next, more}  (the visitor's own thread)

package com.flagshipserver.app.api

import com.flagshipserver.app.core.AccountMetadata
import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.security.SecureRandom

/** A `.com` refusal: [code] is the spec's code (`seq-conflict`, `rate-limited`, ...), [body] the whole answer. */
class VoiciHttpError(val status: Int, val code: String?, val body: JsonObject) : RuntimeException("voici $status ${code ?: ""}") {
    val retryAfterSec: Long? get() = (body["retryAfterSec"] as? JsonPrimitive)?.longOrNull
}

/** The account device key that signs device-header requests (`flagship/account-directory-request/v1`). */
class VoiciDeviceSigner(val deviceId: String, val pubHex: String, val signer: Ed25519Sign)

/** One stored mailbox item: an envelope as `.com` keeps it. */
data class VoiciInboxItem(val envelope: JsonObject, val storedAt: Long, val fetched: Boolean, val direct: Boolean)

data class VoiciInboxPage(val items: List<VoiciInboxItem>, val cursor: String, val blocks: List<String>, val revoked: List<String>, val more: Boolean = false)

data class VoiciDraftItem(val envelope: JsonObject, val at: Long)

/** The account's public keys from `GET /api/username/<u>`: the sensitive key is the admin root, else the IRK. */
data class VoiciAccountKeys(val irkPub: String, val adminRootPub: String?) {
    val sensitiveKind: String get() = if (adminRootPub != null) "admin-root" else "irk"
    val sensitivePub: String get() = adminRootPub ?: irkPub
}

interface VoiciClient {
    suspend fun accountKeys(username: String): VoiciAccountKeys?
    suspend fun page(username: String): JsonObject?
    suspend fun piece(username: String, pageId: String, sha256: String): ByteArray?
    suspend fun uploadPiece(username: String, pageId: String, sha256: String, size: Long, issuedAt: Long, signerPub: String, signature: String, bytes: ByteArray, contentType: String)
    /** The stored index, or [VoiciHttpError] (409 `seq-conflict` carries the stored `index`). */
    suspend fun publish(username: String, index: JsonObject): JsonObject
    suspend fun depositDraft(username: String, device: VoiciDeviceSigner, envelope: JsonObject)
    suspend fun drafts(username: String): List<VoiciDraftItem>
    suspend fun consumeDrafts(username: String, body: JsonObject)
    suspend fun inbox(username: String, since: String): VoiciInboxPage
    suspend fun send(envelope: JsonObject, direct: Boolean = false)
    suspend fun block(username: String, body: JsonObject)
    suspend fun revoke(body: JsonObject)
    suspend fun report(body: JsonObject)
    /** The sealed state blob `{version, nonce, ct}` or null when none is stored. */
    suspend fun messagesState(username: String): JsonObject?
    /** PUT; [VoiciHttpError] 409 `version-conflict` carries the stored `state`. */
    suspend fun putMessagesState(username: String, device: VoiciDeviceSigner, blob: JsonObject)
    suspend fun attest(username: String, device: VoiciDeviceSigner, body: JsonObject): JsonObject
    /** The account's device grants (`/api/users/<u>/device-grants`, read token). */
    suspend fun deviceGrants(username: String): List<JsonObject>
    /** The visitor's own thread (§8.3), signed by a delegated P-256 key: items, the next cursor, more. */
    suspend fun thread(body: JsonObject): Triple<List<VoiciInboxItem>, String, Boolean>

    /** `GET https://<u>.<apex>/api/phone/live` (2 s): the answer or null. */
    suspend fun phoneLive(username: String): JsonObject?
    /** `POST https://<u>.<apex>/api/phone/deliver`: the ack JSON or null when the phone didn't take it. */
    suspend fun phoneDeliver(username: String, envelope: JsonObject): JsonObject?
}

class LiveVoiciClient(
    private val transport: JsonHttpTransport,
    private val phone: okhttp3.OkHttpClient,
    private val base: () -> String = { Endpoints.controlBaseUrl.trimEnd('/') },
    private val now: () -> Long = System::currentTimeMillis,
) : VoiciClient {
    private val rng = SecureRandom()
    private fun enc(s: String) = URLEncoder.encode(s.lowercase(), "UTF-8")
    private fun parse(b: ByteArray): JsonObject? = runCatching { Json.parseToJsonElement(b.decodeToString()) as? JsonObject }.getOrNull()

    private suspend fun <T> call(block: suspend () -> T): T = try {
        block()
    } catch (e: HttpException) {
        val body = runCatching { Json.parseToJsonElement(e.body) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
        throw VoiciHttpError(e.status, (body["code"] as? JsonPrimitive)?.contentOrNull, body)
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

    private suspend fun postJson(url: String, body: JsonElement, headers: Map<String, String> = emptyMap()): JsonObject? = call {
        val r = transport.execute("POST", url, body.toString().toByteArray(), "application/json; charset=utf-8", headers, setOf(200, 201, 204))
        if (r.body.isEmpty()) null else parse(r.body)
    }

    override suspend fun accountKeys(username: String): VoiciAccountKeys? = runCatching {
        val r = transport.execute("GET", "${base()}/api/username/${enc(username)}", accept = setOf(200))
        val o = parse(r.body) ?: return null
        val irk = (o["irkPub"] as? JsonPrimitive)?.contentOrNull?.lowercase() ?: return null
        VoiciAccountKeys(irk, (o["adminRootPub"] as? JsonPrimitive)?.contentOrNull?.lowercase())
    }.getOrNull()

    override suspend fun page(username: String): JsonObject? = call {
        val r = transport.execute("GET", "${base()}/api/voici/pages/${enc(username)}", accept = setOf(200, 404))
        if (r.status == 404) null else parse(r.body)?.get("index") as? JsonObject
    }

    override suspend fun piece(username: String, pageId: String, sha256: String): ByteArray? = runCatching {
        transport.execute("GET", "${base()}/api/voici/pages/${enc(username)}/pieces/$sha256", accept = setOf(200)).body
    }.getOrNull()

    override suspend fun uploadPiece(username: String, pageId: String, sha256: String, size: Long, issuedAt: Long, signerPub: String, signature: String, bytes: ByteArray, contentType: String) {
        call {
            transport.execute(
                "POST", "${base()}/api/voici/pages/${enc(username)}/pieces", bytes, contentType,
                mapOf(
                    "x-flagship-page-id" to pageId,
                    "x-flagship-sha256" to sha256,
                    "x-flagship-size" to size.toString(),
                    "x-flagship-issued-at" to issuedAt.toString(),
                    "x-flagship-signer-pub" to signerPub,
                    "x-flagship-signature" to signature,
                ),
                setOf(200, 201, 204),
            )
        }
    }

    override suspend fun publish(username: String, index: JsonObject): JsonObject =
        postJson("${base()}/api/voici/pages/${enc(username)}/publish", JsonObject(mapOf("index" to index)))?.get("index") as? JsonObject ?: index

    override suspend fun depositDraft(username: String, device: VoiciDeviceSigner, envelope: JsonObject) {
        val path = "/api/accounts/${enc(username)}/voici-drafts"
        postJson(base() + path, JsonObject(mapOf("envelope" to envelope)), deviceHeaders(username, device, "POST", path))
    }

    override suspend fun drafts(username: String): List<VoiciDraftItem> = call {
        AccountReadTokens.authorize(username) { auth ->
            val r = transport.execute("GET", "${base()}/api/accounts/${enc(username)}/voici-drafts", extraHeaders = auth, accept = setOf(200))
            // `{drafts:[envelope]}` (B1), also `{drafts:[{envelope, ...}]}`.
            (parse(r.body)?.get("drafts") as? JsonArray).orEmpty().mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                val env = (o["envelope"] as? JsonObject) ?: o.takeIf { it.containsKey("kind") } ?: return@mapNotNull null
                VoiciDraftItem(env, ((o["createdAt"] ?: o["at"]) as? JsonPrimitive)?.longOrNull ?: 0)
            }
        }
    }

    override suspend fun consumeDrafts(username: String, body: JsonObject) {
        postJson("${base()}/api/accounts/${enc(username)}/voici-drafts/consume", body)
    }

    override suspend fun inbox(username: String, since: String): VoiciInboxPage = call {
        AccountReadTokens.authorize(username) { auth ->
            val r = transport.execute("GET", "${base()}/api/voici/pages/${enc(username)}/inbox?since=${URLEncoder.encode(since, "UTF-8")}", extraHeaders = auth, accept = setOf(200))
            parseInbox(parse(r.body) ?: JsonObject(emptyMap()), since)
        }
    }

    override suspend fun send(envelope: JsonObject, direct: Boolean) {
        val body = if (direct) JsonObject(mapOf("envelope" to envelope, "direct" to JsonPrimitive(true))) else JsonObject(mapOf("envelope" to envelope))
        postJson("${base()}/api/voici/web/send", body)
    }

    override suspend fun block(username: String, body: JsonObject) {
        postJson("${base()}/api/voici/pages/${enc(username)}/block", body)
    }

    override suspend fun revoke(body: JsonObject) {
        postJson("${base()}/api/voici/web/revoke", body)
    }

    override suspend fun report(body: JsonObject) {
        postJson("${base()}/api/voici/reports", body)
    }

    override suspend fun messagesState(username: String): JsonObject? = call {
        AccountReadTokens.authorize(username) { auth ->
            val r = transport.execute("GET", "${base()}/api/accounts/${enc(username)}/messages-state", extraHeaders = auth, accept = setOf(200, 404))
            // The blob itself (B1), or `{state}`.
            if (r.status == 404) null else parse(r.body)?.let { (it["state"] as? JsonObject) ?: it.takeIf { o -> o.containsKey("version") } }
        }
    }

    override suspend fun putMessagesState(username: String, device: VoiciDeviceSigner, blob: JsonObject) {
        val path = "/api/accounts/${enc(username)}/messages-state"
        call {
            transport.execute("PUT", base() + path, JsonObject(mapOf("state" to blob)).toString().toByteArray(), "application/json; charset=utf-8", deviceHeaders(username, device, "PUT", path), setOf(200, 204))
        }
    }

    override suspend fun attest(username: String, device: VoiciDeviceSigner, body: JsonObject): JsonObject {
        val path = "/api/accounts/${enc(username)}/messages-attestation"
        return postJson(base() + path, body, deviceHeaders(username, device, "POST", path))?.get("attestation") as? JsonObject
            ?: throw VoiciHttpError(502, "malformed", JsonObject(emptyMap()))
    }

    override suspend fun thread(body: JsonObject): Triple<List<VoiciInboxItem>, String, Boolean> {
        val o = postJson("${base()}/api/voici/web/thread", body) ?: JsonObject(emptyMap())
        val since = (body["since"] as? JsonPrimitive)?.contentOrNull ?: ""
        val page = parseInbox(o, since)
        val next = (o["next"] as? JsonPrimitive)?.contentOrNull?.takeIf { Regex("^[A-Za-z0-9_-]{0,64}$").matches(it) } ?: since
        return Triple(page.items, next, page.more)
    }

    override suspend fun deviceGrants(username: String): List<JsonObject> = call {
        AccountReadTokens.authorize(username) { auth ->
            val r = transport.execute("GET", "${base()}/api/users/${enc(username)}/device-grants", extraHeaders = auth, accept = setOf(200))
            (parse(r.body)?.get("grants") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        }
    }

    private fun phoneUrl(username: String, path: String) = "https://${Endpoints.userZoneHost(username.lowercase())}$path"

    override suspend fun phoneLive(username: String): JsonObject? = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        runCatching {
            val quick = phone.newBuilder().callTimeout(2, java.util.concurrent.TimeUnit.SECONDS).build()
            quick.newCall(okhttp3.Request.Builder().url(phoneUrl(username, "/api/phone/live")).get().build()).execute().use { r ->
                if (!r.isSuccessful) null else parse(r.body?.bytes() ?: ByteArray(0))
            }
        }.getOrNull()
    }

    override suspend fun phoneDeliver(username: String, envelope: JsonObject): JsonObject? = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        runCatching {
            val quick = phone.newBuilder().callTimeout(10, java.util.concurrent.TimeUnit.SECONDS).build()
            val body = envelope.toString().toByteArray().toRequestBody(null)
            val req = okhttp3.Request.Builder().url(phoneUrl(username, "/api/phone/deliver"))
                .post(body).header("content-type", "application/flagship-envelope+json").build()
            quick.newCall(req).execute().use { r ->
                if (!r.isSuccessful) null else parse(r.body?.bytes() ?: ByteArray(0))?.get("ack") as? JsonObject
            }
        }.getOrNull()
    }

    companion object {
        fun parseInbox(o: JsonObject, since: String): VoiciInboxPage {
            fun strs(k: String) = (o[k] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            val items = (o["items"] as? JsonArray).orEmpty().mapNotNull { e ->
                val it = e as? JsonObject ?: return@mapNotNull null
                val env = it["envelope"] as? JsonObject ?: return@mapNotNull null
                fun bool(k: String) = (it[k] as? JsonPrimitive)?.contentOrNull == "true"
                val fetched = bool("fetched") || ((it["fetchedAt"] as? JsonPrimitive)?.longOrNull != null)
                VoiciInboxItem(env, (it["storedAt"] as? JsonPrimitive)?.longOrNull ?: 0, fetched, bool("direct"))
            }
            val cursor = (o["cursor"] as? JsonPrimitive)?.contentOrNull?.takeIf { CURSOR.matches(it) } ?: since
            val more = (o["more"] as? JsonPrimitive)?.contentOrNull == "true"
            return VoiciInboxPage(items, cursor, strs("blocks"), strs("revoked"), more)
        }

        private val CURSOR = Regex("^[A-Za-z0-9_-]{0,64}$")
    }
}
