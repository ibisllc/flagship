package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable

class MockServerTransferClient : ServerTransferClient {
    val offers = mutableListOf<Pair<String, TransferOfferBody>>()
    val claims = mutableListOf<Pair<String, TransferClaimBody>>()
    val diskKeyDeposits = mutableListOf<Pair<String, TransferDiskKeyBody>>()
    val adminHandoffDeposits = mutableListOf<Pair<String, TransferAdminHandoffBody>>()
    val rehomeAuthDeposits = mutableListOf<Pair<String, TransferRehomeAuthBody>>()
    var scriptedPoll: TransferClaimPoll? = null
    var scriptedDiskKey: TransferDiskKey? = null
    var claimResult: TransferClaimResult? = null
    var adminHandoffError: Throwable? = null
    var rehomeAuthError: Throwable? = null

    override suspend fun postOffer(serverDomain: String, body: TransferOfferBody): TransferOfferResult {
        offers.add(serverDomain to body)
        return TransferOfferResult(ok = true, expiresAt = body.offer.expiresAt)
    }

    override suspend fun postClaim(serverDomain: String, body: TransferClaimBody): TransferClaimResult {
        claims.add(serverDomain to body)
        return claimResult ?: TransferClaimResult(
            ok = true,
            serverDomain = serverDomain,
            newServerDomain = serverDomain,
            acquirerUsername = body.claim.acquirerUsername,
        )
    }

    override suspend fun pollClaim(serverDomain: String, auth: MailboxAuthEnvelope): TransferClaimPoll? = scriptedPoll

    override suspend fun postDiskKey(serverDomain: String, body: TransferDiskKeyBody) {
        diskKeyDeposits.add(serverDomain to body)
    }

    override suspend fun claimDiskKey(serverDomain: String, auth: MailboxAuthEnvelope): TransferDiskKey? = scriptedDiskKey

    override suspend fun postAdminHandoff(serverDomain: String, body: TransferAdminHandoffBody) {
        adminHandoffError?.let { throw it }
        adminHandoffDeposits.add(serverDomain to body)
    }

    override suspend fun postRehomeAuth(serverDomain: String, body: TransferRehomeAuthBody) {
        rehomeAuthError?.let { throw it }
        rehomeAuthDeposits.add(serverDomain to body)
    }
}
