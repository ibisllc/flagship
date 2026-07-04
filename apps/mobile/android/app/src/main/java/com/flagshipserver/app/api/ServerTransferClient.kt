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
//   POST /api/server/:domain/transfer/admin-handoff       giver, admin-root-signed hand-off proof (§9.8)
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

    /** GIVER: deposit the admin-root hand-off proof (signed by the GIVER's admin
     *  master root; the box verifies vs its pinned anchor). Domain in the path is
     *  the box's OLD canonical. */
    suspend fun postAdminHandoff(serverDomain: String, body: TransferAdminHandoffBody)

    /** GIVER: deposit the LEGACY (no-admin-root) re-home authorization
     *  (v1-sec GAP 3) — signed by the GIVER's owner IRK so a box with no pinned
     *  admin root verifies it vs its pinned owner IRK before re-homing. Domain in
     *  the path is the box's OLD canonical. */
    suspend fun postRehomeAuth(serverDomain: String, body: TransferRehomeAuthBody)
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
    /** The acquirer's admin master-root pub hex, "" when the account has none.
     *  Inside the claim's v2 signed canonical (§9.8). */
    val acquirerAdminRootPub: String,
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
    val acquirerAdminRootPub: String? = null,
)

@Serializable
data class TransferDiskKeyBody(
    val auth: MailboxAuthEnvelope.Auth,
    val authSignature: String,
    val sealedDiskKey: String,
)

@Serializable
data class TransferDiskKey(val sealedDiskKey: String = "")

/** Wire twin of core `AdminRootTransfer` — field names match the Worker handler
 *  JSON exactly. */
@Serializable
data class AdminRootTransferWire(
    val serverDomain: String,
    val giverUsername: String,
    val acquirerUsername: String,
    val oldAdminRootPub: String,
    val newAdminRootPub: String,
    val transferNonce: String,
    val issuedAt: Long,
)

@Serializable
data class TransferAdminHandoffBody(
    val handoff: AdminRootTransferWire,
    val signatureHex: String,
)

/** The legacy re-home authorization deposit (v1-sec GAP 3). `signatureHex` is
 *  the GIVER owner IRK's Ed25519 signature over the
 *  `flagship/server-rehome-auth/v1` canonical bytes; `.com` reconstructs the
 *  signed (old/new domain, acquirer IRK) fields from the claimed row, so the
 *  body carries only `issuedAt` + the signature. */
@Serializable
data class TransferRehomeAuthBody(
    val issuedAt: Long,
    val signatureHex: String,
)

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

    override suspend fun postAdminHandoff(serverDomain: String, body: TransferAdminHandoffBody) {
        transport.postJson(
            urlFor(serverDomain, "transfer/admin-handoff"), body,
            serializer = TransferAdminHandoffBody.serializer(), accept = setOf(200),
        )
    }

    override suspend fun postRehomeAuth(serverDomain: String, body: TransferRehomeAuthBody) {
        transport.postJson(
            urlFor(serverDomain, "transfer/rehome-auth"), body,
            serializer = TransferRehomeAuthBody.serializer(), accept = setOf(200),
        )
    }

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
