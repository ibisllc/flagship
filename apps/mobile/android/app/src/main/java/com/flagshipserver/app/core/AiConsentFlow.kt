// The owner's consent to one AI run that spends their key or Flagship Inference credits (N12,
// packages/server-daemon/src/buildmodes/adaptConsent.ts). The box answers the run's first request
// with HTTP 428 {code:"ai-consent", estimate}; the app shows the estimate as it is (a token range,
// the provider, who pays) and, only on Continue, signs `flagship/ai-repair-consent/v1` and sends the
// same request once more with `consent`. Cancel sends nothing, so nothing runs. Wording matches the
// webapp's lib/aiConsentUi.js.

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import com.flagshipserver.app.api.ScreensError
import com.flagshipserver.app.api.boxError
import com.google.crypto.tink.subtle.Ed25519Sign
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** The `consent` object of the adapt request. */
@Serializable
data class AiConsentWire(
    val issuedAt: Long,
    val provider: String,
    val source: String,
    val highTokens: Long,
    val signature: String,
)

data class AiConsentEstimate(
    val provider: String,
    val source: AiRepairConsent.Source,
    val operation: AiRepairConsent.Operation,
    val lowTokens: Long,
    val highTokens: Long,
)

object AiConsent {
    /** The box's estimate from a refused run (428, or 403 when the consent sent no longer covers it). */
    fun estimate(t: Throwable): AiConsentEstimate? {
        val e = t as? ScreensError.Http ?: return null
        if (e.status != 428 && e.status != 403) return null
        val body = runCatching { Json.parseToJsonElement(e.body) as? JsonObject }.getOrNull() ?: return null
        if ((body["code"] as? JsonPrimitive)?.content != "ai-consent") return null
        val est = body["estimate"] as? JsonObject ?: return null
        val provider = (est["provider"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() } ?: return null
        val source = AiRepairConsent.Source.entries.firstOrNull { it.wire == (est["source"] as? JsonPrimitive)?.content } ?: return null
        val op = AiRepairConsent.Operation.entries.firstOrNull { it.wire == (est["operation"] as? JsonPrimitive)?.content } ?: return null
        val low = (est["lowTokens"] as? JsonPrimitive)?.longOrNull ?: return null
        val high = (est["highTokens"] as? JsonPrimitive)?.longOrNull ?: return null
        if (high < 1 || low < 0) return null
        return AiConsentEstimate(provider, source, op, low, high)
    }

    fun body(serverDomain: String, buildId: String, est: AiConsentEstimate, issuedAt: Long, signer: Ed25519Sign): AiConsentWire {
        val bytes = AiRepairConsent.canonicalBytes(serverDomain, buildId, est.operation, est.provider, est.source, est.highTokens, issuedAt)
        return AiConsentWire(issuedAt, est.provider, est.source.wire, est.highTokens, HexUtil.encode(signer.sign(bytes)))
    }

    fun providerName(provider: String): String = when (provider) {
        "anthropic" -> "Anthropic"
        "openai" -> "OpenAI"
        "google" -> "Google"
        "openrouter" -> "OpenRouter"
        "ollama" -> "Ollama"
        "flagship" -> "Flagship Inference"
        else -> provider
    }

    /** The signed most is enforced: the box stops the run there. */
    fun rangeText(est: AiConsentEstimate): String =
        FSStrings.get(R.string.ai_consent_cap, java.text.NumberFormat.getIntegerInstance().format(est.highTokens))

    fun payerText(est: AiConsentEstimate): String =
        if (est.source == AiRepairConsent.Source.PROMO) FSStrings.get(R.string.ai_consent_payer_promo)
        else FSStrings.get(R.string.ai_consent_payer_byok, providerName(est.provider))

    /**
     * Run [send] (a request that may spend AI). On the box's 428 the owner sees the estimate through
     * [prompt]; Continue signs a consent for exactly it and sends once more. Returns send's result, or
     * null when the owner said no. A second refusal (the estimate grew, the provider changed) asks
     * again with the box's reason, at most twice in all.
     */
    suspend fun <T> withConsent(
        prompt: AiConsentPrompt,
        buildId: String,
        serverDomain: suspend () -> String?,
        signer: suspend (reason: String) -> Ed25519Sign,
        now: () -> Long = { System.currentTimeMillis() },
        send: suspend (AiConsentWire?) -> T,
    ): T? {
        var consent: AiConsentWire? = null
        var round = 0
        while (true) {
            try {
                return send(consent)
            } catch (t: Throwable) {
                val est = estimate(t)
                if (est == null || round >= 2) throw t
                val note = if (round > 0) t.boxError().orEmpty() else ""
                round++
                if (!prompt.ask(est, note)) return null
                val domain = serverDomain()?.takeIf { it.isNotEmpty() } ?: throw t
                consent = body(domain, buildId, est, now(), signer(FSStrings.get(R.string.ai_consent_sign_reason)))
            }
        }
    }
}

/** The question the screen shows while a run waits for the owner. */
class AiConsentPrompt {
    class Ask(val estimate: AiConsentEstimate, val note: String, internal val answer: CompletableDeferred<Boolean>)

    private val _ask = MutableStateFlow<Ask?>(null)
    val ask: StateFlow<Ask?> = _ask.asStateFlow()

    suspend fun ask(estimate: AiConsentEstimate, note: String): Boolean {
        val a = Ask(estimate, note, CompletableDeferred())
        _ask.value = a
        return try {
            a.answer.await()
        } finally {
            if (_ask.value === a) _ask.value = null
        }
    }

    fun answer(agree: Boolean) {
        val a = _ask.value ?: return
        _ask.value = null
        a.answer.complete(agree)
    }
}
