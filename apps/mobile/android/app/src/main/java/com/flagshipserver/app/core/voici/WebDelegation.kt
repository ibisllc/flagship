// "Sign in with Flagship" (docs/voici-and-messages.md §6.4): an account-held Ed25519 principal key (for voi.ci the
// per-page pseudonym key P) lets a browser's P-256 key B sign for it, for one scope, origin and audience, until
// expiresAt. Kotlin twin of packages/protocol/src/webDelegation.ts.
//
//   flagship/web-delegation/v1|<scope>|<origin>|<audience>|<principalPub>|<delegateAlg>|<delegatePub>|<issuedAt>|<expiresAt>|<nonce>
//   flagship/web-delegation-revoke/v1|<delegatePub>|<issuedAt>
//
// Public API (object WebDelegations): TAG_WEB_DELEGATION, TAG_WEB_DELEGATION_REVOKE, WEB_DELEGATION_SCOPES,
// VOICI_WEB_ORIGIN, VOICI_WEB_ORIGIN_GYM, canonicalWebDelegation, signWebDelegation, parseWebDelegation,
// checkWebDelegation (codes malformed, bad-signature, wrong-scope, wrong-origin, wrong-audience, wrong-principal,
// too-long, not-yet-valid, expired), canonicalWebDelegationRevoke, signWebDelegationRevoke,
// verifyWebDelegationRevoke, parseWebDelegationRevoke. Data classes WebDelegation, WebDelegationRevoke (+ toJson).

package com.flagshipserver.app.core.voici

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class WebDelegation(
    val scope: String,
    val origin: String,
    val audience: String,
    val principalPub: String,
    val delegateAlg: String,
    val delegatePub: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val nonce: String,
) {
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf(
            "scope" to JsonPrimitive(scope),
            "origin" to JsonPrimitive(origin),
            "audience" to JsonPrimitive(audience),
            "principalPub" to JsonPrimitive(principalPub),
            "delegateAlg" to JsonPrimitive(delegateAlg),
            "delegatePub" to JsonPrimitive(delegatePub),
            "issuedAt" to JsonPrimitive(issuedAt),
            "expiresAt" to JsonPrimitive(expiresAt),
            "nonce" to JsonPrimitive(nonce),
        ),
    )
}

data class WebDelegationRevoke(val delegatePub: String, val issuedAt: Long) {
    fun toJson(): JsonObject = JsonObject(linkedMapOf("delegatePub" to JsonPrimitive(delegatePub), "issuedAt" to JsonPrimitive(issuedAt)))
}

object WebDelegations {
    const val TAG_WEB_DELEGATION = "flagship/web-delegation/v1"
    const val TAG_WEB_DELEGATION_REVOKE = "flagship/web-delegation-revoke/v1"
    val WEB_DELEGATION_SCOPES: List<String> = listOf("voici-messages")
    const val VOICI_WEB_ORIGIN = "https://voi.ci"
    const val VOICI_WEB_ORIGIN_GYM = "https://gym.voi.ci"

    private val ORIGIN = Regex("^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
    private val AUDIENCE = Regex("^[a-z0-9-]{1,64}$")
    private val KEYS = listOf("audience", "delegateAlg", "delegatePub", "expiresAt", "issuedAt", "nonce", "origin", "principalPub", "scope")

    private fun isTime(n: Long) = n in 0..VoiciJs.MAX_SAFE
    private fun isP256Pub(s: String?) = WebEnvelopes.isLowerHex(s, 65) && s!!.startsWith("04")

    fun canonicalWebDelegation(d: WebDelegation): ByteArray {
        fun bad(f: String): Nothing = throw IllegalArgumentException("$TAG_WEB_DELEGATION: bad $f")
        if (d.scope !in WEB_DELEGATION_SCOPES) bad("scope")
        if (!ORIGIN.matches(d.origin)) bad("origin")
        if (!AUDIENCE.matches(d.audience)) bad("audience")
        if (!WebEnvelopes.isLowerHex(d.principalPub, 32)) bad("principalPub")
        if (d.delegateAlg != "p256" || !isP256Pub(d.delegatePub)) bad("delegate")
        if (!isTime(d.issuedAt) || !isTime(d.expiresAt) || d.expiresAt <= d.issuedAt) bad("time")
        if (!WebEnvelopes.isLowerHex(d.nonce, 16)) bad("nonce")
        return VoiciJs.utf8(
            listOf(TAG_WEB_DELEGATION, d.scope, d.origin, d.audience, d.principalPub, d.delegateAlg, d.delegatePub, d.issuedAt.toString(), d.expiresAt.toString(), d.nonce)
                .joinToString("|"),
        )
    }

    /** Ed25519 signature (hex) by the principal's 32-byte seed. */
    fun signWebDelegation(d: WebDelegation, principalSeed: ByteArray): String =
        VoiciJs.hex(VoiciJs.edSign(principalSeed, canonicalWebDelegation(d)))

    /** Strict shape of an untrusted delegation object (exact keys); null when malformed. */
    fun parseWebDelegation(v: JsonElement?): WebDelegation? {
        val r = VoiciJs.obj(v) ?: return null
        if (r.keys.sorted() != KEYS) return null
        val d = WebDelegation(
            scope = VoiciJs.str(r["scope"]) ?: return null,
            origin = VoiciJs.str(r["origin"]) ?: return null,
            audience = VoiciJs.str(r["audience"]) ?: return null,
            principalPub = VoiciJs.str(r["principalPub"]) ?: return null,
            delegateAlg = VoiciJs.str(r["delegateAlg"]) ?: return null,
            delegatePub = VoiciJs.str(r["delegatePub"]) ?: return null,
            issuedAt = VoiciJs.time(r["issuedAt"]) ?: return null,
            expiresAt = VoiciJs.time(r["expiresAt"]) ?: return null,
            nonce = VoiciJs.str(r["nonce"]) ?: return null,
        )
        return try {
            canonicalWebDelegation(d)
            d
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** What a use of a delegation wants. `notAfter` (the attestation's expiresAt) caps expiresAt. */
    data class Want(val scope: String, val origin: String, val audience: String, val principalPub: String, val now: Long, val notAfter: Long? = null)

    /**
     * Checks a delegation for a use: the signature by principalPub, then scope, origin, audience, principal, the
     * notAfter cap, and `now` inside [issuedAt, expiresAt).
     */
    fun checkWebDelegation(d: JsonElement?, signature: String?, want: Want): VoiciOutcome<WebDelegation> {
        val p = parseWebDelegation(d)
        if (p == null || signature == null) return VoiciOutcome.Refused("malformed")
        if (!WebEnvelopes.ed25519VerifyHex(signature, canonicalWebDelegation(p), p.principalPub)) return VoiciOutcome.Refused("bad-signature")
        if (p.scope != want.scope) return VoiciOutcome.Refused("wrong-scope")
        if (p.origin != want.origin) return VoiciOutcome.Refused("wrong-origin")
        if (p.audience != want.audience) return VoiciOutcome.Refused("wrong-audience")
        if (p.principalPub != want.principalPub) return VoiciOutcome.Refused("wrong-principal")
        if (want.notAfter != null && p.expiresAt > want.notAfter) return VoiciOutcome.Refused("too-long")
        if (want.now < p.issuedAt) return VoiciOutcome.Refused("not-yet-valid")
        if (want.now >= p.expiresAt) return VoiciOutcome.Refused("expired")
        return VoiciOutcome.Ok(p)
    }

    fun canonicalWebDelegationRevoke(r: WebDelegationRevoke): ByteArray {
        if (!isP256Pub(r.delegatePub)) throw IllegalArgumentException("$TAG_WEB_DELEGATION_REVOKE: bad delegatePub")
        if (!isTime(r.issuedAt)) throw IllegalArgumentException("$TAG_WEB_DELEGATION_REVOKE: bad issuedAt")
        return VoiciJs.utf8(listOf(TAG_WEB_DELEGATION_REVOKE, r.delegatePub, r.issuedAt.toString()).joinToString("|"))
    }

    fun signWebDelegationRevoke(r: WebDelegationRevoke, principalSeed: ByteArray): String =
        VoiciJs.hex(VoiciJs.edSign(principalSeed, canonicalWebDelegationRevoke(r)))

    fun verifyWebDelegationRevoke(r: WebDelegationRevoke, signature: String, principalPub: String): Boolean = try {
        WebEnvelopes.ed25519VerifyHex(signature, canonicalWebDelegationRevoke(r), principalPub)
    } catch (_: IllegalArgumentException) {
        false
    }

    fun parseWebDelegationRevoke(v: JsonElement?): WebDelegationRevoke? {
        val r = VoiciJs.obj(v) ?: return null
        if (r.keys.sorted() != listOf("delegatePub", "issuedAt")) return null
        val pub = VoiciJs.str(r["delegatePub"])
        val at = VoiciJs.time(r["issuedAt"])
        if (!isP256Pub(pub) || at == null) return null
        return WebDelegationRevoke(pub!!, at)
    }
}
