// Kotlin mirror of FlagshipAPI/Client/FlagshipServerClient.swift.
//
// Pre-pairing endpoints on flagshipserver.com (the Worker). The phone
// hits these to mint an InstallBlob before delivering it through the
// QR-relay WebSocket, plus the post-pairing push + recovery surfaces.
//
// MIRRORS: apps/com/src/route.ts (v2 relay branch). Wire shapes are
// byte-identical to the Swift side — the Worker treats requests from
// both clients the same.

package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

interface FlagshipServerClient {
    suspend fun claimUsername(req: UsernameClaimRequest)
    suspend fun issueAuthCode(req: AuthCodeIssueRequest)
    suspend fun registerRck(req: RckRegisterRequest)
    /** Revoke an outstanding auth-code so a never-booted server can't
     *  register with this serial. User-facing this is "Cancel order".
     *  404 (already gone) is treated as success by both Mock + Live. */
    suspend fun revokeAuthCode(req: AuthCodeRevokeRequest)
    suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse
    suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse
    suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope
    /** Register an FCM device token with .com so the Worker can relay
     *  encrypted push payloads. Returns a handle to later revoke. */
    suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse
    /** Drop a previously-registered push token. 404 is success so
     *  sign-out doesn't surface "already cleaned up" as an error. */
    suspend fun revokePushToken(tokenId: String)
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
data class AuthCodeRevokeRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val serial: String,
        val username: String,
        val issuedAt: Long,
    )
}

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
    /** When non-null, the typed username matched a Worker-side test-
     *  account entry (env.TEST_ACCOUNTS). Mobile clients branch on
     *  this BEFORE checking `available` — a test-account hit returns
     *  available=false to keep accidental claims impossible, while
     *  this field tells the client to enter the sandbox demo flow. */
    val testAccount: TestAccountMeta? = null,
)

@Serializable
data class TestAccountMeta(
    /** Human-readable label rendered in the "Enter <X>" CTA. */
    val display: String,
    /** Informational: every how-many-hours the sandbox state resets.
     *  The actual reset cron lives on the Worker; mobile just tooltips
     *  this so reviewers know what they're walking into. */
    val ttlHours: Int = 24,
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

/** POST /api/push/register canonical-bytes envelope. Inner shape mirrors
 *  the protocol tag `flagship/push-token-register/v1` exactly. */
@Serializable
data class PushTokenRegisterRequest(
    val request: Inner,
    val signature: String,           // hex, IRK
) {
    @Serializable
    data class Inner(
        val username: String,
        val platform: String,        // "apns" | "fcm" | "webpush"
        val providerToken: String,   // FCM token (verbatim) / APNs hex (lowercased)
        val pushX25519Pub: String,   // hex
        val issuedAt: Long,
    )
}

@Serializable
data class PushTokenRegisterResponse(
    val ok: Boolean,
    val tokenId: String,
)

// ── Mock ──────────────────────────────────────────────────────────

class MockFlagshipServerClient(
    var simulatedLatencyMs: Long = 200,
    var shouldFail: Boolean = false,
    var reservedUsernames: Set<String> = setOf("root", "admin", "flagship", "system", "support"),
    /** Mirror of the Worker's env.TEST_ACCOUNTS map. Mock tests can
     *  populate this to drive the test-account branch of the
     *  availability check; production uses the real Worker which reads
     *  its own off-git secret. */
    var testAccounts: Map<String, TestAccountMeta> = emptyMap(),
) : FlagshipServerClient {
    private val recoveryStore = mutableMapOf<String, RecoveryEnvelope>()
    private val _claimedUsernames = mutableMapOf<String, String>()       // username → irkPub
    private val _issuedAuthCodes = mutableMapOf<String, AuthCodeWire>()  // serial → wire
    private val _revokedAuthCodes = mutableSetOf<String>()
    private val _registeredRcks = mutableMapOf<String, String>()         // subdomain → rckPubKey
    private val _registeredPushTokens = mutableMapOf<String, PushTokenRegisterRequest.Inner>()
    private var nextPushTokenId = 1

    val claimedUsernames: Map<String, String> get() = _claimedUsernames
    val issuedAuthCodes: Map<String, AuthCodeWire> get() = _issuedAuthCodes
    val revokedAuthCodes: Set<String> get() = _revokedAuthCodes
    val registeredRcks: Map<String, String> get() = _registeredRcks
    val registeredPushTokens: Map<String, PushTokenRegisterRequest.Inner> get() = _registeredPushTokens

    private suspend fun tick() {
        if (simulatedLatencyMs > 0) kotlinx.coroutines.delay(simulatedLatencyMs)
        if (shouldFail) throw HttpException(503, "simulated failure")
    }

    override suspend fun claimUsername(req: UsernameClaimRequest) {
        tick()
        val u = req.request.username.lowercase()
        val prior = _claimedUsernames[u]
        if (prior != null && prior != req.request.irkPub) throw HttpException(409, "username taken")
        _claimedUsernames[u] = req.request.irkPub
    }

    override suspend fun issueAuthCode(req: AuthCodeIssueRequest) {
        tick()
        _issuedAuthCodes[req.code.serial] = req.code
    }

    override suspend fun registerRck(req: RckRegisterRequest) {
        tick()
        _registeredRcks[req.request.subdomain] = req.request.rckPubKey
    }

    override suspend fun revokeAuthCode(req: AuthCodeRevokeRequest) {
        tick()
        _revokedAuthCodes += req.request.serial
    }

    override suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse {
        tick()
        val lower = username.lowercase()
        // Test-account match precedes every other rule so a typed
        // value that looks "invalid" by length / regex (e.g. has
        // hyphens) still surfaces the testAccount block when the
        // Worker has it on the secret list.
        testAccounts[lower]?.let {
            return UsernameAvailabilityResponse(
                username = lower,
                available = false,
                reason = "test account",
                testAccount = it,
            )
        }
        if (lower.length < 2 || lower.length > 32) {
            return UsernameAvailabilityResponse(lower, false, "Must be 2–32 chars.")
        }
        if (lower in reservedUsernames) {
            return UsernameAvailabilityResponse(lower, false, "Reserved.")
        }
        if (!lower.matches(Regex("^[a-z0-9]+$"))) {
            return UsernameAvailabilityResponse(lower, false, "Letters and digits only.")
        }
        val prior = _claimedUsernames[lower]
        if (prior != null && prior != "_self") {
            return UsernameAvailabilityResponse(lower, false, "Already claimed.")
        }
        return UsernameAvailabilityResponse(lower, true, null)
    }

    override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse {
        tick()
        recoveryStore[req.credentialId] = RecoveryEnvelope(
            credentialId = req.credentialId,
            wrappedUmkBase64 = req.wrappedUmkBase64,
            nonceBase64 = req.nonceBase64,
        )
        return RecoveryEnvelopeResponse(ok = true)
    }

    override suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope {
        tick()
        return recoveryStore[credentialId] ?: throw HttpException(404, "no envelope")
    }

    override suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse {
        tick()
        val id = "tok_%06d".format(nextPushTokenId++)
        _registeredPushTokens[id] = req.request
        return PushTokenRegisterResponse(ok = true, tokenId = id)
    }

    override suspend fun revokePushToken(tokenId: String) {
        tick()
        _registeredPushTokens.remove(tokenId)
    }
}

// ── Live ──────────────────────────────────────────────────────────

class LiveFlagshipServerClient(
    private val transport: JsonHttpTransport,
    baseUrl: String = DEFAULT_BASE_URL,
) : FlagshipServerClient {
    private val base = baseUrl.trimEnd('/')

    companion object {
        const val DEFAULT_BASE_URL = "https://flagshipserver.com"
    }

    override suspend fun claimUsername(req: UsernameClaimRequest) {
        // 409 (already-claimed-by-same-IRK) is idempotent success
        transport.postJson(
            "$base/api/username/claim", req,
            serializer = UsernameClaimRequest.serializer(),
            accept = setOf(200, 201, 204, 409),
        )
    }

    override suspend fun issueAuthCode(req: AuthCodeIssueRequest) {
        transport.postJson(
            "$base/api/auth-code/issue", req,
            serializer = AuthCodeIssueRequest.serializer(),
        )
    }

    override suspend fun registerRck(req: RckRegisterRequest) {
        transport.postJson(
            "$base/api/routing/register-rck", req,
            serializer = RckRegisterRequest.serializer(),
        )
    }

    override suspend fun revokeAuthCode(req: AuthCodeRevokeRequest) {
        val encodedSerial = java.net.URLEncoder.encode(req.request.serial, "UTF-8")
        transport.postJson(
            "$base/api/auth-code/$encodedSerial/revoke", req,
            serializer = AuthCodeRevokeRequest.serializer(),
            accept = setOf(200, 201, 204, 403, 404),
        )
    }

    override suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse =
        transport.postJsonForResponse(
            "$base/api/users/check",
            UsernameAvailabilityCheckBody(username),
            serializer = UsernameAvailabilityCheckBody.serializer(),
            responseSerializer = UsernameAvailabilityResponse.serializer(),
        )

    override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse =
        transport.postJsonForResponse(
            "$base/api/recovery/register", req,
            serializer = RecoveryEnvelopeRequest.serializer(),
            responseSerializer = RecoveryEnvelopeResponse.serializer(),
        )

    override suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope {
        val encoded = java.net.URLEncoder.encode(credentialId, "UTF-8")
        return transport.getJson(
            "$base/api/recovery/fetch?credentialId=$encoded",
            responseSerializer = RecoveryEnvelope.serializer(),
        )
    }

    override suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse =
        transport.postJsonForResponse(
            "$base/api/push/register", req,
            serializer = PushTokenRegisterRequest.serializer(),
            responseSerializer = PushTokenRegisterResponse.serializer(),
        )

    override suspend fun revokePushToken(tokenId: String) {
        val encoded = java.net.URLEncoder.encode(tokenId, "UTF-8")
        transport.deleteJson("$base/api/push/$encoded", accept = setOf(200, 204, 404))
    }
}

@Serializable
private data class UsernameAvailabilityCheckBody(@SerialName("username") val username: String)
