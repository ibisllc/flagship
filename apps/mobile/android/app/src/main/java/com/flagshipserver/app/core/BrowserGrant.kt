package com.flagshipserver.app.core

import java.security.MessageDigest

/**
 * `flagship/browser-grant/v1`: the owner's answer to an app's request for browser access beyond its
 * manifest, signed with the sensitive-order key and posted to `POST /api/browser/owner/grant-requests/answer`.
 * Wire parity with packages/protocol/src/browserGrant.ts; pinned by
 * packages/protocol/test-vectors/browser-grant/vectors.json.
 *
 * Local network: [wholeLan] for the whole LAN, else [exactHosts] for named hosts, else none.
 */
object BrowserGrant {
    const val CANONICAL_TAG = "flagship/browser-grant/v1"

    private fun clean(s: String) = s.isNotEmpty() && s.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }

    fun canonicalBytes(
        serverDomain: String, requestId: String, serviceId: String, decision: String, duration: String,
        capabilities: List<String>, origins: List<String>, exactHosts: List<String>?, wholeLan: Boolean, issuedAt: Long,
    ): ByteArray {
        require(clean(serverDomain)) { "serverDomain" }
        require(clean(requestId)) { "requestId" }
        require(clean(serviceId)) { "serviceId" }
        require(decision == "allow" || decision == "deny") { "decision" }
        require(duration in setOf("once", "session", "service")) { "duration" }
        require(issuedAt >= 0) { "issuedAt" }
        require(capabilities.all { clean(it) && ',' !in it }) { "capability" }
        val digest = MessageDigest.getInstance("SHA-256").digest(origins.sorted().joinToString("\n").toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val lan = when {
            wholeLan -> "whole-lan"
            exactHosts != null -> "exact:" + exactHosts.sorted().joinToString(",")
            else -> "none"
        }
        return listOf(CANONICAL_TAG, serverDomain.lowercase(), requestId, serviceId, decision, duration,
            capabilities.sorted().joinToString(","), digest, lan, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }

    private val DURATION_RANK = mapOf("once" to 0, "session" to 1, "service" to 2)

    /** The durations the owner may choose for an ask, shortest first (packages/protocol browserGrantDurationChoices). */
    fun durationChoices(asked: String): List<String> {
        val r = DURATION_RANK[asked] ?: return emptyList()
        return listOf("once", "session", "service").filter { DURATION_RANK[it]!! <= r }
    }

    /** A grant's scope. [exactHosts] null and [wholeLan] false: no local network. */
    data class Scope(
        val duration: String,
        val capabilities: List<String>,
        val origins: List<String>,
        val exactHosts: List<String>? = null,
        val wholeLan: Boolean = false,
    )

    /**
     * Is [answer] the same as [ask] or narrower, never wider (packages/protocol browserGrantWithin):
     * a duration no longer, capabilities and sites a subset, the local network dropped, kept, or an
     * exact ask cut to fewer hosts; at least one capability and one site or local entry remain.
     */
    fun within(ask: Scope, answer: Scope): Boolean {
        val a = DURATION_RANK[answer.duration] ?: return false
        val q = DURATION_RANK[ask.duration] ?: return false
        if (a > q) return false
        if (answer.capabilities.isEmpty() || !ask.capabilities.containsAll(answer.capabilities)) return false
        if (!ask.origins.containsAll(answer.origins)) return false
        val answerLan = answer.wholeLan || answer.exactHosts != null
        if (answerLan) {
            val askLan = ask.wholeLan || ask.exactHosts != null
            if (!askLan) return false
            if (answer.wholeLan && !ask.wholeLan) return false
            if (!answer.wholeLan) {
                val hosts = answer.exactHosts!!
                if (ask.wholeLan || hosts.isEmpty() || !ask.exactHosts!!.containsAll(hosts)) return false
            }
        }
        return answer.origins.isNotEmpty() || answerLan
    }

    const val REVOKE_TAG = "flagship/browser-grant-revoke/v1"

    /** `flagship/browser-grant-revoke/v1|<serverDomain lowercase>|<serviceId>|<grantId>|<issuedAt>`: the owner withdraws a grant. */
    fun revokeCanonicalBytes(serverDomain: String, serviceId: String, grantId: String, issuedAt: Long): ByteArray {
        require(clean(serverDomain)) { "serverDomain" }
        require(clean(serviceId)) { "serviceId" }
        require(clean(grantId)) { "grantId" }
        require(issuedAt >= 0) { "issuedAt" }
        return listOf(REVOKE_TAG, serverDomain.lowercase(), serviceId, grantId, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }
}
