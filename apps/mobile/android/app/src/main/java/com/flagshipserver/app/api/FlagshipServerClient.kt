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

    /** List the peer-class trusted devices on the user's account.
     *  Returns the ETag the Worker computed so the caller can pass
     *  it as `If-Match` on revocation / rotation requests, fencing
     *  the device-list-changed-mid-action race (cf. Worker A3).
     *  Worker side: GET /api/users/:u/devices. */
    suspend fun listDevices(username: String): TrustedDevicesListResponse

    /** Account-level audit log surfaced via /api/users/:u/audit. Used
     *  by the Activity feed to render device-disconnect / device-
     *  replaced / wipe-restart / recovery-set-up events alongside
     *  the daemon-side install events. `sinceSeq` is exclusive lower
     *  bound; `limit` is clamped server-side to 50. */
    suspend fun listAuditEvents(username: String, sinceSeq: Int = 0, limit: Int = 20): AuditEventListResponse

    /** Returns true iff a cloud-stored recovery envelope exists for
     *  the given username. Powers the Home recovery-setup nudge (C9).
     *  Underlying endpoint: GET /api/recovery/by-username/<u> — 200
     *  means yes, 404 means no, anything else surfaces as exception
     *  so the caller can decide retry vs. silent-skip. */
    suspend fun hasCloudRecovery(username: String): Boolean

    /** C7 — initiate IRK rotation. POSTs the NEW-IRK-signed envelope
     *  to /api/users/:u/re-pair. Optional `ifMatch` ETag fences the
     *  concurrent-rotation race (Worker A3). */
    suspend fun initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?,
    ): RePairInitiateResponse

    /** C7 — finalize a pending re-pair after the 24-hour grace.
     *  Public read; 425 = grace not elapsed, 409 = objected, 200 = swap done. */
    suspend fun completeRePair(username: String): RePairCompleteResponse

    /** E4 — atomic Wipe & restart. Rotates IRK + recovery envelope
     *  in one server transaction. Body carries OLD-IRK signature
     *  over canonical flagship/wipe-restart/v1 bytes. */
    suspend fun wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?,
    ): WipeRestartResponse
}

@Serializable
data class WipeRestartRequest(
    val request: Inner,
    val signature: String,
    val idempotencyKey: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val oldIrkPub: String,
        val newIrkPub: String,
        val newCredentialId: String,
        val newWrappedUmk: String,  // base64
        val issuedAt: Long,
    )
}

@Serializable
data class WipeRestartResponse(
    val ok: Boolean,
    val auditSeq: Int,
    val newIrkPub: String,
    val etag: String? = null,
)

@Serializable
data class RePairInitiateRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val newIrkPub: String,   // hex
        val oldIrkPub: String,   // hex
        val issuedAt: Long,      // ms
    )
}

@Serializable
data class RePairInitiateResponse(
    val ok: Boolean,
    val completesAt: Long,
    val graceMs: Long,
)

@Serializable
data class RePairCompleteResponse(
    val ok: Boolean,
    val newIrkPub: String,
    val swappedAt: Long,
)

@Serializable
data class AuditEvent(
    val seq: Int,
    val eventKind: String,    // "device-disconnected" | "device-replaced" | …
    val detail: String,
    val devicePrefix: String,
    val postedAt: Long,
)

@Serializable
data class AuditEventListResponse(
    val events: List<AuditEvent>,
)

@Serializable
data class TrustedDevice(
    val tokenId: String,
    val tokenPrefix: String,
    val label: String,
    val platform: String,        // "apns" | "fcm" | "webpush"
    val addedAt: Long,
    val lastSeenAt: Long,
)

/**
 * Response wrapper that surfaces the ETag header alongside the body.
 * Callers feed the ETag to subsequent /re-pair and /api/push/<id>
 * requests as If-Match so a Worker-side device-list change between
 * fetch and action yields a 412 instead of a half-applied rotation.
 */
data class TrustedDevicesListResponse(
    val devices: List<TrustedDevice>,
    /** Server-supplied ETag for the snapshot (form `W/"hex"`).
     *  Null only when the Mock impl didn't compute one. */
    val etag: String?,
)

/** On-wire shape — separate from TrustedDevicesListResponse so the
 *  header-only ETag doesn't bleed into the @Serializable body type. */
@Serializable
private data class TrustedDevicesWireBody(val devices: List<TrustedDevice>)

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
 *  the protocol tag `flagship/push-token-register/v1` exactly. The
 *  `label` field slots between `pushX25519Pub` and `issuedAt`, matching
 *  the Worker side (packages/protocol/src/auth.ts). */
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
        /** User-facing device label ("Pixel 8 — kitchen"). Surfaced in
         *  the Trusted-devices list on .com. Part of the canonical
         *  bytes the IRK signs over. */
        val label: String,
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

    /** Scripted devices listing per username for tests + dev mode. */
    var devicesByUser: Map<String, List<TrustedDevice>> = emptyMap()

    /** Scripted audit log per username — tests configure to drive
     *  Activity feed renders without hitting the Worker. */
    var auditEventsByUser: Map<String, List<AuditEvent>> = emptyMap()

    /** Scripted recovery enrollment per username. Drives the C9 Home
     *  nudge in tests. Unconfigured users default to `false` — the
     *  "fresh install, no envelope yet" baseline. */
    var cloudRecoveryByUser: Map<String, Boolean> = emptyMap()

    override suspend fun hasCloudRecovery(username: String): Boolean {
        tick()
        return cloudRecoveryByUser[username.lowercase()] ?: false
    }

    /** Drives initiate outcomes in tests. */
    sealed interface RePairBehavior {
        data object Ok : RePairBehavior
        data class StaleEtag(val currentEtag: String) : RePairBehavior
        data object AlreadyPending : RePairBehavior
    }
    var rePairBehavior: RePairBehavior = RePairBehavior.Ok
    var lastRePairInitiate: Triple<String, RePairInitiateRequest, String?>? = null
        private set

    override suspend fun initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?,
    ): RePairInitiateResponse {
        tick()
        lastRePairInitiate = Triple(username, body, ifMatch)
        return when (val b = rePairBehavior) {
            is RePairBehavior.StaleEtag ->
                throw IllegalStateException("412 currentEtag=${b.currentEtag}")
            RePairBehavior.AlreadyPending ->
                throw IllegalStateException("409 already-pending")
            RePairBehavior.Ok -> RePairInitiateResponse(
                ok = true,
                completesAt = System.currentTimeMillis() + 24L * 3600 * 1000,
                graceMs = 24L * 3600 * 1000,
            )
        }
    }

    override suspend fun completeRePair(username: String): RePairCompleteResponse {
        tick()
        return RePairCompleteResponse(
            ok = true,
            newIrkPub = "00",
            swappedAt = System.currentTimeMillis(),
        )
    }

    sealed interface WipeRestartBehavior {
        data object Ok : WipeRestartBehavior
        data object RateLimited : WipeRestartBehavior
        data class StaleEtag(val currentEtag: String) : WipeRestartBehavior
        data object ConcurrentRotation : WipeRestartBehavior
    }
    var wipeRestartBehavior: WipeRestartBehavior = WipeRestartBehavior.Ok
    var lastWipeRestart: Triple<String, WipeRestartRequest, String?>? = null
        private set

    override suspend fun wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?,
    ): WipeRestartResponse {
        tick()
        lastWipeRestart = Triple(username, body, ifMatch)
        return when (wipeRestartBehavior) {
            WipeRestartBehavior.Ok -> WipeRestartResponse(
                ok = true,
                auditSeq = 42,
                newIrkPub = body.request.newIrkPub,
                etag = "W/\"post-wipe\"",
            )
            WipeRestartBehavior.RateLimited ->
                throw IllegalStateException("429 wipe-restart rate-limited")
            is WipeRestartBehavior.StaleEtag ->
                throw IllegalStateException("412 stale-etag")
            WipeRestartBehavior.ConcurrentRotation ->
                throw IllegalStateException("409 concurrent rotation")
        }
    }

    override suspend fun listAuditEvents(username: String, sinceSeq: Int, limit: Int): AuditEventListResponse {
        tick()
        val all = auditEventsByUser[username.lowercase()] ?: emptyList()
        val filtered = all.filter { it.seq > sinceSeq }.sortedByDescending { it.seq }
        val cappedLimit = limit.coerceIn(1, 50)
        return AuditEventListResponse(events = filtered.take(cappedLimit))
    }

    override suspend fun listDevices(username: String): TrustedDevicesListResponse {
        tick()
        val rows = devicesByUser[username.lowercase()] ?: emptyList()
        val sorted = rows.sortedWith(compareBy({ it.addedAt }, { it.tokenId }))
        return TrustedDevicesListResponse(devices = sorted, etag = etagFor(sorted))
    }

    private fun etagFor(devices: List<TrustedDevice>): String {
        // Identity-significant subset only; lastSeenAt deliberately
        // excluded so test push-delivery doesn't flutter the ETag.
        // FNV-1a over a byte-feed of the identity fields. Mirrors the
        // Swift MockFlagshipServerClient.etagFor exactly so a future
        // cross-client test can verify byte-for-byte parity.
        var h: ULong = 14695981039346656037uL
        fun feedString(s: String) {
            for (b in s.toByteArray(Charsets.UTF_8)) {
                h = h xor (b.toInt() and 0xff).toULong()
                h *= 1099511628211uL
            }
            h = h xor 0x1fuL; h *= 1099511628211uL
        }
        fun feedLong(n: Long) {
            for (shift in 0 until 64 step 8) {
                h = h xor ((n.toULong() shr shift) and 0xffuL)
                h *= 1099511628211uL
            }
            h = h xor 0x1fuL; h *= 1099511628211uL
        }
        for (d in devices) {
            feedString(d.tokenId); feedString(d.label); feedString(d.platform); feedLong(d.addedAt)
        }
        val hex = h.toString(16).padStart(16, '0').takeLast(16)
        return "W/\"$hex\""
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

    override suspend fun listDevices(username: String): TrustedDevicesListResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        // execute(...) so we can read the ETag header. The
        // convenience getJson(...) only surfaces the body.
        val resp = transport.execute(
            method = "GET",
            url = "$base/api/users/$encoded/devices",
            accept = setOf(200),
        )
        val body = transport.json.decodeFromString(
            TrustedDevicesWireBody.serializer(),
            resp.body.decodeToString(),
        )
        val etag = resp.headers.entries.firstOrNull { it.key.equals("etag", ignoreCase = true) }?.value
        return TrustedDevicesListResponse(devices = body.devices, etag = etag)
    }

    override suspend fun listAuditEvents(username: String, sinceSeq: Int, limit: Int): AuditEventListResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val since = sinceSeq.coerceAtLeast(0)
        val capped = limit.coerceIn(1, 50)
        return transport.getJson(
            "$base/api/users/$encoded/audit?since=$since&limit=$capped",
            responseSerializer = AuditEventListResponse.serializer(),
        )
    }

    override suspend fun hasCloudRecovery(username: String): Boolean {
        // GET /api/recovery/by-username/<u> — 200 means an envelope
        // exists, 404 means it doesn't. The transport's `accept` set
        // lets us treat both as success and inspect the status code
        // after the call returns.
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val resp = transport.execute(
            method = "GET",
            url = "$base/api/recovery/by-username/$encoded",
            accept = setOf(200, 404),
        )
        return resp.status == 200
    }

    override suspend fun initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?,
    ): RePairInitiateResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/re-pair",
            body = body,
            serializer = RePairInitiateRequest.serializer(),
            responseSerializer = RePairInitiateResponse.serializer(),
            extraHeaders = ifMatch?.let { mapOf("If-Match" to it) } ?: emptyMap(),
        )
    }

    override suspend fun completeRePair(username: String): RePairCompleteResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val resp = transport.execute(
            method = "POST",
            url = "$base/api/users/$encoded/re-pair/complete",
            accept = setOf(200),
        )
        return transport.json.decodeFromString(
            RePairCompleteResponse.serializer(),
            resp.body.decodeToString(),
        )
    }

    override suspend fun wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?,
    ): WipeRestartResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/wipe-restart",
            body = body,
            serializer = WipeRestartRequest.serializer(),
            responseSerializer = WipeRestartResponse.serializer(),
            extraHeaders = ifMatch?.let { mapOf("If-Match" to it) } ?: emptyMap(),
        )
    }
}

@Serializable
private data class UsernameAvailabilityCheckBody(@SerialName("username") val username: String)
