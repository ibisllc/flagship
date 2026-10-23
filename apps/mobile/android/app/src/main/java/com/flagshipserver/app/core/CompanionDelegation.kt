// A phone-signed delegation to ONE Remote (browser) session: build and/or deploy ONE app for a short
// time (SECURITY-HARDENING-PLAN.md 16.2, SEC-AUTH-002). Kotlin mirror of
// packages/protocol/src/companionDelegation.ts and FlagshipAPI/CompanionDelegation.swift; the shared
// vectors are packages/protocol/test-vectors/companion-delegation/vectors.json.
//
//   flagship/companion-delegation/v1|<sessionId>|<serviceRef>|<ops sorted, comma-separated>|<issuedAt>|<expiresAt>

package com.flagshipserver.app.core

object CompanionDelegation {
    const val TAG = "flagship/companion-delegation/v1"
    val ALLOWED_OPS = setOf("build", "deploy")

    /** A delegation lasts at most a day, whatever is signed. */
    const val MAX_MS = 24L * 3_600_000

    private val SESSION_ID = Regex("^[0-9a-f]{16}$")
    private val SERVICE_REF = Regex("^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$")

    data class Order(val sessionId: String, val serviceRef: String, val ops: List<String>, val issuedAt: Long, val expiresAt: Long)

    /** Throws for an order the box would refuse (never sign one). */
    fun canonicalBytes(o: Order): ByteArray {
        require(SESSION_ID.matches(o.sessionId)) { "bad sessionId" }
        require(SERVICE_REF.matches(o.serviceRef)) { "bad serviceRef" }
        require(o.ops.isNotEmpty() && o.ops.all { it in ALLOWED_OPS }) { "bad ops" }
        require(o.issuedAt >= 0) { "bad issuedAt" }
        require(o.expiresAt > o.issuedAt) { "bad expiresAt" }
        val ops = o.ops.toSet().sorted().joinToString(",")
        return listOf(TAG, o.sessionId, o.serviceRef, ops, o.issuedAt.toString(), o.expiresAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }
}
