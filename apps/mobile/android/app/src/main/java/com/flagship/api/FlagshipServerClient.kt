// Kotlin mirror of FlagshipAPI/Client/FlagshipServerClient.swift.
//
// Pre-pairing endpoints on flagshipserver.com (the Worker). The phone
// hits these to mint an InstallBlob before delivering it through the
// QR-relay WebSocket.
//
// MIRRORS: apps/com/src/route.ts (v2 relay branch)
// Keep wire shapes byte-identical to the Swift side — the Worker treats
// requests from both clients the same.

package com.flagship.api

import kotlinx.serialization.Serializable

interface FlagshipServerClient {
    suspend fun claimUsername(req: UsernameClaimRequest)
    suspend fun issueAuthCode(req: AuthCodeIssueRequest)
    suspend fun registerRck(req: RckRegisterRequest)
    suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse
    suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse
    suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope
}

@Serializable
data class UsernameClaimRequest(
    val request: Inner,
    val signature: String,           // hex, IRK over canonical bytes
) {
    @Serializable
    data class Inner(
        val username: String,
        val irkPub: String,          // hex
        val issuedAt: Long,
    )
}

@Serializable
data class AuthCodeIssueRequest(
    val code: AuthCodeWire,
    val signature: String,
)

@Serializable
data class AuthCodeWire(
    val version: Int,
    val serial: String,
    val username: String,
    val serverName: String,
    val serverDomain: String,
    val delegatedPubKey: String,     // hex
    val userPubKey: String,          // hex
    val issuedAt: Long,
    val expiresAt: Long,
)

@Serializable
data class RckRegisterRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val subdomain: String,
        val rckPubKey: String,       // hex
        val issuedAt: Long,
    )
}

@Serializable
data class UsernameAvailabilityResponse(
    val username: String,
    val available: Boolean,
    val reason: String? = null,
)

@Serializable
data class RecoveryEnvelopeRequest(
    val credentialId: String,
    val wrappedUmkBase64: String,
    val nonceBase64: String,
)

@Serializable
data class RecoveryEnvelopeResponse(val ok: Boolean)

@Serializable
data class RecoveryEnvelope(
    val credentialId: String,
    val wrappedUmkBase64: String,
    val nonceBase64: String,
)
