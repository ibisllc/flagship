// `.com`'s rate limiter answers every limited call with HTTP 429, a
// `Retry-After` header and
//   { error: "rate-limited", endpoint, limit: "ip"|"irk"|"usernameHash",
//     retryAfterSec, message }
// The app builds the sentence itself from `limit` + `retryAfterSec`, in the
// same words as apps/com/src/rateLimit.ts (rateLimitedMessage), so the person
// sees who is limited and when to try again on every screen.

package com.flagshipserver.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.ceil
import kotlin.math.roundToLong

object RateLimitCopy {
    const val FALLBACK = "Too many tries. Try again later."

    fun who(limit: String?): String? = when (limit) {
        "ip" -> "from your network"
        "irk" -> "from this account"
        "usernameHash" -> "for this account name"
        else -> null
    }

    fun retryAfterPhrase(sec: Long): String {
        if (sec < 60) return "in a minute"
        val min = ceil(sec / 60.0).toLong()
        if (min < 60) return "in about $min minute${if (min == 1L) "" else "s"}"
        val h = maxOf(1L, (min / 60.0).roundToLong())
        return "in about $h hour${if (h == 1L) "" else "s"}"
    }

    /** "Too many tries from your network. Try again in about 12 minutes.", or
     *  null when [limit] or [retryAfterSec] is missing or unknown. */
    fun sentence(limit: String?, retryAfterSec: Long?): String? {
        val w = who(limit) ?: return null
        val sec = retryAfterSec ?: return null
        return "Too many tries $w. Try again ${retryAfterPhrase(sec)}."
    }

    fun message(limit: String?, retryAfterSec: Long?, serverMessage: String?): String =
        sentence(limit, retryAfterSec)
            ?: serverMessage?.trim()?.takeIf { it.isNotEmpty() }
            ?: FALLBACK
}

/** `.com` refused a call with its rate limiter. Still an [HttpException] with
 *  status 429, so code that branches on the status keeps working; [message]
 *  is the sentence to show. */
class RateLimitedException(
    body: String,
    val endpoint: String?,
    val limit: String?,
    val retryAfterSec: Long?,
    val serverMessage: String?,
) : HttpException(429, body, RateLimitCopy.message(limit, retryAfterSec, serverMessage)) {
    val userMessage: String get() = message ?: RateLimitCopy.FALLBACK

    companion object {
        const val ERROR_CODE = "rate-limited"

        private val json = Json { ignoreUnknownKeys = true }

        /** The exception for a refused response, or null unless it is a 429
         *  whose body says `error: "rate-limited"`. */
        fun parse(status: Int, body: String, retryAfterHeader: String? = null): RateLimitedException? {
            if (status != 429) return null
            val obj = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
            if (obj.string("error") != ERROR_CODE) return null
            val sec = (obj["retryAfterSec"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
                ?: retryAfterHeader?.trim()?.toDoubleOrNull()
            return RateLimitedException(
                body = body,
                endpoint = obj.string("endpoint"),
                limit = obj.string("limit"),
                retryAfterSec = sec?.takeIf { it.isFinite() && it >= 0 }?.let { ceil(it).toLong() },
                serverMessage = obj.string("message"),
            )
        }

        /** The rate limit behind [t] (or one of its causes), also from a plain
         *  [HttpException] that carries the rate-limited body. */
        fun from(t: Throwable?): RateLimitedException? {
            var cur = t
            var depth = 0
            while (cur != null && depth < 8) {
                if (cur is RateLimitedException) return cur
                if (cur is HttpException) parse(cur.status, cur.body)?.let { return it }
                cur = cur.cause
                depth++
            }
            return null
        }

        /** The sentence for [t] when it is a rate limit, else null. */
        fun messageOf(t: Throwable?): String? = from(t)?.userMessage

        private fun JsonObject.string(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}
