// Phone-as-unlock-endpoint RELAY mailbox client (Wave-2 endpoints in
// packages/control-plane/src/secretMailbox.ts). Kotlin mirror of
// FlagshipAPI/Client/SecretMailboxClient.swift.
//
// `.com` is a blind store-and-forward relay; this is the phone's
// push-woken HTTPS half. The wire types are PURE (no crypto) — the
// SecretRequestCoordinator builds the IRK-signed mailbox auth + the
// sealed/signed reply and hands the finished bytes here. Field names match
// the Worker handlers' JSON exactly.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable

interface SecretMailboxClient {
    /** POST /api/secret-requests — phone, IRK mailbox-auth. Returns the
     *  account's un-answered pending requests, newest first. */
    suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse

    /** POST /api/secret-response — phone, IRK mailbox-auth. Write-once. */
    suspend fun postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody)

    /** GET /api/server/:domain/sealed-luks-key — the LUKS key sealed FOR
     *  the phone. 404 → no sealed key on file. */
    suspend fun fetchSealedLuksKey(serverDomain: String): SealedLuksKeyResponse

    /** GET /api/users/:u/pods — the directory. The phone resolves the
     *  box's STK INDEPENDENTLY of the mailbox echo from here. */
    suspend fun fetchPods(username: String): PodsDirectoryResponse

    /** POST /api/server/:domain/unlock-key/lease-v2 — deposit a box-sealed
     *  auto-unlock lease (IRK-signed). Enables "auto" self-unlock; .com
     *  stores ciphertext only (I1). */
    suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String)

    /** DELETE /api/server/:domain/unlock-key/lease-v2/:id — the kill switch
     *  (IRK-signed). Drops the lease so the box falls back to phone-gated
     *  approval (downgrade, not brick). */
    suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String)
}

// MARK: - Wire types

@Serializable
data class MailboxAuthEnvelope(
    val auth: Auth,
    val authSignature: String,    // hex (64 bytes) — Ed25519 by the IRK
) {
    @Serializable
    data class Auth(
        val username: String,
        val endpointLabel: String,
        val phoneIrkPub: String,  // hex (32 bytes) — the account IRK
        val issuedAt: Long,
        val expiresAt: Long,
        val nonce: String,        // hex (32 bytes, 64 hex chars)
    )
}

@Serializable
data class PendingSecretRequest(
    val serverDomain: String,
    val requestNonceHex: String,
    val stkPub: String,           // hex echo (re-verified vs directory)
    val purpose: String,          // "unlock-key" | "entitlement"
    val issuedAt: Long,
    val requestSignature: String, // hex (64 bytes) — STK signature
    val deviceInfo: DeviceInfoHint? = null,
    val postedAt: Long,
    val expiresAt: Long,
) {
    /** Stable id — (domain, nonce) is unique per request. */
    val id: String get() = "$serverDomain#$requestNonceHex"
}

/** The box's self-reported device-info display hint for the "is this my
 *  box?" confirm. NOT signed, NOT the boundary. */
@Serializable
data class DeviceInfoHint(
    val ip: String? = null,
    val region: String? = null,
    val os: String? = null,
    val hostname: String? = null,
)

@Serializable
data class SecretRequestsResponse(
    val username: String,
    val requests: List<PendingSecretRequest> = emptyList(),
)

@Serializable
data class SecretResponseBody(
    val serverDomain: String,
    val requestNonceHex: String,
    val purpose: String,
    val sealed: String,           // hex
    val issuedAt: Long,
)

/** On-wire body for POST /api/secret-response: { auth, authSignature,
 *  response }. */
@Serializable
data class SecretResponsePost(
    val auth: MailboxAuthEnvelope.Auth,
    val authSignature: String,
    val response: SecretResponseBody,
)

@Serializable
data class SealedLuksKeyResponse(
    val serverDomain: String,
    val sealedKey: String,        // hex — sealed FOR the phone
    val sealedAt: Long,
)

/** The `lease` object inside a box-sealed-lease deposit body (matches
 *  handlePostBoxSealedLease). */
@Serializable
data class BoxSealedLeaseWire(
    val serverDomain: String,
    val stkPub: String,           // hex
    val leaseId: String,
    val sealedKey: String,        // hex
    val issuedAt: Long,
    val expiresAt: Long,
    val maxUses: Int? = null,
)

/** The `request` object inside a lease-revoke body. */
@Serializable
data class LeaseRevokeWire(
    val serverDomain: String,
    val leaseId: String,
    val issuedAt: Long,
)

@Serializable
data class LeaseDepositPost(val lease: BoxSealedLeaseWire, val signature: String)

@Serializable
data class LeaseRevokePost(val request: LeaseRevokeWire, val signature: String)

@Serializable
data class PodDirectoryEntry(
    val serverDomain: String,
    val identityPubKey: String,   // hex (32 bytes) — the STK
    val revokedAt: Long? = null,
)

@Serializable
data class PodsDirectoryResponse(
    val username: String,
    val pods: List<PodDirectoryEntry> = emptyList(),
) {
    /** The STK registered for `serverDomain` (case-insensitive, non-
     *  revoked). Null when the directory can't vouch for the box. */
    fun identityPubKey(forServerDomain: String): String? {
        val target = forServerDomain.lowercase()
        return pods.firstOrNull {
            it.serverDomain.lowercase() == target && it.revokedAt == null
        }?.identityPubKey
    }
}

// MARK: - Live

class LiveSecretMailboxClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = DEFAULT_BASE_URL,
) : SecretMailboxClient {
    private val base = baseUrl.trimEnd('/')

    companion object {
        const val DEFAULT_BASE_URL = "https://flagshipserver.com"
    }

    override suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse =
        // The list is IRK-signed in the body; the Worker exposes it as POST
        // as well as GET (a GET with a body is awkward for OkHttp).
        transport.postJsonForResponse(
            "$base/api/secret-requests", auth,
            serializer = MailboxAuthEnvelope.serializer(),
            responseSerializer = SecretRequestsResponse.serializer(),
        )

    override suspend fun postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody) {
        val payload = SecretResponsePost(auth.auth, auth.authSignature, response)
        transport.postJson(
            "$base/api/secret-response", payload,
            serializer = SecretResponsePost.serializer(),
        )
    }

    override suspend fun fetchSealedLuksKey(serverDomain: String): SealedLuksKeyResponse {
        val encoded = java.net.URLEncoder.encode(serverDomain, "UTF-8")
        return transport.getJson(
            "$base/api/server/$encoded/sealed-luks-key",
            responseSerializer = SealedLuksKeyResponse.serializer(),
        )
    }

    override suspend fun fetchPods(username: String): PodsDirectoryResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.getJson(
            "$base/api/users/$encoded/pods",
            responseSerializer = PodsDirectoryResponse.serializer(),
        )
    }

    override suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String) {
        val enc = java.net.URLEncoder.encode(lease.serverDomain, "UTF-8")
        transport.postJson(
            "$base/api/server/$enc/unlock-key/lease-v2",
            LeaseDepositPost(lease, signatureHex),
            serializer = LeaseDepositPost.serializer(),
            accept = setOf(200, 201),
        )
    }

    override suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String) {
        val encD = java.net.URLEncoder.encode(request.serverDomain, "UTF-8")
        val encL = java.net.URLEncoder.encode(request.leaseId, "UTF-8")
        val bytes = transport.json
            .encodeToString(LeaseRevokePost.serializer(), LeaseRevokePost(request, signatureHex))
            .toByteArray(Charsets.UTF_8)
        // DELETE with a JSON body (the Worker reads { request, signature }).
        transport.execute(
            method = "DELETE",
            url = "$base/api/server/$encD/unlock-key/lease-v2/$encL",
            body = bytes,
            contentType = "application/json",
            accept = setOf(200, 204),
        )
    }
}

// MARK: - Mock

/** In-memory mailbox for previews / tests / the unconfigured default. */
class MockSecretMailboxClient : SecretMailboxClient {
    var pending: List<PendingSecretRequest> = emptyList()
    var directory: List<PodDirectoryEntry> = emptyList()
    var sealedLuksKeyHex: String? = null
    var lastPostedAuth: MailboxAuthEnvelope? = null
    var lastPostedResponse: SecretResponseBody? = null
    var usernameForResponses: String = "demo"
    val deposited: MutableList<Pair<BoxSealedLeaseWire, String>> = mutableListOf()
    val revoked: MutableList<Pair<LeaseRevokeWire, String>> = mutableListOf()

    override suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse {
        lastPostedAuth = auth
        return SecretRequestsResponse(auth.auth.username, pending)
    }

    override suspend fun postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody) {
        lastPostedAuth = auth
        lastPostedResponse = response
    }

    override suspend fun fetchSealedLuksKey(serverDomain: String): SealedLuksKeyResponse {
        val hex = sealedLuksKeyHex ?: throw HttpException(404, "no sealed key on file")
        return SealedLuksKeyResponse(serverDomain, hex, 1L)
    }

    override suspend fun fetchPods(username: String): PodsDirectoryResponse =
        PodsDirectoryResponse(username, directory)

    override suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String) {
        deposited.add(lease to signatureHex)
    }

    override suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String) {
        revoked.add(request to signatureHex)
    }
}
