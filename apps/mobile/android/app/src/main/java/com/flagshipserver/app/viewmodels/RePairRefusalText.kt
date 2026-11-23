package com.flagshipserver.app.viewmodels

import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HttpException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * `.com`'s re-pair initiate refusals that carry a stable `code` (security
 * report F3, packages/control-plane/src/rePair.ts `RePairRefusalCode`) as
 * sentences. Mirrors the webapp's lib/rePairRefusal.js and iOS's
 * `RePairRefusalText`.
 */
object RePairRefusalText {
    val vetoedRecently get() = FSStrings.get(R.string.re_pair_refused_vetoed_recently)
    val replay get() = FSStrings.get(R.string.re_pair_refused_replay)
    val credentialUsed get() = FSStrings.get(R.string.re_pair_refused_credential_used)
    val stale get() = FSStrings.get(R.string.re_pair_refused_stale)

    private val json = Json { ignoreUnknownKeys = true }

    /** The `code` of a refused initiate's JSON body, if it has one. */
    fun codeOf(t: Throwable): String? {
        val body = (t as? HttpException)?.body ?: return null
        val obj = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
        return (obj["code"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

    /** The sentence for a code, or null when it is none of these. */
    fun text(code: String?): String? = when (code) {
        "re-pair-vetoed-recently" -> vetoedRecently
        "re-pair-replay", "re-pair-cancelled-replay" -> replay
        "re-pair-credential-used" -> credentialUsed
        "re-pair-stale" -> stale
        else -> null
    }

    /** The sentence for an initiate's refusal, or null when the error is something else. */
    fun refusal(t: Throwable): String? = text(codeOf(t))
}
