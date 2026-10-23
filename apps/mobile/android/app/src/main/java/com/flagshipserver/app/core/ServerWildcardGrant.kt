package com.flagshipserver.app.core

/**
 * `flagship/server-wildcard-grant/v1`: the admin's once-per-server permission for a box to hold a
 * certificate for every app name on the account (`*.<user>.<apex>`). Signed with the sensitive-order
 * key and sent to the box at `POST /api/screens/server-wildcard-grant`. Wire parity with
 * packages/protocol/src/serverWildcardGrant.ts; pinned by
 * packages/protocol/test-vectors/server-wildcard-grant/vectors.json.
 *
 *   flagship/server-wildcard-grant/v1|<username lowercase>|<serverDomain lowercase>|<stkPubHex>|<issuedAt>
 */
object ServerWildcardGrant {
    const val CANONICAL_TAG = "flagship/server-wildcard-grant/v1"
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    private fun clean(s: String) = s.isNotEmpty() && s.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }

    fun canonicalBytes(username: String, serverDomain: String, stkPubHex: String, issuedAt: Long): ByteArray {
        require(clean(username)) { "username" }
        require(clean(serverDomain)) { "serverDomain" }
        require(HEX64.matches(stkPubHex)) { "stkPubHex" }
        val user = username.lowercase()
        val domain = serverDomain.lowercase()
        require(domain.contains(".$user.")) { "the server is not on this account" }
        require(issuedAt >= 0) { "issuedAt" }
        return listOf(CANONICAL_TAG, user, domain, stkPubHex, issuedAt.toString()).joinToString("|").toByteArray(Charsets.UTF_8)
    }
}
