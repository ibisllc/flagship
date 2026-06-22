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

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.Serializable

interface SecretMailboxClient {
    /** POST /api/secret-requests — phone, IRK mailbox-auth. Returns the
     *  account's un-answered pending requests, newest first. */
    suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse

    /** POST {boot}/api/boot/response — owner-IRK (the `bootAuth` header).
     *  Posts the sealed reply to the dedicated boot worker, where the box
     *  polls for it. Write-once. */
    suspend fun postResponse(response: SecretResponseBody, bootAuth: String)

    /** GET /api/server/:domain/sealed-luks-key — the LUKS key sealed FOR
     *  the phone. 404 → no sealed key on file. Stays on the identity plane. */
    suspend fun fetchSealedLuksKey(serverDomain: String): SealedLuksKeyResponse

    /** GET /api/users/:u/pods — the directory. The phone resolves the
     *  box's STK INDEPENDENTLY of the mailbox echo from here. Identity plane. */
    suspend fun fetchPods(username: String): PodsDirectoryResponse

    /** PUT {boot}/api/boot/lease — deposit a box-sealed auto-unlock lease on
     *  the boot worker (owner-IRK via `bootAuth`). The `lease` body keeps its
     *  own IRK signature so the box re-verifies it; the worker stores
     *  ciphertext only (I1). */
    suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String)

    /** DELETE {boot}/api/boot/lease/:domain/:id — the kill switch (owner-IRK
     *  via `bootAuth`). Drops the lease so the box falls back to phone-gated
     *  approval (downgrade, not brick). */
    suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String)

    /** POST /api/server/:domain/pairing-deposit — phone, IRK mailbox-auth.
     *  Create-time pairing: pre-register a sealed `add-paired-session` order on
     *  `.com` the moment the recipe is minted, so the booting box claims it on
     *  first boot and comes online ALREADY paired (no "Pair this server" tap).
     *  `.com` stores only the OPAQUE sealed blob — it never sees the token (I1). */
    suspend fun depositPairing(serverDomain: String, body: PairingDepositBody)

    /** POST /api/server/:domain/entitlement-deposit — phone, IRK mailbox-auth.
     *  Fold "authorize to serve" into the first-boot unlock: the phone deposits
     *  an owner-IRK-signed entitlement for the box's STK so it claims it on boot
     *  with no separate tap. `deposit.sealed` is the PUBLIC entitlement carrier
     *  (what the box presents at HELLO), not a secret. Reuses [PairingDepositBody]
     *  — identical wire shape. */
    suspend fun depositEntitlement(serverDomain: String, body: PairingDepositBody)
}

/** The create-time pairing deposit body. `auth`/`authSignature` are the SAME IRK
 *  mailbox-auth shape as the other phone-mailbox calls; `deposit` carries the
 *  sealed `{request,signature}` blob (sealed FOR the recipe pairing key the phone
 *  embedded). Field names match the Worker handler (`handlePostPairingDeposit`). */
@Serializable
data class PairingDepositBody(
    val auth: MailboxAuthEnvelope.Auth,
    val authSignature: String,
    val deposit: Deposit,
) {
    @Serializable
    data class Deposit(
        val serverDomain: String,
        val requestNonceHex: String,  // hex (32 bytes)
        val stkPub: String,           // hex (32 bytes) — pairing key pub (seal recipient)
        val sealed: String,           // hex — sealed `{request,signature}` JSON
        val issuedAt: Long,
    )
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

/** The `{ response }` body for POST {boot}/api/boot/response. */
@Serializable
data class BootResponsePost(val response: SecretResponseBody)

/** Minimal cert presence shape — we only need "is there a cert" to tell a
 *  dead box from a live one, so we decode just one field. Mirrors the iOS
 *  presence-flag decode. */
@Serializable
data class PodCurrentCert(
    val sha256: String? = null,
)

/** A′ pinning — the box's STK-signed daemon-status report tuple, relayed
 *  VERBATIM by `/pods`. Field names match the daemon's wire JSON (which is
 *  what the signature commits to via the canonical bytes in
 *  core.DaemonStatusReport). Every field is defaulted so a partial/garbled
 *  relay still DECODES (and then fails VERIFICATION) instead of failing the
 *  whole pods-list decode. */
@Serializable
data class DaemonStatusReportWire(
    val serverDomain: String = "",
    val certSha256: String? = null,
    val certValidUntil: Long? = null,
    val certIssuer: String? = null,
    val appsServed: List<String> = emptyList(),
    val nonce: String = "",
    val issuedAt: Long = 0,
)

/** `signedStatus` on a `/pods` pod: the verbatim report + the box's STK
 *  signature over its canonical bytes. `.com` can relay or drop this but
 *  cannot forge it — the phone re-verifies under a LOCALLY derived STK. */
@Serializable
data class SignedDaemonStatus(
    val report: DaemonStatusReportWire? = null,
    val signatureHex: String = "",
)

@Serializable
data class PodDirectoryEntry(
    val serverDomain: String,
    val identityPubKey: String,   // hex (32 bytes) — the STK
    val revokedAt: Long? = null,
    /** Wall-clock ms of the box's last daemon-status check-in, or null if the
     *  daemon has NEVER reported. A registered server with `lastReported ==
     *  null` AND no cert is a "registered but never came online" box. The
     *  field was already in the /pods response; the phone derives `cameOnline`
     *  from it client-side (no backend change). Mirror of iOS. */
    val lastReported: Long? = null,
    /** Wall-clock ms the box's registration was admitted (`registeredAt` in the
     *  `/pods` wire response). Threaded so the phone can compute a "coming
     *  online" grace window. null ⇒ a pre-field Worker (treated as 0 = no grace).
     *  Mirror of iOS PodDirectoryEntry.registeredAt. */
    val registeredAt: Long? = null,
    /** Present when the daemon has reported a real cert. Decoded as a presence
     *  signal for `cameOnline`. */
    val currentCert: PodCurrentCert? = null,
    /** A′ pinning — the STK-signed daemon-status report relayed verbatim, or
     *  null when the daemon never reported (or `.com` dropped it). Consumed by
     *  core.CertPinRegistry; defaulted for mixed-deploy tolerance. */
    val signedStatus: SignedDaemonStatus? = null,
    /** Cheap directory signal: the box has a LIVE boot-unlock request parked
     *  right now. Lets the phone show "waiting for approval" for a locked box
     *  (instead of "never came online") without the biometric mailbox read.
     *  Defaulted ⇒ absent on a pre-field Worker is false. Mirror of iOS. */
    val awaitingUnlock: Boolean = false,
    /** Same idea for the entitlement relay: the box posted its entitlement
     *  secret-request and is "waiting for approval" (authorize it to serve), NOT
     *  "never came online". Part of the Box Request Inbox digest
     *  (docs/box-request-inbox.md). Defaulted ⇒ absent on a pre-field Worker is
     *  false. Mirror of iOS. */
    val awaitingEntitlement: Boolean = false,
) {
    /** A box that has reported daemon status OR holds a cert has come online
     *  at least once. Mirror of iOS PodDirectoryEntry.cameOnline. */
    val cameOnline: Boolean get() = lastReported != null || currentCert != null
}

/** #56 — an active outstanding install order, surfaced in the SAME
 *  unauthenticated `/pods` response as registered servers. A just-created,
 *  not-yet-registered server now rides this list instead of the fragile
 *  biometric-IRK `outstanding-orders` path, so a list refresh triggers NO
 *  biometric prompt. Mirrors control-plane `PendingPodEntry` /
 *  iOS `PendingPodEntry`.
 *
 *  `orderRef` — NOT the raw auth-code serial — identifies the order:
 *  `hex(sha256("flagship/order-ref/v1|" + serial))` (core.OrderRef). The
 *  serial is a provision-status write capability, so it never rides this
 *  unauthenticated response; a device that minted the order computes the
 *  same ref locally to reconcile, and keeps polling deep install progress
 *  with its locally-stored serial. Defaulted for mixed-deploy tolerance. */
@Serializable
data class PendingPodEntry(
    val orderRef: String = "",
    val serverName: String,
    /** `<serverName>.<username>.flagship.services` — the reserved FQDN,
     *  identical whether or not the box has registered yet. */
    val fqdn: String,
    /** Latest reported provisioning phase, or null on any lookup failure. */
    val phase: String? = null,
    val createdAt: Long = 0,
    val state: String = "pending",
)

@Serializable
data class PodsDirectoryResponse(
    val username: String,
    val pods: List<PodDirectoryEntry> = emptyList(),
    /** #56 — active outstanding orders, merged into the same fetch. Has a
     *  default so a pre-#56 Worker response (no `pending` key) still decodes. */
    val pending: List<PendingPodEntry> = emptyList(),
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
    bootBaseUrl: String = DEFAULT_BOOT_BASE_URL,
    /** A′ pinning — observer invoked with every decoded `/pods` response so
     *  the wiring layer can feed core.CertPinRegistry. LIVE-only by
     *  construction (the mock never calls it ⇒ demo/mock sessions can never
     *  install pins). Failures are swallowed: pin maintenance must never
     *  break the directory fetch or list rendering. */
    private val onPods: ((PodsDirectoryResponse) -> Unit)? = null,
) : SecretMailboxClient {
    private val base = baseUrl.trimEnd('/')
    private val bootBase = bootBaseUrl.trimEnd('/')

    companion object {
        /** Control-plane apex + boot sub-origin, via [Endpoints] (prod-default
         *  + test override). The dedicated boot worker — lease deposit/revoke
         *  + sealed-response post land there (separate host so an enterprise
         *  clone can self-host). */
        val DEFAULT_BASE_URL: String get() = Endpoints.controlBaseUrl
        val DEFAULT_BOOT_BASE_URL: String get() = Endpoints.bootBaseUrl
    }

    override suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse =
        // The list is IRK-signed in the body; the Worker exposes it as POST
        // as well as GET (a GET with a body is awkward for OkHttp).
        transport.postJsonForResponse(
            "$base/api/secret-requests", auth,
            serializer = MailboxAuthEnvelope.serializer(),
            responseSerializer = SecretRequestsResponse.serializer(),
        )

    override suspend fun postResponse(response: SecretResponseBody, bootAuth: String) {
        val bytes = transport.json
            .encodeToString(BootResponsePost.serializer(), BootResponsePost(response))
            .toByteArray(Charsets.UTF_8)
        transport.execute(
            method = "POST",
            url = "$bootBase/api/boot/response",
            body = bytes,
            contentType = "application/json",
            extraHeaders = mapOf("Authorization" to bootAuth),
            accept = setOf(200, 201, 204),
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
        val response = transport.getJson(
            "$base/api/users/$encoded/pods",
            responseSerializer = PodsDirectoryResponse.serializer(),
        )
        onPods?.let { observe -> runCatching { observe(response) } }
        return response
    }

    override suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) {
        val bytes = transport.json
            .encodeToString(LeaseDepositPost.serializer(), LeaseDepositPost(lease, signatureHex))
            .toByteArray(Charsets.UTF_8)
        transport.execute(
            method = "PUT",
            url = "$bootBase/api/boot/lease",
            body = bytes,
            contentType = "application/json",
            extraHeaders = mapOf("Authorization" to bootAuth),
            accept = setOf(200, 201),
        )
    }

    override suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) {
        // FQDN + hex leaseId are URL-safe, so the literal path matches the
        // one the bootAuth signature commits to (the gate binds it exactly).
        transport.execute(
            method = "DELETE",
            url = "$bootBase/api/boot/lease/${request.serverDomain}/${request.leaseId}",
            body = null,
            contentType = null,
            extraHeaders = mapOf("Authorization" to bootAuth),
            accept = setOf(200, 204),
        )
    }

    override suspend fun depositPairing(serverDomain: String, body: PairingDepositBody) {
        // The pairing deposit is on `.com` (identity plane), not the boot worker.
        val encoded = java.net.URLEncoder.encode(serverDomain, "UTF-8")
        val bytes = transport.json
            .encodeToString(PairingDepositBody.serializer(), body)
            .toByteArray(Charsets.UTF_8)
        transport.execute(
            method = "POST",
            url = "$base/api/server/$encoded/pairing-deposit",
            body = bytes,
            contentType = "application/json",
            accept = setOf(200),
        )
    }

    override suspend fun depositEntitlement(serverDomain: String, body: PairingDepositBody) {
        val encoded = java.net.URLEncoder.encode(serverDomain, "UTF-8")
        val bytes = transport.json
            .encodeToString(PairingDepositBody.serializer(), body)
            .toByteArray(Charsets.UTF_8)
        transport.execute(
            method = "POST",
            url = "$base/api/server/$encoded/entitlement-deposit",
            body = bytes,
            contentType = "application/json",
            accept = setOf(200),
        )
    }
}

// MARK: - Mock

/** In-memory mailbox for previews / tests / the unconfigured default. */
class MockSecretMailboxClient : SecretMailboxClient {
    var pending: List<PendingSecretRequest> = emptyList()
    var directory: List<PodDirectoryEntry> = emptyList()
    /** #56 — outstanding install orders surfaced by [fetchPods] alongside
     *  the registered [directory]. */
    var pendingOrders: List<PendingPodEntry> = emptyList()
    var sealedLuksKeyHex: String? = null
    var lastPostedAuth: MailboxAuthEnvelope? = null
    var lastPostedResponse: SecretResponseBody? = null
    var usernameForResponses: String = "demo"
    val deposited: MutableList<Triple<BoxSealedLeaseWire, String, String>> = mutableListOf()
    val revoked: MutableList<Pair<LeaseRevokeWire, String>> = mutableListOf()
    val postedResponses: MutableList<Pair<SecretResponseBody, String>> = mutableListOf()

    override suspend fun fetchPendingRequests(auth: MailboxAuthEnvelope): SecretRequestsResponse {
        lastPostedAuth = auth
        return SecretRequestsResponse(auth.auth.username, pending)
    }

    override suspend fun postResponse(response: SecretResponseBody, bootAuth: String) {
        lastPostedResponse = response
        postedResponses.add(response to bootAuth)
    }

    override suspend fun fetchSealedLuksKey(serverDomain: String): SealedLuksKeyResponse {
        val hex = sealedLuksKeyHex ?: throw HttpException(404, "no sealed key on file")
        return SealedLuksKeyResponse(serverDomain, hex, 1L)
    }

    override suspend fun fetchPods(username: String): PodsDirectoryResponse =
        PodsDirectoryResponse(username, directory, pendingOrders)

    override suspend fun depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) {
        deposited.add(Triple(lease, signatureHex, bootAuth))
    }

    override suspend fun revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) {
        revoked.add(request to bootAuth)
    }

    val pairingDeposits: MutableList<Pair<String, PairingDepositBody>> = mutableListOf()
    override suspend fun depositPairing(serverDomain: String, body: PairingDepositBody) {
        pairingDeposits.add(serverDomain to body)
    }

    val entitlementDeposits: MutableList<Pair<String, PairingDepositBody>> = mutableListOf()
    override suspend fun depositEntitlement(serverDomain: String, body: PairingDepositBody) {
        entitlementDeposits.add(serverDomain to body)
    }
}
