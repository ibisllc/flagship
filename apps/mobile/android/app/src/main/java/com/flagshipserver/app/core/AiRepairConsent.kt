package com.flagshipserver.app.core

/**
 * `flagship/ai-repair-consent/v1`: the owner's consent to ONE AI run that spends their key or Flagship
 * Inference credits, signed with the sensitive-order key and sent with the adapt request after the box's
 * estimate was shown (HTTP 428 `{code:"ai-consent", estimate}`). Wire parity with
 * packages/protocol/src/aiRepairConsent.ts; pinned by packages/protocol/test-vectors/ai-repair-consent/vectors.json.
 *
 *   flagship/ai-repair-consent/v1|<serverDomain lowercase>|<buildId>|<operation>|<provider>|<source>|<highTokens>|<issuedAt>
 */
object AiRepairConsent {
    const val CANONICAL_TAG = "flagship/ai-repair-consent/v1"

    enum class Operation(val wire: String) { ADAPT("adapt"), REPAIR("repair"), SYNC("sync") }
    enum class Source(val wire: String) { BYOK("byok"), PROMO("promo") }

    private val buildIdPattern = Regex("^[0-9a-f]{16}$")
    private fun clean(s: String) = s.isNotEmpty() && s.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }

    fun canonicalBytes(serverDomain: String, buildId: String, operation: Operation, provider: String, source: Source, highTokens: Long, issuedAt: Long): ByteArray {
        require(clean(serverDomain)) { "serverDomain" }
        require(clean(provider)) { "provider" }
        require(buildIdPattern.matches(buildId)) { "buildId" }
        require(highTokens >= 1) { "highTokens" }
        require(issuedAt >= 0) { "issuedAt" }
        return listOf(CANONICAL_TAG, serverDomain.lowercase(), buildId, operation.wire, provider, source.wire, highTokens.toString(), issuedAt.toString())
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }
}
