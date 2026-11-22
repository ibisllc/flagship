// The phone endpoint's voi.ci operations (docs/voici-and-messages.md §8.2): which website requests reach
// `/api/phone/deliver` and `/api/phone/live`, and the strict shape of the live answer. Kotlin twin of the
// phoneWebCheck / parsePhoneLiveAnswer / PHONE_WEB_ORIGINS section at the end of packages/protocol/src/phoneRoute.ts.
//
// Public API (object VoiciPhoneWeb): PHONE_WEB_ORIGINS, PHONE_WEB_ORIGINS_GYM, PHONE_DELIVER_PATH, PHONE_LIVE_PATH,
// PHONE_PIECE_PATH_PREFIX, PHONE_ENVELOPE_CONTENT_TYPE, PHONE_DELIVER_MAX_BYTES, PHONE_DELIVER_MAX_CONCURRENT,
// PHONE_DELIVER_PER_SENDER_PER_MINUTE, PHONE_DELIVER_PER_MINUTE, phoneWebCheck, parsePhoneLiveAnswer.
// Types PhoneWebRequest, PhoneWebVerdict (Preflight / Allowed / Piece / Refuse / Other, + toJson), PhoneLiveAnswer.

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class PhoneWebRequest(
    val method: String,
    /** Path without the query string. */
    val path: String,
    val host: String,
    val origin: String?,
    val contentType: String?,
    /** Access-Control-Request-Method / -Headers on a preflight, else null. */
    val acrMethod: String?,
    val acrHeaders: String?,
)

sealed class PhoneWebVerdict {
    data class Preflight(val headers: Map<String, String>) : PhoneWebVerdict() {
        val status: Int get() = 204
    }
    /** kind "live" or "deliver". */
    data class Allowed(val kind: String, val corsHeaders: Map<String, String>) : PhoneWebVerdict()
    /** GET /api/phone/voici-piece/<sha256>: the handler answers the piece's bytes or 404. */
    data class Piece(val sha256: String, val corsHeaders: Map<String, String>) : PhoneWebVerdict()
    data class Refuse(val status: Int, val code: String) : PhoneWebVerdict()
    /** No Origin and not one of the two operations: the endpoint's other rules apply. */
    object Other : PhoneWebVerdict()

    fun toJson(): JsonObject {
        fun m(h: Map<String, String>) = JsonObject(h.mapValues { JsonPrimitive(it.value) })
        return when (this) {
            is Preflight -> JsonObject(mapOf("kind" to JsonPrimitive("preflight"), "status" to JsonPrimitive(204), "headers" to m(headers)))
            is Allowed -> JsonObject(mapOf("kind" to JsonPrimitive(kind), "corsHeaders" to m(corsHeaders)))
            is Piece -> JsonObject(mapOf("kind" to JsonPrimitive("piece"), "sha256" to JsonPrimitive(sha256), "corsHeaders" to m(corsHeaders)))
            is Refuse -> JsonObject(mapOf("kind" to JsonPrimitive("refuse"), "status" to JsonPrimitive(status), "code" to JsonPrimitive(code)))
            Other -> JsonObject(mapOf("kind" to JsonPrimitive("other")))
        }
    }
}

data class PhoneLiveAnswer(val account: String, val ownerSignPub: String)

object VoiciPhoneWeb {
    val PHONE_WEB_ORIGINS: List<String> = listOf("https://voi.ci")
    val PHONE_WEB_ORIGINS_GYM: List<String> = listOf("https://gym.voi.ci")
    const val PHONE_DELIVER_PATH = "/api/phone/deliver"
    const val PHONE_LIVE_PATH = "/api/phone/live"
    /** A phone-only voi.ci piece (docs/voici-and-messages.md §2.7a): `GET <prefix><sha256 hex>`, a simple GET. */
    const val PHONE_PIECE_PATH_PREFIX = "/api/phone/voici-piece/"
    const val PHONE_ENVELOPE_CONTENT_TYPE = "application/flagship-envelope+json"
    const val PHONE_DELIVER_MAX_BYTES = 64 * 1024
    const val PHONE_DELIVER_MAX_CONCURRENT = 8
    const val PHONE_DELIVER_PER_SENDER_PER_MINUTE = 20
    const val PHONE_DELIVER_PER_MINUTE = 120

    private val ACCOUNT = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    private fun corsFor(origin: String?): Map<String, String> =
        if (origin == null) emptyMap() else linkedMapOf("Access-Control-Allow-Origin" to origin, "Vary" to "Origin")

    /**
     * Host exactly the phone's name (421); an Origin, when present, must be listed (403); `OPTIONS deliver` is a
     * preflight only for POST and exactly the content-type header (204, never Allow-Credentials); `GET live`;
     * `POST deliver` only with Content-Type exactly application/flagship-envelope+json (415); `GET voici-piece/<64
     * lowercase hex>` (404 for any other name under the prefix; never a preflight). Anything else with an Origin is 403. No cookie is read or set.
     */
    fun phoneWebCheck(r: PhoneWebRequest, hostname: String, origins: List<String>): PhoneWebVerdict {
        if (r.host.lowercase() != hostname.lowercase()) return PhoneWebVerdict.Refuse(421, "wrong-host")
        val method = r.method.uppercase()
        val listed = r.origin != null && r.origin in origins
        if (r.origin != null && !listed) return PhoneWebVerdict.Refuse(403, "origin")
        val isPiece = r.path.startsWith(PHONE_PIECE_PATH_PREFIX)
        val known = r.path == PHONE_DELIVER_PATH || r.path == PHONE_LIVE_PATH || isPiece
        if (method == "OPTIONS") {
            if (r.path != PHONE_DELIVER_PATH || !listed) return PhoneWebVerdict.Refuse(403, "preflight")
            val hdrs = (r.acrHeaders ?: "").split(",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            if (r.acrMethod?.uppercase() != "POST" || hdrs.size != 1 || hdrs[0] != "content-type") return PhoneWebVerdict.Refuse(403, "preflight")
            return PhoneWebVerdict.Preflight(
                linkedMapOf(
                    "Access-Control-Allow-Origin" to r.origin!!,
                    "Access-Control-Allow-Methods" to "POST",
                    "Access-Control-Allow-Headers" to "content-type",
                    "Access-Control-Max-Age" to "600",
                    "Vary" to "Origin",
                ),
            )
        }
        if (!known) return if (r.origin != null) PhoneWebVerdict.Refuse(403, "origin") else PhoneWebVerdict.Other
        if (r.path == PHONE_LIVE_PATH) {
            return if (method == "GET") PhoneWebVerdict.Allowed("live", corsFor(r.origin)) else PhoneWebVerdict.Refuse(405, "method")
        }
        if (isPiece) {
            if (method != "GET") return PhoneWebVerdict.Refuse(405, "method")
            val sha = r.path.removePrefix(PHONE_PIECE_PATH_PREFIX)
            if (!HEX64.matches(sha)) return PhoneWebVerdict.Refuse(404, "not-found")
            return PhoneWebVerdict.Piece(sha, corsFor(r.origin))
        }
        if (method != "POST") return PhoneWebVerdict.Refuse(405, "method")
        if (r.contentType != PHONE_ENVELOPE_CONTENT_TYPE) return PhoneWebVerdict.Refuse(415, "content-type")
        return PhoneWebVerdict.Allowed("deliver", corsFor(r.origin))
    }

    /** `GET /api/phone/live` answer: exactly {live:true, account, ownerSignPub}. */
    fun parsePhoneLiveAnswer(v: JsonElement?): PhoneLiveAnswer? {
        val o = VoiciJs.obj(v) ?: return null
        if (o.keys.sorted().joinToString(",") != "account,live,ownerSignPub" || !VoiciJs.isTrue(o["live"])) return null
        val account = VoiciJs.str(o["account"]) ?: return null
        val pub = VoiciJs.str(o["ownerSignPub"]) ?: return null
        if (!ACCOUNT.matches(account) || !HEX64.matches(pub)) return null
        return PhoneLiveAnswer(account, pub)
    }
}
