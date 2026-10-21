// Flagship Inference: a short-lived Flagship AI credential the box uses when the
// owner hasn't added their own AI key. Kotlin mirror of the webapp's
// lib/freeAi.js and iOS FreeAiCredits.
//
// The phone signs a `flagship/llm-promo-issue/v1` request with the account
// IRK and posts it to flagshipserver.com:
//
//   POST /api/free-ai/token   → a credential for one box (12 h), + credits
//   POST /api/free-ai/status  → { available, credits } (serverFqdn "")
//
// packages/protocol/test-vectors/llm-promo-issue/vectors.json is the
// reference; FreeAiVectorsTest runs every case. Nothing is sold: when the
// credits run out the owner adds their own key.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The free-AI request envelope (canonical bytes). */
object FreeAiRequest {
    const val CANONICAL_TAG = "flagship/llm-promo-issue/v1"
    const val PROVIDER = "flagship"

    fun canonicalBytes(
        username: String,
        serverFqdn: String,
        issuedAt: Long,
        provider: String = PROVIDER,
        desiredDailyInputTokenCap: Long = 0,
        desiredDailyOutputTokenCap: Long = 0,
    ): ByteArray {
        require(!username.contains('|') && !serverFqdn.contains('|')) { "field contains '|'" }
        return listOf(
            CANONICAL_TAG,
            username,
            serverFqdn,
            provider,
            desiredDailyInputTokenCap.toString(),
            desiredDailyOutputTokenCap.toString(),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun sign(key: Ed25519Sign, username: String, serverFqdn: String, issuedAt: Long): FreeAiSignedBody {
        val sig = key.sign(canonicalBytes(username, serverFqdn, issuedAt))
        return FreeAiSignedBody(
            request = FreeAiSignedBody.Inner(username = username, serverFqdn = serverFqdn, issuedAt = issuedAt),
            signature = HexUtil.encode(sig),
        )
    }
}

@Serializable
data class FreeAiSignedBody(val request: Inner, val signature: String) {
    @Serializable
    data class Inner(
        val username: String,
        val serverFqdn: String,
        val provider: String = FreeAiRequest.PROVIDER,
        val desiredDailyInputTokenCap: Long = 0,
        val desiredDailyOutputTokenCap: Long = 0,
        val issuedAt: Long,
    )
}

/** This ISO week's top-up (resets Monday 00:00 UTC, doesn't carry over). */
@Serializable
data class FreeAiWeek(
    val used: Long = 0,
    val allowance: Long = 0,
    val remaining: Long = 0,
    val resetsAt: Long? = null,
)

/** The one-time starter reserve, spent after the week's top-up. */
@Serializable
data class FreeAiStarter(
    val used: Long = 0,
    val allowance: Long = 0,
    val remaining: Long = 0,
)

/**
 * Totals across both, plus the two parts and the credit numbers (absent from
 * an older `.com`). The apps show credits: one credit is 1,000 weighted tokens.
 */
@Serializable
data class FreeAiCreditsInfo(
    val usedTokens: Long = 0,
    val allowanceTokens: Long = 0,
    val remainingTokens: Long = 0,
    val week: FreeAiWeek? = null,
    val starter: FreeAiStarter? = null,
    /** The week's and the starter's credits left together. */
    val remainingCredits: Long? = null,
    /** The weekly top-up in credits. */
    val weeklyCredits: Long? = null,
    val tokensPerCredit: Long? = null,
) {
    private val perCredit: Long get() = tokensPerCredit?.takeIf { it > 0 } ?: DEFAULT_TOKENS_PER_CREDIT

    /** Credits left: `.com`'s number, or converted from tokens (older `.com`). */
    val creditsLeft: Long get() = remainingCredits?.coerceAtLeast(0) ?: (remainingTokens.coerceAtLeast(0) / perCredit)

    /** The weekly top-up in credits, null when `.com` doesn't say. */
    val creditsPerWeek: Long? get() = weeklyCredits?.coerceAtLeast(0) ?: week?.let { it.allowance.coerceAtLeast(0) / perCredit }

    companion object {
        const val DEFAULT_TOKENS_PER_CREDIT = 1_000L
    }
}

@Serializable
data class FreeAiWireCredential(
    val provider: String,
    val apiKey: String,
    val baseUrl: String? = null,
    val source: String? = null,
    val relay: Boolean = true,
)

@Serializable
data class FreeAiTokenResponse(
    val ok: Boolean = false,
    val credential: FreeAiWireCredential? = null,
    val model: String? = null,
    val expiresAt: Long = 0,
    val credits: FreeAiCreditsInfo? = null,
)

@Serializable
data class FreeAiStatusResponse(
    val available: Boolean = false,
    /** The promotion has ended: the apps hide free AI. */
    val ended: Boolean = false,
    /** What stops free AI right now: "no-server" or "busy-today". */
    val reason: String? = null,
    val message: String? = null,
    val credits: FreeAiCreditsInfo? = null,
)

@Serializable
data class FreeAiErrorBody(
    val error: String? = null,
    val code: String? = null,
    val credits: FreeAiCreditsInfo? = null,
)

/** The outcome of asking for a free-AI credential. */
sealed class FreeAiMint {
    data class Ok(val credential: AiCredential, val credits: FreeAiCreditsInfo?) : FreeAiMint()
    data class UsedUp(val message: String, val credits: FreeAiCreditsInfo?) : FreeAiMint()
    /** Busy today, no running server, too big, rate-limited, or the promotion has ended ([code]). */
    data class Refused(val code: String, val message: String) : FreeAiMint()
    data class Unavailable(val message: String) : FreeAiMint()
}

/** What to do before a reply to a build on free AI credits. */
sealed class FreeAiRefresh {
    object None : FreeAiRefresh()
    data class Fresh(val credential: AiCredential) : FreeAiRefresh()
    data class Stop(val message: String) : FreeAiRefresh()
}

/** What the Flagship Inference entry shows. */
sealed class FreeAiState {
    /** Not asked yet (the entry shows that it's checking). */
    object Hidden : FreeAiState()
    /** The read failed, or `.com` says free AI is off right now. */
    object Unavailable : FreeAiState()
    /** The promotion has ended: the entry stays, disabled. */
    object Ended : FreeAiState()
    /** Free AI can't be used right now ("no-server", "busy-today"). */
    data class Blocked(val reason: String) : FreeAiState()
    /** `.com`'s rate limiter refused the read or the pass: [message] says when to try again. */
    data class Limited(val message: String) : FreeAiState()
    data class Available(val credits: FreeAiCreditsInfo) : FreeAiState() {
        val usedUp: Boolean get() = credits.remainingTokens <= 0
    }
}

/** What the card / key-step row shows (mirror of the webapp's freeAiView). */
data class FreeAiView(val usable: Boolean, val text: String, val offerOwnKey: Boolean)

/**
 * The always-present Flagship Inference entry: [status] is the muted line
 * under the subtitle; [loading] while the balance is being read. Mirror of the
 * webapp `flagshipInferenceEntry` and iOS `FlagshipInferenceEntry`.
 */
data class FlagshipInferenceEntry(
    val usable: Boolean,
    val status: String,
    val offerOwnKey: Boolean,
    val loading: Boolean = false,
)

/** Copy + number formatting, shared with the webapp and iOS. */
object FreeAiCopy {
    /** The built-in provider entry, listed first in every key list. */
    val PROVIDER_TITLE get() = FSStrings.get(R.string.flagship_inference)
    val PROVIDER_SUBTITLE get() = FSStrings.get(R.string.we_use_third_party_providers_and)
    val BUILT_IN_A11Y get() = FSStrings.get(R.string.built_in_provider_it_cant_be)
    val CHECKING get() = FSStrings.get(R.string.checking)
    val TITLE get() = FSStrings.get(R.string.flagship_inference)
    val USE_BUTTON get() = FSStrings.get(R.string.use_flagship_inference)
    val NOTE get() = FSStrings.get(R.string.used_automatically_when_you_build_with)
    val USED_UP get() =
        FSStrings.get(R.string.youve_used_this_weeks_flagship_inference)
    val UNAVAILABLE get() = FSStrings.get(R.string.flagship_inference_isnt_available_right_now)
    val BUSY_TODAY get() = FSStrings.get(R.string.flagship_inference_is_busy_today_try)
    val NO_SERVER get() = FSStrings.get(R.string.flagship_inference_starts_once_one_of)
    val ENDED get() = FSStrings.get(R.string.the_free_building_period_has_ended)
    val TOO_LONG get() = FSStrings.get(R.string.this_build_is_too_big_for)
    val ADD_OWN_KEY get() = FSStrings.get(R.string.add_your_own_key)
    const val CODE_USED_UP = "free-ai-used-up"
    const val CODE_UNAVAILABLE = "free-ai-unavailable"
    const val CODE_BUSY_TODAY = "free-ai-busy-today"
    const val CODE_NO_SERVER = "free-ai-no-server"
    const val CODE_ENDED = "free-ai-ended"
    const val CODE_TOO_LONG = "free-ai-too-long"
    /** `.com`'s rate limiter, not a free-AI refusal: the message is the limiter's sentence. */
    const val CODE_RATE_LIMITED = RateLimitedException.ERROR_CODE

    /** The app's own words for a `free-ai-…` code, or null for an unknown one. */
    fun messageFor(code: String?): String? = when (code) {
        CODE_USED_UP -> USED_UP
        CODE_UNAVAILABLE -> UNAVAILABLE
        CODE_BUSY_TODAY -> BUSY_TODAY
        CODE_NO_SERVER -> NO_SERVER
        CODE_ENDED -> ENDED
        CODE_TOO_LONG -> TOO_LONG
        else -> null
    }

    /** What the screen reader says for the Flagship Inference entry. */
    val A11Y_LABEL get() = "$PROVIDER_TITLE. $BUILT_IN_A11Y"

    /** Null before the first read. */
    fun view(state: FreeAiState): FreeAiView? = when (state) {
        is FreeAiState.Hidden -> null
        is FreeAiState.Unavailable -> FreeAiView(false, UNAVAILABLE, true)
        is FreeAiState.Ended -> FreeAiView(false, ENDED, true)
        is FreeAiState.Limited -> FreeAiView(false, state.message, true)
        is FreeAiState.Blocked ->
            FreeAiView(false, messageFor("free-ai-${state.reason}") ?: UNAVAILABLE, state.reason != "no-server")
        is FreeAiState.Available ->
            if (state.usedUp) FreeAiView(false, USED_UP, true) else FreeAiView(true, leftLine(state.credits), false)
    }

    /**
     * The Flagship Inference entry for [state]; never null, so the entry is
     * always listed. Settings and the key step show the same balance line.
     */
    fun entry(state: FreeAiState): FlagshipInferenceEntry {
        val v = view(state) ?: return FlagshipInferenceEntry(false, CHECKING, false, loading = true)
        return FlagshipInferenceEntry(v.usable, v.text, v.offerOwnKey)
    }

    /** A whole number with the locale's thousands separators: 1840 → "1,840". */
    fun credits(n: Long, locale: java.util.Locale = java.util.Locale.getDefault()): String =
        java.text.NumberFormat.getIntegerInstance(locale).format(n.coerceAtLeast(0))

    /**
     * "1,840 free credits left · 500 added each week" ("1,840 free credits
     * left" from an older `.com` without the weekly split). The only line that
     * says "free", so it can go when the promotion ends.
     */
    fun leftLine(c: FreeAiCreditsInfo, locale: java.util.Locale = java.util.Locale.getDefault()): String {
        val left = FSStrings.get(R.string.free_credits_left, credits(c.creditsLeft, locale))
        val weekly = c.creditsPerWeek ?: return left
        return FSStrings.get(R.string.added_each_week, left, credits(weekly, locale))
    }
}

/** HTTP client for the two `.com` free-AI endpoints. */
open class FreeAiClient(
    private val transport: JsonHttpTransport = OkHttpJsonTransport(),
    private val baseUrl: () -> String = { Endpoints.controlBaseUrl },
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    open suspend fun token(body: FreeAiSignedBody): FreeAiMint {
        val resp = try {
            transport.execute(
                method = "POST",
                url = "${baseUrl()}/api/free-ai/token",
                body = json.encodeToString(FreeAiSignedBody.serializer(), body).toByteArray(Charsets.UTF_8),
                contentType = "application/json",
                accept = setOf(200),
            )
        } catch (e: HttpException) {
            RateLimitedException.from(e)?.let {
                return FreeAiMint.Refused(FreeAiCopy.CODE_RATE_LIMITED, it.userMessage)
            }
            val err = runCatching { json.decodeFromString(FreeAiErrorBody.serializer(), e.body) }.getOrNull()
            // By code first: a 429 is also "busy today", not only "used up".
            val code = err?.code ?: when (e.status) {
                429 -> FreeAiCopy.CODE_USED_UP
                503 -> FreeAiCopy.CODE_UNAVAILABLE
                else -> null
            }
            val message = err?.error ?: FreeAiCopy.messageFor(code)
            return when (code) {
                FreeAiCopy.CODE_USED_UP -> FreeAiMint.UsedUp(message ?: FreeAiCopy.USED_UP, err?.credits)
                FreeAiCopy.CODE_UNAVAILABLE -> FreeAiMint.Unavailable(message ?: FreeAiCopy.UNAVAILABLE)
                FreeAiCopy.CODE_BUSY_TODAY, FreeAiCopy.CODE_NO_SERVER, FreeAiCopy.CODE_ENDED, FreeAiCopy.CODE_TOO_LONG ->
                    FreeAiMint.Refused(code, message ?: FreeAiCopy.UNAVAILABLE)
                else -> throw e
            }
        }
        val parsed = json.decodeFromString(FreeAiTokenResponse.serializer(), String(resp.body, Charsets.UTF_8))
        val c = parsed.credential ?: return FreeAiMint.Unavailable(FreeAiCopy.UNAVAILABLE)
        return FreeAiMint.Ok(
            AiCredential(
                provider = c.provider,
                apiKey = c.apiKey,
                baseUrl = c.baseUrl,
                relay = c.relay,
                source = c.source ?: "promo",
                model = parsed.model,
            ),
            parsed.credits,
        )
    }

    // Encoded with this client's `json` (encodeDefaults on): `.com` needs the
    // provider and both caps on the wire, and they are default values here.
    open suspend fun status(body: FreeAiSignedBody): FreeAiStatusResponse {
        val resp = transport.execute(
            method = "POST",
            url = "${baseUrl()}/api/free-ai/status",
            body = json.encodeToString(FreeAiSignedBody.serializer(), body).toByteArray(Charsets.UTF_8),
            contentType = "application/json",
            accept = setOf(200),
        )
        return json.decodeFromString(FreeAiStatusResponse.serializer(), String(resp.body, Charsets.UTF_8))
    }
}

/**
 * Signs and sends the free-AI requests for the signed-in account. The signer
 * is the account IRK (the key `.com` holds for push registration too); in an
 * unlocked session it doesn't prompt again.
 */
class FreeAiService(
    private val client: FreeAiClient = FreeAiClient(),
    private val signer: suspend () -> Ed25519Sign = {
        com.flagshipserver.app.keystore.Keystore.deriveIRK(reason = FSStrings.get(R.string.use_flagship_inference_2))
    },
    private val username: () -> String? = { null },
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** A fresh credential for [serverFqdn] (the box the build runs on). */
    suspend fun mint(serverFqdn: String): FreeAiMint {
        val user = username()?.takeIf { it.isNotEmpty() }
            ?: return FreeAiMint.Unavailable(FreeAiCopy.UNAVAILABLE)
        return client.token(FreeAiRequest.sign(signer(), user, serverFqdn, now()))
    }

    /** The entry's state; [FreeAiState.Unavailable] on any failure. */
    suspend fun status(): FreeAiState {
        val user = username()?.takeIf { it.isNotEmpty() } ?: return FreeAiState.Unavailable
        return try {
            val r = client.status(FreeAiRequest.sign(signer(), user, "", now()))
            when {
                r.ended -> FreeAiState.Ended
                !r.available -> FreeAiState.Unavailable
                r.reason != null -> FreeAiState.Blocked(r.reason)
                r.credits != null -> FreeAiState.Available(r.credits)
                else -> FreeAiState.Unavailable
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (t: Throwable) {
            RateLimitedException.messageOf(t)?.let { FreeAiState.Limited(it) } ?: FreeAiState.Unavailable
        }
    }

    /**
     * Before a follow-up reply to [sessionId]: a fresh credential when the
     * build runs on free AI credits ([FreeAiRefresh.None] otherwise), or the
     * message to show instead of sending.
     */
    suspend fun refreshFor(sessionId: String): FreeAiRefresh {
        val server = FreeAiSessions.serverFor(sessionId) ?: return FreeAiRefresh.None
        return passFor(server)
    }

    /** A fresh pass for a chat on [serverFqdn], e.g. one switching to Flagship
     *  Inference, or the message to show instead of sending. */
    suspend fun passFor(serverFqdn: String): FreeAiRefresh {
        if (serverFqdn.isEmpty()) return FreeAiRefresh.Stop(FreeAiCopy.UNAVAILABLE)
        return when (val r = runCatching { mint(serverFqdn) }.getOrElse { FreeAiMint.Unavailable(FreeAiCopy.UNAVAILABLE) }) {
            is FreeAiMint.Ok -> FreeAiRefresh.Fresh(r.credential)
            is FreeAiMint.UsedUp -> FreeAiRefresh.Stop(r.message)
            is FreeAiMint.Refused -> FreeAiRefresh.Stop(r.message)
            is FreeAiMint.Unavailable -> FreeAiRefresh.Stop(r.message)
        }
    }

    companion object {
        /** On by default: no saved key of their own, and free AI usable now
         *  (not ended, unavailable or blocked, with credits left). */
        fun shouldAutoUse(savedKeyCount: Int, state: FreeAiState): Boolean =
            savedKeyCount == 0 && state is FreeAiState.Available && !state.usedUp
    }
}

/**
 * Builds started on free AI credits, so a follow-up reply can re-mint a fresh
 * credential first (they last 12 h). sessionId → the box it runs on. In
 * memory only.
 */
object FreeAiSessions {
    private val byId = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun remember(sessionId: String, serverFqdn: String) {
        byId[sessionId] = serverFqdn
    }

    fun serverFor(sessionId: String): String? = byId[sessionId]

    fun forget(sessionId: String) {
        byId.remove(sessionId)
    }

    fun clear() = byId.clear()
}
