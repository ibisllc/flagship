// Free AI credits: a short-lived Flagship AI credential the box uses when the
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

@Serializable
data class FreeAiCreditsInfo(
    val usedTokens: Long = 0,
    val allowanceTokens: Long = 0,
    val remainingTokens: Long = 0,
)

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
    data class Unavailable(val message: String) : FreeAiMint()
}

/** What to do before a reply to a build on free AI credits. */
sealed class FreeAiRefresh {
    object None : FreeAiRefresh()
    data class Fresh(val credential: AiCredential) : FreeAiRefresh()
    data class Stop(val message: String) : FreeAiRefresh()
}

/** What the free-credits card / key-step row shows. */
sealed class FreeAiState {
    /** Not asked yet, or the read failed: show nothing. */
    object Hidden : FreeAiState()
    object Unavailable : FreeAiState()
    data class Available(val credits: FreeAiCreditsInfo) : FreeAiState() {
        val usedUp: Boolean get() = credits.remainingTokens <= 0
    }
}

/** Copy + number formatting, shared with the webapp and iOS. */
object FreeAiCopy {
    const val TITLE = "Free AI credits"
    const val NOTE = "Used automatically when you build with AI and haven't added your own key."
    const val USED_UP = "You've used your free AI credits. Add your own AI key to keep building."
    const val UNAVAILABLE = "Free AI credits aren't available right now. You can add your own AI key."
    const val ADD_OWN_KEY = "Add your own key"
    const val CODE_USED_UP = "free-ai-used-up"
    const val CODE_UNAVAILABLE = "free-ai-unavailable"

    /** 820000 → "820k", 1000000 → "1M", 1500000 → "1.5M". */
    fun tokens(n: Long): String {
        val v = if (n < 0) 0L else n
        return when {
            v < 1_000 -> v.toString()
            v < 1_000_000 -> "${Math.round(v / 1_000.0)}k"
            else -> {
                val m = Math.round(v / 100_000.0) / 10.0
                val s = if (m == Math.floor(m)) m.toLong().toString() else m.toString()
                "${s}M"
            }
        }
    }

    fun leftLine(c: FreeAiCreditsInfo): String =
        "${tokens(c.remainingTokens)} of ${tokens(c.allowanceTokens)} free AI tokens left"

    fun rowSubtitle(c: FreeAiCreditsInfo): String = "${tokens(c.remainingTokens)} left"
}

/** HTTP client for the two `.com` free-AI endpoints. */
class FreeAiClient(
    private val transport: JsonHttpTransport = OkHttpJsonTransport(),
    private val baseUrl: () -> String = { Endpoints.controlBaseUrl },
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    suspend fun token(body: FreeAiSignedBody): FreeAiMint {
        val resp = try {
            transport.execute(
                method = "POST",
                url = "${baseUrl()}/api/free-ai/token",
                body = json.encodeToString(FreeAiSignedBody.serializer(), body).toByteArray(Charsets.UTF_8),
                contentType = "application/json",
                accept = setOf(200),
            )
        } catch (e: HttpException) {
            val err = runCatching { json.decodeFromString(FreeAiErrorBody.serializer(), e.body) }.getOrNull()
            return when {
                e.status == 429 || err?.code == FreeAiCopy.CODE_USED_UP ->
                    FreeAiMint.UsedUp(err?.error ?: FreeAiCopy.USED_UP, err?.credits)
                e.status == 503 || err?.code == FreeAiCopy.CODE_UNAVAILABLE ->
                    FreeAiMint.Unavailable(err?.error ?: FreeAiCopy.UNAVAILABLE)
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
    suspend fun status(body: FreeAiSignedBody): FreeAiStatusResponse {
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
        com.flagshipserver.app.keystore.Keystore.deriveIRK(reason = "Use your free AI credits")
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

    /** The card's state; [FreeAiState.Hidden] on any failure. */
    suspend fun status(): FreeAiState {
        val user = username()?.takeIf { it.isNotEmpty() } ?: return FreeAiState.Hidden
        return try {
            val r = client.status(FreeAiRequest.sign(signer(), user, "", now()))
            when {
                !r.available -> FreeAiState.Unavailable
                r.credits != null -> FreeAiState.Available(r.credits)
                else -> FreeAiState.Hidden
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            FreeAiState.Hidden
        }
    }

    /**
     * Before a follow-up reply to [sessionId]: a fresh credential when the
     * build runs on free AI credits ([FreeAiRefresh.None] otherwise), or the
     * message to show instead of sending.
     */
    suspend fun refreshFor(sessionId: String): FreeAiRefresh {
        val server = FreeAiSessions.serverFor(sessionId) ?: return FreeAiRefresh.None
        return when (val r = runCatching { mint(server) }.getOrElse { FreeAiMint.Unavailable(FreeAiCopy.UNAVAILABLE) }) {
            is FreeAiMint.Ok -> FreeAiRefresh.Fresh(r.credential)
            is FreeAiMint.UsedUp -> FreeAiRefresh.Stop(r.message)
            is FreeAiMint.Unavailable -> FreeAiRefresh.Stop(r.message)
        }
    }

    companion object {
        /** On by default: no saved key of their own and credits left. */
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
