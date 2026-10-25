package com.flagshipserver.app.core

import com.flagshipserver.app.api.LocalAiAppGrantWire
import com.flagshipserver.app.api.LocalAiGrantBody
import com.flagshipserver.app.api.LocalAiTrainBody
import com.flagshipserver.app.api.LocalAiTrainOrderWire
import com.google.crypto.tink.subtle.Ed25519Sign

/**
 * The owner's two Local AI orders, signed with the sensitive-order key (admin root, else the IRK).
 * Wire parity with packages/protocol/src/localAi.ts; pinned by
 * packages/protocol/test-vectors/local-ai/vectors.json.
 *
 *   flagship/local-ai-app-grant/v1|<serverDomain lowercase>|<serviceId>|<requestsPerDay>|<tokensPerDay>|<maxTokensPerRequest>|<issuedAt>
 *   flagship/local-ai-train/v1|<serverDomain lowercase>|<serviceId>|<jobId>|<baseModel>|<epochs>|<issuedAt>
 *
 * A grant with all three quotas 0 withdraws the app's access.
 */
object LocalAiOrders {
    const val GRANT_TAG = "flagship/local-ai-app-grant/v1"
    const val TRAIN_TAG = "flagship/local-ai-train/v1"
    /** The provider the apps send for "On this server"; the box resolves the endpoint itself. */
    const val PROVIDER = "flagship-local"

    const val MAX_REQUESTS_PER_DAY = 100_000L
    const val MAX_TOKENS_PER_DAY = 100_000_000L
    const val MAX_TOKENS_PER_REQUEST = 32_768L
    const val MAX_EPOCHS = 20

    /** What a new grant offers before the owner changes it. */
    const val DEFAULT_REQUESTS_PER_DAY = 500L
    const val DEFAULT_TOKENS_PER_DAY = 200_000L
    const val DEFAULT_MAX_TOKENS_PER_REQUEST = 1_024L

    private val serviceId = Regex("^[a-z0-9][a-z0-9-]{0,127}$")
    private val jobId = Regex("^[0-9a-f]{16}$")
    private val modelId = Regex("^[a-z0-9][a-z0-9.-]{0,63}$")

    private fun domain(d: String): String {
        require(d.isNotEmpty() && d.length <= 253 && d.none { it == '|' || it.code <= 0x1f || it.code == 0x7f }) { "serverDomain" }
        return d.lowercase()
    }

    fun grantBytes(g: LocalAiAppGrantWire): ByteArray {
        val d = domain(g.serverDomain)
        require(serviceId.matches(g.serviceId)) { "serviceId" }
        require(g.requestsPerDay in 0..MAX_REQUESTS_PER_DAY) { "requestsPerDay" }
        require(g.tokensPerDay in 0..MAX_TOKENS_PER_DAY) { "tokensPerDay" }
        require(g.maxTokensPerRequest in 0..MAX_TOKENS_PER_REQUEST) { "maxTokensPerRequest" }
        val revoke = g.requestsPerDay == 0L
        require(revoke == (g.tokensPerDay == 0L) && revoke == (g.maxTokensPerRequest == 0L)) { "quotas" }
        require(g.issuedAt >= 0) { "issuedAt" }
        return listOf(GRANT_TAG, d, g.serviceId, g.requestsPerDay, g.tokensPerDay, g.maxTokensPerRequest, g.issuedAt)
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun trainBytes(o: LocalAiTrainOrderWire): ByteArray {
        val d = domain(o.serverDomain)
        require(serviceId.matches(o.serviceId)) { "serviceId" }
        require(jobId.matches(o.jobId)) { "jobId" }
        require(modelId.matches(o.baseModel)) { "baseModel" }
        require(o.epochs in 1..MAX_EPOCHS) { "epochs" }
        require(o.issuedAt >= 0) { "issuedAt" }
        return listOf(TRAIN_TAG, d, o.serviceId, o.jobId, o.baseModel, o.epochs, o.issuedAt)
            .joinToString("|").toByteArray(Charsets.UTF_8)
    }

    fun signGrant(g: LocalAiAppGrantWire, signer: Ed25519Sign): LocalAiGrantBody =
        LocalAiGrantBody(g, HexUtil.encode(signer.sign(grantBytes(g))))

    fun signTrain(o: LocalAiTrainOrderWire, signer: Ed25519Sign): LocalAiTrainBody =
        LocalAiTrainBody(o, HexUtil.encode(signer.sign(trainBytes(o))))

    /** A fresh job id: 16 random lowercase hex. */
    fun newJobId(random: java.security.SecureRandom = java.security.SecureRandom()): String {
        val b = ByteArray(8).also(random::nextBytes)
        return HexUtil.encode(b).lowercase()
    }
}
