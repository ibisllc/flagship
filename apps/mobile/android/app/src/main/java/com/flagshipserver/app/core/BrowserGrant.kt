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
}
