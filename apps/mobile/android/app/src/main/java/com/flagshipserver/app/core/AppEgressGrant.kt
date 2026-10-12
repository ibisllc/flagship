package com.flagshipserver.app.core

/**
 * The owner's approval for a live app to reach internet hosts its manifest
 * declares. Signed by the sensitive-order key (admin root when held, else the
 * owner IRK); the box verifies it, so a session alone can never open egress.
 * Mirrors packages/protocol/src/appEgress.ts.
 *
 *   flagship/app-egress/v1|<serverDomain>|<serviceId>|<hosts sorted, comma-joined>|<issuedAt>
 *
 * An empty host list revokes.
 */
object AppEgressGrant {
    const val CANONICAL_TAG = "flagship/app-egress/v1"

    /** Distinct, lowercase, sorted by UTF-16 code unit (Kotlin's String order). */
    fun normalizeHosts(hosts: List<String>): List<String> =
        hosts.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct().sorted()

    fun canonicalBytes(serverDomain: String, serviceId: String, hosts: List<String>, issuedAt: Long): ByteArray =
        listOf(
            CANONICAL_TAG,
            serverDomain,
            serviceId,
            normalizeHosts(hosts).joinToString(","),
            issuedAt.toString(),
        ).joinToString("|").toByteArray(Charsets.UTF_8)
}
