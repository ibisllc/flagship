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

    /** V3 — rename the user-visible URL stem for a service. Signed by
     *  the user's current IRK. The Worker upserts the alias,
     *  cascade-deletes old voi.ci codes, mints a fresh one. */
    suspend fun renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest,
    ): AppRenameResponse

    /** V3 — read the per-user URL identity of a service:
     *  { displayLabel, canonicalUrl, instances, shortUrl,
     *    customDomain, customDomainConfirmed }. */
    suspend fun getAppLinks(
        username: String,
        serviceId: String,
    ): AppLinksResponse

    /** #79A — attach an external (custom) domain to a service. Signed by
     *  the user's current IRK. Decoupled request/confirm: a 200 only
     *  RECORDS the request (.com verifies the CNAME out-of-band and
     *  pushes the outcome later); the ONLY synchronous denial is the
     *  300s rate limit (429 "Too soon — try again in Ns.", byte-
     *  identical to the Mock). On success returns the refreshed links
     *  so callers surface the domain optimistically. */
    suspend fun setCustomDomain(
        username: String,
        serviceId: String,
        body: SetCustomDomainRequest,
    ): AppLinksResponse

    /** v1.2 Phase 4 — read the account-type / TOTP-enrolled state for
     *  the Settings security badge. Maps to GET /api/users/:u. */
    suspend fun getUsernameRecord(username: String): UsernameLookupResponse

    /** v1.2 Phase 3/4 — begin TOTP enrollment. IRK-signed envelope
     *  over canonical `flagship/totp-enroll-begin/v1` bytes. */
    suspend fun totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest,
    ): TotpEnrollBeginResponse

    /** v1.2 Phase 3/4 — finalize TOTP enrollment. Returns 10 single-
     *  use recovery codes ONCE; the UI must gate dismissal behind an
     *  explicit "I've saved these" confirmation. */
    suspend fun totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest,
    ): TotpEnrollConfirmResponse

    /** v1.2 Phase 3 — disable TOTP and flip back to single-device. */
    suspend fun totpDisable(
        username: String,
        body: TotpDisableRequest,
    ): TotpDisableResponse
}

@Serializable
data class AppRenameRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val serviceId: String,
        val newDisplayLabel: String,
        val issuedAt: Long,
    )
}

@Serializable
data class AppRenameResponse(
    val ok: Boolean,
    val displayLabel: String? = null,
    val canonicalUrl: String? = null,
    val shortUrl: String? = null,
    val shortCode: String? = null,
    val unchanged: Boolean? = null,
)

@Serializable
data class AppLinkInstance(
    val serverDomain: String,
    val url: String,
)

@Serializable
data class AppLinksResponse(
    val serviceId: String,
    val displayLabel: String,
    val canonicalUrl: String,
    val instances: List<AppLinkInstance>,
    val shortUrl: String? = null,
    /** #79A — the bound external domain (present as soon as the order
     *  is recorded, even pending). A Replace never clears it. */
    val customDomain: String? = null,
    /** True once .com flips the order active. The apps-list short→
     *  custom swap keys on this; null/false = still pending. */
    val customDomainConfirmed: Boolean? = null,
)

@Serializable
data class SetCustomDomainRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val serviceId: String,
        val fqdn: String,
        val issuedAt: Long,
    )
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
    /** v1.2 Phase 4 — wall-clock ms before which this device cannot
     *  revoke another device on the account. Null / 0 / past = the
     *  14-day quarantine has elapsed (or never applied). A future
     *  value tells the UI to show a clock indicator + disable the
     *  Remove / Replace actions. */
    val quarantineUntil: Long? = null,
) {
    /** Convenience for the UI; returns true iff the quarantine window
     *  is in the future relative to [now]. */
    fun isQuarantined(now: Long = System.currentTimeMillis()): Boolean {
        val until = quarantineUntil ?: return false
        return until > 0 && until > now
    }
}

/**
 * v1.2 Phase 4 — GET /api/users/:u response shape. Mirrors the iOS
 * UsernameLookupResponse exactly. The TOTP secret itself is NEVER
 * returned here; only the enrolled-at timestamp (non-sensitive).
 */
@Serializable
data class UsernameLookupResponse(
    val username: String,
    val irkPub: String,
    val claimedAt: Long,
    /** "single" or "multi". Pre-migration rows default to "single". */
    val accountType: String,
    /** Wall-clock ms of the successful TOTP enroll-confirm, or null. */
    val totpEnrolledAt: Long? = null,
)

/** v1.2 Phase 3 — POST /api/users/:u/totp/enroll-begin. */
@Serializable
data class TotpEnrollBeginRequest(
    val request: Inner,
    val signature: String,  // hex
) {
    @Serializable
    data class Inner(
        val username: String,
        val issuedAt: Long,
    )
}

@Serializable
data class TotpEnrollBeginResponse(
    /** Base32 secret for manual entry. */
    val secret: String,
    /** otpauth:// URL — used as the source of the QR rendering. */
    val otpauthUrl: String,
    /** PNG base64 (no data: prefix). Composables prepend
     *  `data:image/png;base64,` before feeding into an
     *  Image / AsyncImage primitive. */
    val qrPngBase64: String,
    /** Always "Flagship". */
    val issuer: String,
)

/** v1.2 Phase 3 — POST /api/users/:u/totp/enroll-confirm. */
@Serializable
data class TotpEnrollConfirmRequest(
    val request: Inner,
    val signature: String,
    /** 6-digit TOTP sample. NOT in the canonical bytes (codes are
     *  ephemeral). */
    val code: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val issuedAt: Long,
    )
}

@Serializable
data class TotpEnrollConfirmResponse(
    val ok: Boolean,
    val accountType: String,
    val totpEnrolledAt: Long,
    /** 10 plaintext recovery codes. The ONE time they leave the
     *  Worker. */
    val recoveryCodes: List<String>,
)

/** v1.2 Phase 3 — POST /api/users/:u/totp/disable. */
@Serializable
data class TotpDisableRequest(
    val request: Inner,
    val signature: String,
    val code: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val issuedAt: Long,
    )
}

@Serializable
data class TotpDisableResponse(
    val ok: Boolean,
    val accountType: String,
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
    /** Plan A — present when the typed username matches a `demo_users`
     *  row on the Worker. Drives the new "one real device" rendering
     *  in DemoFixtures + the on-connect-provisioning flow. Absent ⇒
     *  legacy (testAccount-only) behaviour preserved. See
     *  docs/sample-users.md §10.9. */
    val demoServer: DemoServerBlock? = null,
    /** v2 device-addressing — present when the typed username matched
     *  the `<u>.<device-label>` syntax AND a matching active
     *  DeviceCapabilityGrant exists. The mobile client greys out
     *  actions absent from `scopes` and renders the device-label chip
     *  below the username. See
     *  docs/v2-device-addressing-and-real-ticket.md §5.1. */
    val deviceCapability: DeviceCapabilityBlock? = null,
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

/** Plan A — embedded into the /api/users/check response when a typed
 *  username matches a `demo_users` row on the Worker. Mirrors the
 *  shape produced by `demoServerBlockFromRow` in
 *  packages/control-plane/src/demoUsers.ts (and DemoServerBlock on
 *  iOS). See docs/sample-users.md §10.9. */
@Serializable
data class DemoServerBlock(
    /** e.g. `home.demo-alice.flagship.services`. The single device the
     *  new demo-mode renders. */
    val fqdn: String,
    /** Server-lifecycle state surfaced to clients. The Worker collapses
     *  the internal four-state machine into three public statuses:
     *   "none"         — no Hetzner VPS yet; tap connect to provision.
     *   "provisioning" — POST /connect issued; client should poll.
     *   "up"           — VPS booted and registered; safe to open. */
    val status: String,
    /** Operator-set idle-teardown horizon in minutes. UIs can surface
     *  this in a tooltip; the cron lives on the Worker. */
    val ttlIdleMinutes: Int = 30,
) {
    /** Typed convenience over the raw string. Forward-compatible: an
     *  unknown future value parses as `Provisioning` so a client that
     *  hasn't been updated still polls instead of opening an unhealthy
     *  pod. */
    val lifecycle: Lifecycle get() = when (status) {
        "up" -> Lifecycle.Up
        "none" -> Lifecycle.None
        else -> Lifecycle.Provisioning
    }

    enum class Lifecycle { None, Provisioning, Up }
}

/** v2 device-addressing — mirror of the Worker's `deviceCapability`
 *  block in `packages/control-plane/src/usersCheck.ts`. Embedded into
 *  the `/api/users/check` response when the typed username matched
 *  the `<u>.<device-label>` syntax AND a matching active
 *  DeviceCapabilityGrant exists. See
 *  docs/v2-device-addressing-and-real-ticket.md §2 + §5.1.
 *
 *  Note: `scopes` is a wire-format list of strings. Use [scopeSet]
 *  for the typed forward-compat parse (unknown future scope strings
 *  are silently dropped). */
@Serializable
data class DeviceCapabilityBlock(
    /** Human-meaningful label the user typed after the dot
     *  ("reviewer", "ipad", "work-laptop"). RFC-1035-ish (a-z, 0-9,
     *  hyphen; not at start/end; ≤24 chars). Used in the chip below
     *  the username. */
    val label: String,
    /** Device's Ed25519 pubkey, 32 bytes hex. Identifies the device
     *  across re-issuance. */
    val devicePubKey: String,
    /** Authorized scopes for this device. The Worker may return ANY
     *  subset of [DeviceScope]; unknown future strings are silently
     *  dropped by [scopeSet] (forward-compat — an older binary on a
     *  newer Worker doesn't crash). */
    val scopes: List<String>,
    /** Grant identifier (v4 UUID). Audit / debugging only. */
    val grantId: String,
    /** ms since epoch. The client SHOULD treat the block as expired
     *  after this and prompt re-enrollment. */
    val expiresAt: Long,
    /** Owner-IRK Ed25519 signature over the canonical bytes of the
     *  underlying DeviceCapabilityGrant. 64 bytes hex. Daemon-side
     *  verification; surfaced here for parity with the Worker wire. */
    val signature: String,
) {
    /** Typed scope set — drops unknown strings forward-compat-style.
     *  UI callsites use this to gate the install / vibe-code buttons. */
    val scopeSet: Set<DeviceScope> get() = scopes
        .mapNotNull { DeviceScope.fromWire(it) }
        .toSet()

    /** True iff this device's scopes cover the full [DeviceScope] set
     *  — a primary device with no restrictions. The chip + tooltips
     *  suppress when this is true. */
    val isFullyScoped: Boolean get() = DeviceScope.values().all { it in scopeSet }
}

/** v2 device-addressing — scopes mirror the Worker wire strings in
 *  `packages/protocol/src/auth.ts` (`DEVICE_SCOPES`). Order MUST
 *  match the canonical sort order so a future audit-trail render
 *  stays stable. */
enum class DeviceScope(val wire: String) {
    BROWSE("browse"),
    INSTALL_SERVICE("install-service"),
    VIBE_CODE("vibe-code"),
    ADD_DEVICE("add-device"),
    MANAGE_SERVICES("manage-services"),
    REVOKE_OTHERS("revoke-others"),
    DEMO_PROVISION("demo-provision");

    companion object {
        /** Forward-compat: unknown future strings return null so an
         *  older binary on a newer Worker silently drops them rather
         *  than crashing. */
        fun fromWire(wire: String): DeviceScope? =
            values().firstOrNull { it.wire == wire }
    }
}

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
    /** Plan A — mirror of the Worker's `demo_users` D1 table. When a
     *  typed username is present here, `usernameAvailable` embeds the
     *  corresponding `demoServer` block. Independent of
     *  [testAccounts] — a username may carry both (legacy reviewer
     *  compat) or just the new block (live demo only). */
    var demoServers: MutableMap<String, DemoServerBlock> = mutableMapOf(),
    /** v2 device-addressing — mirror of the Worker's
     *  `device_capability_grants` D1 table. Keyed by the full
     *  `<u>.<label>` string the user types. When `usernameAvailable`
     *  is called with a key here AND the user-part has a [demoServers]
     *  row, the response carries the `deviceCapability` block + the
     *  `demoServer` block from the user-part row. See
     *  docs/v2-device-addressing-and-real-ticket.md §5.1. */
    var deviceCapabilities: MutableMap<String, DeviceCapabilityBlock> = mutableMapOf(),
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
        // v2 device-addressing — `<u>.<label>` syntax precedes every
        // other rule. The Worker behaves the same way: when a typed
        // dot-form matches both a demo_users row AND an active
        // device_capability_grants row, the response carries the
        // `deviceCapability` block + the underlying demoServer. Any
        // other dot-form returns 404 — the live client throws an
        // HttpException(404) which the Mock mirrors so callers see
        // the same failure mode.
        if (lower.contains('.')) {
            val cap = deviceCapabilities[lower]
            if (cap != null) {
                val userPart = lower.substringBefore('.')
                val underlyingDemo = demoServers[userPart]
                return UsernameAvailabilityResponse(
                    username = lower,
                    available = false,
                    reason = "device capability",
                    demoServer = underlyingDemo,
                    deviceCapability = cap,
                )
            }
            throw HttpException(404, "unknown demo device label")
        }
        // Plan A — every return branch folds in the demoServer block
        // when present. Independent of testAccount / claim branches;
        // the Worker behaves the same way.
        val demoBlock = demoServers[lower]
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
                demoServer = demoBlock,
            )
        }
        if (lower.length < 2 || lower.length > 32) {
            return UsernameAvailabilityResponse(lower, false, "Must be 2–32 chars.", demoServer = demoBlock)
        }
        if (lower in reservedUsernames) {
            return UsernameAvailabilityResponse(lower, false, "Reserved.", demoServer = demoBlock)
        }
        if (!lower.matches(Regex("^[a-z0-9]+$"))) {
            return UsernameAvailabilityResponse(lower, false, "Letters and digits only.", demoServer = demoBlock)
        }
        val prior = _claimedUsernames[lower]
        if (prior != null && prior != "_self") {
            return UsernameAvailabilityResponse(lower, false, "Already claimed.", demoServer = demoBlock)
        }
        return UsernameAvailabilityResponse(lower, true, null, demoServer = demoBlock)
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

    /** V3 — scripted Replace outcomes for tests. */
    sealed interface AppRenameBehavior {
        data object Ok : AppRenameBehavior
        data object Collision : AppRenameBehavior
        data object StaleSignature : AppRenameBehavior
    }
    var appRenameBehavior: AppRenameBehavior = AppRenameBehavior.Ok
    var lastAppRename: Triple<String, String, AppRenameRequest>? = null
        private set
    /** Mock-side alias cache; getAppLinks reads it, renameApp writes
     *  to it so test fixtures stay self-consistent across calls. */
    var appAliasByUser: MutableMap<String, MutableMap<String, Pair<String, String>>> = mutableMapOf()
    /** #79A — bound external domains, keyed [user][appId]. A Replace
     *  never clears this — deliberately separate from aliases. */
    var customDomainByUser: MutableMap<String, MutableMap<String, String>> = mutableMapOf()
    /** Server-side rate-limit mirror: [user][appId] → last-change ms. */
    var customDomainLastChangedByUser: MutableMap<String, MutableMap<String, Long>> = mutableMapOf()
    /** Min ms between custom-domain changes (server-enforced; the
     *  client mirrors a UX cooldown). 300s, same as .com + iOS. */
    var customDomainMinIntervalMs: Long = 300_000
    /** Demo only: how long after a request the Mock pretends .com
     *  finished the out-of-band CNAME verify (a real server pushes
     *  the outcome; the Mock just flips confirmed after this). */
    var customDomainConfirmDelayMs: Long = 6_000

    override suspend fun renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest,
    ): AppRenameResponse {
        tick()
        lastAppRename = Triple(username, serviceId, body)
        return when (appRenameBehavior) {
            AppRenameBehavior.Collision -> throw IllegalStateException("409 label collision")
            AppRenameBehavior.StaleSignature -> throw IllegalStateException("403 bad signature")
            AppRenameBehavior.Ok -> {
                val newLabel = body.request.newDisplayLabel
                val canonical = "https://$newLabel.${username.lowercase()}.flagship.services"
                appAliasByUser.getOrPut(username.lowercase()) { mutableMapOf() }[serviceId] = newLabel to canonical
                AppRenameResponse(
                    ok = true,
                    displayLabel = newLabel,
                    canonicalUrl = canonical,
                    shortUrl = "https://voi.ci/${newLabel.take(2)}mock1",
                    shortCode = "${newLabel.take(2)}mock1",
                    unchanged = false,
                )
            }
        }
    }

    override suspend fun getAppLinks(
        username: String,
        serviceId: String,
    ): AppLinksResponse {
        tick()
        val alias = appAliasByUser[username.lowercase()]?.get(serviceId)
        // Mirrors @flagship/protocol deriveUrlFragment: serviceId is
        // `<creator>-<slug>` (FIRST hyphen splits — usernames are
        // hyphen-free). Fragment is CONDITIONAL: `<slug>` when the
        // running user authored it, else `<slug>-<creator>`.
        val defaultLabel = run {
            val i = serviceId.indexOf('-')
            if (i > 0 && i < serviceId.length - 1) {
                val creator = serviceId.substring(0, i).lowercase()
                val slug = serviceId.substring(i + 1).lowercase()
                if (creator == username.lowercase()) slug else "$slug-$creator"
            } else {
                serviceId.lowercase()
            }
        }
        val label = alias?.first ?: defaultLabel
        val host = "${username.lowercase()}.flagship.services"
        val canonical = alias?.second ?: "https://$label.$host"
        val u = username.lowercase()
        val lastChanged = customDomainLastChangedByUser[u]?.get(serviceId)
        // Demo: .com "confirms" the CNAME customDomainConfirmDelayMs
        // after the request (a real server pushes the outcome). The
        // server keeps its own lastChanged timer for the rate limit;
        // it is NOT echoed (the client stores its own local stamp).
        val confirmed = lastChanged?.let {
            System.currentTimeMillis() - it >= customDomainConfirmDelayMs
        }
        return AppLinksResponse(
            serviceId = serviceId,
            displayLabel = label,
            canonicalUrl = canonical,
            instances = listOf(
                AppLinkInstance(serverDomain = host, url = canonical),
            ),
            shortUrl = null,
            customDomain = customDomainByUser[u]?.get(serviceId),
            customDomainConfirmed = confirmed,
        )
    }

    override suspend fun setCustomDomain(
        username: String,
        serviceId: String,
        body: SetCustomDomainRequest,
    ): AppLinksResponse {
        tick()
        val u = username.lowercase()
        // Server-side rate limit (the lastChanged column). The client
        // mirrors this with a cooldown, but the server is the backstop.
        val last = customDomainLastChangedByUser[u]?.get(serviceId)
        if (last != null) {
            val elapsed = System.currentTimeMillis() - last
            if (elapsed < customDomainMinIntervalMs) {
                // ceil to whole seconds; U+2014 em dash + trailing
                // period — MUST byte-match .com + iOS Mock.
                val wait = (customDomainMinIntervalMs - elapsed + 999) / 1000
                throw HttpException(429, "Too soon — try again in ${wait}s.")
            }
        }
        // Synchronous confirmation: a real server fetches the CNAME
        // here and only commits if it points at the user's stub. The
        // Mock has no DNS, so it accepts the claim (the demo can't
        // exercise a real failure path).
        customDomainByUser.getOrPut(u) { mutableMapOf() }[serviceId] =
            body.request.fqdn.trim().lowercase()
        customDomainLastChangedByUser.getOrPut(u) { mutableMapOf() }[serviceId] =
            System.currentTimeMillis()
        return getAppLinks(username, serviceId)
    }

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

    // ── v1.2 Phase 4 — account-type + TOTP scripted state ─────────

    /** Per-username `account_type`. "single" (default) or "multi". */
    var accountTypeByUser: MutableMap<String, String> = mutableMapOf()

    /** Per-username `totp_enrolled_at` ms. Null while single-device. */
    var totpEnrolledAtByUser: MutableMap<String, Long> = mutableMapOf()

    /** Per-username staged TOTP secret (base32). Set on enroll-begin
     *  + cleared on disable; mirrors `usernames.totp_secret_encrypted`
     *  on the Worker. */
    var totpSecretByUser: MutableMap<String, String> = mutableMapOf()

    /** Per-username plaintext recovery codes (Mock-only; the Worker
     *  stores argon2id hashes). */
    var recoveryCodesByUser: MutableMap<String, List<String>> = mutableMapOf()

    /** Code the Mock accepts on enroll-confirm / disable. Tests drive
     *  the mismatch branch by changing this. */
    var totpExpectedConfirmCode: String = "123456"

    /** Recovery codes to hand back on enroll-confirm. Default is
     *  deterministic so tests don't need to mock the RNG. */
    var totpRecoveryCodesToIssue: List<String> = listOf(
        "AAAA-BBBB", "CCCC-DDDD", "EEEE-FFFF", "GGGG-HHHH", "IIII-JJJJ",
        "KKKK-LLLL", "MMMM-NNNN", "OOOO-PPPP", "QQQQ-RRRR", "SSSS-TTTT",
    )

    override suspend fun getUsernameRecord(username: String): UsernameLookupResponse {
        tick()
        val u = username.lowercase()
        val irk = _claimedUsernames[u] ?: throw HttpException(404, "not found")
        return UsernameLookupResponse(
            username = u,
            irkPub = irk,
            claimedAt = 0L,
            accountType = accountTypeByUser[u] ?: "single",
            totpEnrolledAt = totpEnrolledAtByUser[u],
        )
    }

    override suspend fun totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest,
    ): TotpEnrollBeginResponse {
        tick()
        val u = username.lowercase()
        val secret = "JBSWY3DPEHPK3PXP" + u.take(4).uppercase().padEnd(4, 'X')
        totpSecretByUser[u] = secret
        val issuer = "Flagship"
        val otpauthUrl =
            "otpauth://totp/$issuer:$u?secret=$secret&issuer=$issuer&algorithm=SHA1&digits=6&period=30"
        // 1×1 PNG transparent placeholder — same shape as the iOS Mock.
        // The real Worker returns a 4×-scaled QR; tests don't pixel-compare.
        val qrPngBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        return TotpEnrollBeginResponse(
            secret = secret,
            otpauthUrl = otpauthUrl,
            qrPngBase64 = qrPngBase64,
            issuer = issuer,
        )
    }

    override suspend fun totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest,
    ): TotpEnrollConfirmResponse {
        tick()
        val u = username.lowercase()
        if (totpSecretByUser[u] == null) {
            throw HttpException(409, "no staged TOTP secret; call enroll-begin first")
        }
        if (body.code != totpExpectedConfirmCode) {
            throw HttpException(401, "invalid TOTP code")
        }
        val now = System.currentTimeMillis()
        accountTypeByUser[u] = "multi"
        totpEnrolledAtByUser[u] = now
        recoveryCodesByUser[u] = totpRecoveryCodesToIssue
        return TotpEnrollConfirmResponse(
            ok = true,
            accountType = "multi",
            totpEnrolledAt = now,
            recoveryCodes = totpRecoveryCodesToIssue,
        )
    }

    override suspend fun totpDisable(
        username: String,
        body: TotpDisableRequest,
    ): TotpDisableResponse {
        tick()
        val u = username.lowercase()
        if (body.code != totpExpectedConfirmCode) {
            throw HttpException(401, "invalid TOTP code")
        }
        accountTypeByUser[u] = "single"
        totpEnrolledAtByUser.remove(u)
        totpSecretByUser.remove(u)
        recoveryCodesByUser.remove(u)
        return TotpDisableResponse(ok = true, accountType = "single")
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

    override suspend fun renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest,
    ): AppRenameResponse {
        val u = java.net.URLEncoder.encode(username, "UTF-8")
        val a = java.net.URLEncoder.encode(serviceId, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$u/apps/$a/rename",
            body = body,
            serializer = AppRenameRequest.serializer(),
            responseSerializer = AppRenameResponse.serializer(),
        )
    }

    override suspend fun getAppLinks(
        username: String,
        serviceId: String,
    ): AppLinksResponse {
        val u = java.net.URLEncoder.encode(username, "UTF-8")
        val a = java.net.URLEncoder.encode(serviceId, "UTF-8")
        return transport.getJson(
            url = "$base/api/users/$u/apps/$a/links",
            responseSerializer = AppLinksResponse.serializer(),
        )
    }

    override suspend fun setCustomDomain(
        username: String,
        serviceId: String,
        body: SetCustomDomainRequest,
    ): AppLinksResponse {
        val u = java.net.URLEncoder.encode(username, "UTF-8")
        val a = java.net.URLEncoder.encode(serviceId, "UTF-8")
        // The .com POST returns { recorded:true } (NOT links) and is
        // the ONLY synchronous step — a non-2xx (429 rate-limit /
        // 4xx) surfaces as HttpException(status, body) where body is
        // { "error": "Too soon — try again in Ns." }. On 200 we mirror
        // iOS Live: re-read links so the bound (still-pending) domain
        // shows immediately; .com confirms out-of-band.
        transport.postJson(
            url = "$base/api/users/$u/apps/$a/custom-domain",
            body = body,
            serializer = SetCustomDomainRequest.serializer(),
        )
        return getAppLinks(username, serviceId)
    }

    override suspend fun getUsernameRecord(username: String): UsernameLookupResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.getJson(
            url = "$base/api/users/$encoded",
            responseSerializer = UsernameLookupResponse.serializer(),
        )
    }

    override suspend fun totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest,
    ): TotpEnrollBeginResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/totp/enroll-begin",
            body = body,
            serializer = TotpEnrollBeginRequest.serializer(),
            responseSerializer = TotpEnrollBeginResponse.serializer(),
        )
    }

    override suspend fun totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest,
    ): TotpEnrollConfirmResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/totp/enroll-confirm",
            body = body,
            serializer = TotpEnrollConfirmRequest.serializer(),
            responseSerializer = TotpEnrollConfirmResponse.serializer(),
        )
    }

    override suspend fun totpDisable(
        username: String,
        body: TotpDisableRequest,
    ): TotpDisableResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/totp/disable",
            body = body,
            serializer = TotpDisableRequest.serializer(),
            responseSerializer = TotpDisableResponse.serializer(),
        )
    }
}

@Serializable
private data class UsernameAvailabilityCheckBody(@SerialName("username") val username: String)
