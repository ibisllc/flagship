package com.flagshipserver.app.core

/**
 * `flagship/chat-approval/v1`: the owner's answer to a held app-chat request, signed with the sensitive-order
 * key and carried by the paired session to `POST /api/screens/chat/answer`. Wire parity with
 * packages/protocol/src/chatWire.ts; pinned by packages/protocol/test-vectors/chat-approval/vectors.json.
 *
 *   flagship/chat-approval/v1|<serverDomain lowercase>|<requestId>|<kind>|<decision>|<issuedAt>
 */
object ChatApproval {
    const val CANONICAL_TAG = "flagship/chat-approval/v1"

    enum class Kind(val wire: String) { INCOMING("incoming"), OUTGOING("outgoing") }
    enum class Decision(val wire: String) { ALLOW("allow"), ALWAYS("always"), DENY("deny") }

    private fun clean(s: String) = s.isNotEmpty() && s.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }

    fun canonicalBytes(serverDomain: String, requestId: String, kind: Kind, decision: Decision, issuedAt: Long): ByteArray {
        require(clean(serverDomain)) { "serverDomain" }
        require(clean(requestId)) { "requestId" }
        require(!(decision == Decision.ALWAYS && kind != Kind.INCOMING)) { "always allow applies to incoming requests only" }
        require(issuedAt >= 0) { "issuedAt" }
        return listOf(CANONICAL_TAG, serverDomain.lowercase(), requestId, kind.wire, decision.wire, issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }
}
