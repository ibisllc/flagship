// Where private requests go, and what happens when our relay fails: the Kotlin twin of
// packages/protocol/src/ohttpPrivacy.ts, pinned by test-vectors/ohttp/spend-route.json.
//
// Owner rule (2026-11-17): if infrastructure we provide fails, everything keeps working. A relay outage never
// breaks a payment: a spend waits and retries, and goes direct (marked) rather than let a plan lapse.

package com.flagshipserver.app.core.ohttp

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.net.URI

/** One relay, in the order `.com` lists them. [interim]: run by Flagship until a third-party contract exists. */
data class OhttpRelayEntry(val url: String, val operator: String, val interim: Boolean)

/** `GET /api/ohttp/config` (also `ohttp` in `GET /api/payments/config`). */
data class OhttpPublicConfig(val keyConfigHex: String? = null, val relays: List<OhttpRelayEntry> = emptyList()) {
    val keyConfig: OhttpKeyConfig? get() = keyConfigHex?.let(Ohttp::keyConfigFromHex)

    companion object {
        val EMPTY = OhttpPublicConfig()
    }
}

/** What a private request is for; decides whether a relay outage may send it directly. */
enum class PrivateSpendKind(val wire: String) {
    INTERACTIVE("interactive"),
    TRICKLE("trickle"),
    OVERAGE("overage"),
    ;

    companion object {
        fun of(wire: String) = entries.first { it.wire == wire }
    }
}

object OhttpPrivacy {
    /** A trickle spend goes direct once the plan would lapse (end + grace) within this. */
    const val DIRECT_BEFORE_LAPSE_MS = 24 * 3_600_000L

    private val KEY_HEX = Regex("^([0-9a-f]{2})+$")

    /** Cloudflare's own names and our control apex: a relay there would share an operator with the gateway. */
    fun isForbiddenRelayHost(host: String, controlApex: String): Boolean {
        val h = host.lowercase().removeSuffix(".")
        val apex = controlApex.lowercase()
        fun under(d: String) = h == d || h.endsWith(".$d")
        return under(apex) || under("cloudflare.com") || under("cloudflare.net") || under("workers.dev") ||
            under("pages.dev") || under("cloudflare-gateway.com") || under("cloudflareclient.com")
    }

    private fun relayEntryOf(v: JsonElement?, controlApex: String?): OhttpRelayEntry? {
        val r = v as? JsonObject ?: return null
        val url = (r["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val operatorRaw = (r["operator"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val interim = (r["interim"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
        val u = runCatching { URI(url) }.getOrNull() ?: return null
        if (u.scheme?.lowercase() != "https" || u.host.isNullOrEmpty() || u.rawUserInfo != null || u.rawFragment != null) return null
        if (controlApex != null && isForbiddenRelayHost(u.host, controlApex)) return null
        val operator = operatorRaw.trim()
        if (operator.isEmpty() || operator.length > 80) return null
        return OhttpRelayEntry(url, operator, interim)
    }

    /**
     * Parse `.com`'s config. Bad relays are dropped one by one; a missing or bad key means no relay at all (spends
     * then go directly, marked `unconfigured`, where the rule allows). [controlApex] also drops forbidden hosts.
     */
    fun parsePublicConfig(v: JsonElement?, controlApex: String? = null): OhttpPublicConfig {
        val o = v as? JsonObject ?: return OhttpPublicConfig.EMPTY
        val keyHex = (o["keyConfigHex"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { KEY_HEX.matches(it) }
        if (keyHex == null || Ohttp.keyConfigFromHex(keyHex) == null) return OhttpPublicConfig.EMPTY
        val relays = (o["relays"] as? JsonArray).orEmpty().mapNotNull { relayEntryOf(it, controlApex) }.take(4)
        return OhttpPublicConfig(keyHex, relays)
    }

    /**
     * After every relay failed: may this spend go directly to `.com` (marked `x-flagship-relay-fallback`)?
     * [lapseInMs] is the time until the plan lapses (end plus grace, minus now), null when no plan is paid.
     */
    fun spendMayGoDirect(kind: PrivateSpendKind, lapseInMs: Long?): Boolean = when (kind) {
        PrivateSpendKind.INTERACTIVE -> true
        PrivateSpendKind.OVERAGE -> false
        PrivateSpendKind.TRICKLE -> lapseInMs == null || lapseInMs < DIRECT_BEFORE_LAPSE_MS
    }

    /** Wait before trying the relay again after [failures] failed rounds (5 min doubling, at most 6 h). */
    fun relayRetryAfterMs(failures: Int): Long {
        if (failures <= 0) return 0
        val base = 5 * 60_000L
        return minOf(6 * 3_600_000L, base * (1L shl minOf(20, failures - 1)))
    }

    /** [spendMayGoDirect]'s lapse time from a plan's paid-until (0 = none) and the grace. */
    fun planLapseInMs(paidUntil: Long, graceMs: Long, now: Long): Long? =
        if (paidUntil <= 0) null else paidUntil + graceMs - now
}
