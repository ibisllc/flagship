// Transfer-a-box client — the cross-account ownership handoff brokered by `.com`
// (docs/account-deletion-and-name-reclaim.md §4). Kotlin mirror of iOS
// FlagshipAPI/Client/ServerTransferClient.swift + the webapp lib/serverTransfer.js
// wire bodies:
//
//   POST /api/server/:domain/transfer/offer            giver, IRK mailbox-auth + signed offer
//   POST /api/server/:domain/transfer/claim             acquirer, signed claim
//   POST /api/server/:domain/transfer/claim-poll         giver, IRK mailbox-auth → acquirer IRK
//   POST /api/server/:domain/transfer/disk-key           giver, IRK mailbox-auth + sealed disk key
//   POST /api/server/:domain/transfer/disk-key-claim      acquirer, IRK mailbox-auth → sealed disk key
//
// The wire types are PURE (no crypto): the VM builds the IRK-signed offer/claim
// + the mailbox-auth via core and hands the finished bytes here. Field names
// match the Worker handlers' JSON exactly (the Mock-matches-Worker-wire invariant).

package com.flagshipserver.app.api

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable

interface ServerTransferClient {
    /** GIVER: deposit a signed offer (IRK mailbox-auth). */
    suspend fun postOffer(serverDomain: String, body: TransferOfferBody): TransferOfferResult

    /** ACQUIRER: submit a signed claim. Returns the new (acquirer-namespace) domain. */
    suspend fun postClaim(serverDomain: String, body: TransferClaimBody): TransferClaimResult

    /** GIVER: poll "did someone claim my offer?" (IRK mailbox-auth). null while
     *  unclaimed (404). */
    suspend fun pollClaim(serverDomain: String, auth: MailboxAuthEnvelope): TransferClaimPoll?

    /** GIVER: deposit the disk key re-sealed to the acquirer IRK (IRK mailbox-auth). */
    suspend fun postDiskKey(serverDomain: String, body: TransferDiskKeyBody)

    /** ACQUIRER: pick up the giver's re-sealed disk key. null until deposited (404). */
    suspend fun claimDiskKey(serverDomain: String, auth: MailboxAuthEnvelope): TransferDiskKey?
}

// ── Wire types ──────────────────────────────────────────────────────────────

@Serializable
data class TransferOfferWire(
    val serverDomain: String,
    val transferNonce: String,
    val issuedAt: Long,
    val expiresAt: Long,
)

@Serializable
data class TransferOfferBody(
    val auth: MailboxAuthEnvelope.Auth,
    val authSignature: String,
    val offer: TransferOfferWire,
    val offerSignature: String,
)

@Serializable
data class TransferOfferResult(val ok: Boolean = false, val expiresAt: Long = 0)

@Serializable
data class TransferClaimWire(
    val serverDomain: String,
    val transferNonce: String,
    val acquirerUsername: String,
    val acquirerIrkPub: String,
    val issuedAt: Long,
)

@Serializable
data class TransferClaimBody(
    val claim: TransferClaimWire,
    val claimSignature: String,
)

@Serializable
data class TransferClaimResult(
    val ok: Boolean = false,
    val serverDomain: String = "",
    val newServerDomain: String? = null,
    val acquirerUsername: String? = null,
)

@Serializable
data class TransferClaimPoll(
    val newServerDomain: String? = null,
    val acquirerUsername: String? = null,
    val acquirerIrkPub: String? = null,
)

@Serializable
data class TransferDiskKeyBody(
    val auth: MailboxAuthEnvelope.Auth,
    val authSignature: String,
    val sealedDiskKey: String,
)

@Serializable
data class TransferDiskKey(val sealedDiskKey: String = "")

// ── Live ────────────────────────────────────────────────────────────────────

class LiveServerTransferClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = DEFAULT_BASE_URL,
) : ServerTransferClient {
    private val base = baseUrl.trimEnd('/')

    companion object {
        val DEFAULT_BASE_URL: String get() = Endpoints.controlBaseUrl
    }

    private fun urlFor(serverDomain: String, suffix: String): String {
        val encoded = java.net.URLEncoder.encode(serverDomain, "UTF-8")
        return "$base/api/server/$encoded/$suffix"
    }

    override suspend fun postOffer(serverDomain: String, body: TransferOfferBody): TransferOfferResult =
        transport.postJsonForResponse(
            urlFor(serverDomain, "transfer/offer"), body,
            serializer = TransferOfferBody.serializer(),
            responseSerializer = TransferOfferResult.serializer(),
        )

    override suspend fun postClaim(serverDomain: String, body: TransferClaimBody): TransferClaimResult =
        transport.postJsonForResponse(
            urlFor(serverDomain, "transfer/claim"), body,
            serializer = TransferClaimBody.serializer(),
            responseSerializer = TransferClaimResult.serializer(),
        )

    override suspend fun pollClaim(serverDomain: String, auth: MailboxAuthEnvelope): TransferClaimPoll? =
        postOptional(serverDomain, "transfer/claim-poll", auth, TransferClaimPoll.serializer())

    override suspend fun postDiskKey(serverDomain: String, body: TransferDiskKeyBody) {
        transport.postJson(
            urlFor(serverDomain, "transfer/disk-key"), body,
            serializer = TransferDiskKeyBody.serializer(), accept = setOf(200),
        )
    }

    override suspend fun claimDiskKey(serverDomain: String, auth: MailboxAuthEnvelope): TransferDiskKey? =
        postOptional(serverDomain, "transfer/disk-key-claim", auth, TransferDiskKey.serializer())

    /** POST the IRK mailbox-auth in the body; 404 ⇒ null (not-yet-claimed /
     *  not-yet-deposited), 200 ⇒ decode. */
    private suspend fun <R> postOptional(
        serverDomain: String,
        suffix: String,
        auth: MailboxAuthEnvelope,
        responseSerializer: kotlinx.serialization.KSerializer<R>,
    ): R? {
        val bytes = transport.json
            .encodeToString(MailboxAuthEnvelope.serializer(), auth)
            .toByteArray(Charsets.UTF_8)
        val resp = transport.execute(
            method = "POST",
            url = urlFor(serverDomain, suffix),
            body = bytes,
            contentType = "application/json",
            accept = setOf(200, 404),
        )
        if (resp.status == 404) return null
        return transport.json.decodeFromString(responseSerializer, String(resp.body, Charsets.UTF_8))
    }
}

// ── Mock ──────────────────────────────────────────────────────────────────────

class MockServerTransferClient : ServerTransferClient {
    val offers = mutableListOf<Pair<String, TransferOfferBody>>()
    val claims = mutableListOf<Pair<String, TransferClaimBody>>()
    val diskKeyDeposits = mutableListOf<Pair<String, TransferDiskKeyBody>>()
    var scriptedPoll: TransferClaimPoll? = null
    var scriptedDiskKey: TransferDiskKey? = null
    var claimResult: TransferClaimResult? = null

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
}
