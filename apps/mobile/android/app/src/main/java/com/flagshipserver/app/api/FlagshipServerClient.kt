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

import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

interface FlagshipServerClient {
    suspend fun claimUsername(req: UsernameClaimRequest)
    /** POST /api/account/self-delete — the last-device account-death bundle.
     *  accountSelfDelete is always sent; serversSelfDelete rides only for the
     *  opt-in content-wipe (atomic §5 bundle, never standalone). A 200 means
     *  the username row is hard-deleted on .com and the name is free; a 403
     *  ("not the last device …") / 404 throws so the caller never wipes. */
    suspend fun selfDeleteAccount(req: AccountSelfDeleteBundleRequest)
    suspend fun issueAuthCode(req: AuthCodeIssueRequest)
    suspend fun registerRck(req: RckRegisterRequest)
    /** Revoke an outstanding auth-code so a never-booted server can't
     *  register with this serial. User-facing this is "Cancel order".
     *  404 (already gone) is treated as success by both Mock + Live. */
    suspend fun revokeAuthCode(req: AuthCodeRevokeRequest)
    /** IRK-signed `ReleaseServerName` envelope POSTed to
     *  /api/server/release. Where revokeAuthCode kills the install
     *  TICKET, this un-pins the name itself (routing record + active
     *  auth-codes + server record). Mirrors webapp `releaseServerName`. */
    suspend fun releaseServerName(req: ReleaseServerNameRequest)
    /** P13 — per-server kill-switch. IRK-signed `ServerRevocation`
     *  envelope POSTed to /api/server-registry/revoke. The server
     *  refuses to boot on its next reboot — irreversible. Reason ∈
     *  {"lost","stolen","decommissioned"}. Mirrors the webapp
     *  `revokeServer` + the iOS `revokeServer` shape. */
    suspend fun revokeServer(req: ServerRevocationRequest)
    suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse
    /** Sign-up handle suggestion. POST /api/username/suggest with a throwaway
     *  `deviceKey` (the per-device regenerate throttle, NOT the account IRK). A
     *  200 carries a name + retryAfterMs cooldown; a 429 carries throttled + the
     *  cooldown remaining. See docs/username-suggestion-queue.md. */
    suspend fun suggestUsername(deviceKey: String): UsernameSuggestion

    /** Canonical provisioning-progress poll — GET /api/order/<serial>/status
     *  on flagshipserver.com (the control plane; NOT session-gated — the
     *  box is still installing and no pod exists yet). Returns the latest
     *  phase + append-only history, or `null` when the box hasn't reported
     *  yet (the Worker answers 404 → "no record yet" → render booting
     *  lead-in / pending). This is the ONE provisioning channel; the SSE
     *  `install-events` flow on ScreensClient is debug-only. Mirrors iOS
     *  `FlagshipServerClient.fetchProvisionStatus`. */
    suspend fun fetchProvisionStatus(serial: String): ProvisionStatusRecord?

    suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse
    suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope

    /** Task #74 — passphrase-gated cloud-recovery fetch. POSTs
     *  `{ fetchToken: <hex>, issuedAt: <ms> }` to
     *  `/api/recovery/by-username/<u>/fetch`; .com releases the wrapped
     *  UMK (+ optional escrowed ACME key + prfSaltHash) only when
     *  SHA-256(fetchToken) matches the stored hash. Throws
     *  [HttpException] 403 on a wrong passphrase, 429 when rate-limited,
     *  404 when no record exists, 409 for a pre-gate (legacy) record. The
     *  fetchToken is the Argon2id-derived value from
     *  RecoveryDerivation.derivePassphraseSecrets. */
    suspend fun fetchWrappedUmkWithToken(
        username: String,
        fetchTokenHex: String,
        issuedAt: Long,
    ): GatedRecoveryEnvelope
    /** Register an FCM device token with .com so the Worker can relay
     *  encrypted push payloads. Returns a handle to later revoke. */
    suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse
    /** Drop a previously-registered push token. Revoke is IRK-signed
     *  (SEC): the caller signs a `flagship/push-token-revoke/v1` envelope
     *  behind the biometric (deriveIRK) and `.com` verifies it against the
     *  token owner's registered IRK before deleting the tether. 404
     *  (already gone) is success so sign-out doesn't surface "already
     *  cleaned up" as an error. */
    suspend fun revokePushToken(req: PushTokenRevokeRequest)

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

    /** M4 — read the pending re-pair row (GET /api/users/:u/re-pair).
     *  Powers the Trusted-devices "Replace pending" banner so a replace
     *  started on ANY device surfaces with a grace countdown + a
     *  "Finalize now" entry into the finalize screen. 404/405 →
     *  `unavailable` (older Worker) so the caller just hides the banner.
     *  Mirrors the webapp's `fetchPendingRePair` + the iOS client. */
    suspend fun fetchPendingRePair(username: String): PendingRePairSnapshot

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

    /** Login/join preflight — GET /api/account/resolve/<username>.
     *  The sign-in space is access-control evaluation, not a fetch:
     *  this reads what credentials + factors exist for a named account
     *  and returns them as FIELDS so the login state machine branches
     *  on data, not HTTP errors. Returns 200 ALWAYS — a missing account
     *  is `kind="unknown"`, never a 404. Mirrors the Worker wire in
     *  packages/control-plane/src/accountResolve.ts.
     *  See docs/login-and-account-redesign.md. */
    suspend fun resolveAccount(username: String): AccountResolution

    /** Phase 3b — vouched cross-device admit. The incoming device
     *  replays the admin's IRK-signed DeviceAdmit + its push-token
     *  registration to .com:
     *    POST /api/users/<account>/devices/admit
     *  The Worker verifies the admit under the account's CURRENT IRK,
     *  then admits this device QUARANTINED (14-day non-admin peer
     *  window) and returns `quarantineUntil`. The register `signature`
     *  is carried for storage but NOT verified (the admit is the IRK's
     *  consent). Mirrors handleVouchedDeviceAdmit in
     *  packages/control-plane/src/push.ts. */
    suspend fun admitDevice(account: String, req: DeviceAdmitRequest): DeviceAdmitResponse

    /** Watch delegate keys — opt-in "quick approve a boot from the watch".
     *  The phone mints an IRK-signed WatchDelegateKey (scoped boot-approval,
     *  7-day TTL); the boot worker then accepts the delegate key's signature
     *  on a boot approval. Mirrors packages/control-plane/src/watchDelegates.ts.
     *    POST /api/users/:u/watch-delegates */
    suspend fun mintWatchDelegate(username: String, body: WatchDelegateMintRequest): WatchDelegateMintResponse
    /** GET /api/users/:u/watch-delegates */
    suspend fun listWatchDelegates(username: String): WatchDelegatesListResponse
    /** POST /api/users/:u/watch-delegates/revoke */
    suspend fun revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest)
}

/** Phase 3b — POST /api/users/:u/devices/admit body. Mirrors the Worker
 *  `AdmitBody` shape (push.ts): the IRK-signed admit + its signature, the
 *  same push-token register fields handlePushRegister takes, and the
 *  register signature (carried, not verified). */
@Serializable
data class DeviceAdmitRequest(
    val admit: AdmitEnvelope,
    /** Ed25519 over the admit, signed by the account's CURRENT IRK,
     *  lowercased hex (64 bytes). */
    val admitSig: String,
    val request: PushTokenRegisterRequest.Inner,
    /** PushTokenRegister signature, carried for storage. Hex. */
    val signature: String,
) {
    @Serializable
    data class AdmitEnvelope(
        val username: String,
        /** The incoming device's freshly-minted pubkey, lowercased hex
         *  (32 bytes). */
        val newDevicePubHex: String,
        val issuedAt: Long,
    )
}

@Serializable
data class DeviceAdmitResponse(
    val ok: Boolean,
    val tokenId: String,
    /** Wall-clock ms before which the freshly-admitted device cannot
     *  revoke others / hold admin reach. ~14 days out. */
    val quarantineUntil: Long? = null,
)

// ---- Watch delegate keys (wire types) ---------------------------------

/** POST /api/users/:u/watch-delegates body. `grant` field names match the
 *  Worker's MintBody.grant; `signature` is the IRK Ed25519 over the grant's
 *  canonical bytes. */
@Serializable
data class WatchDelegateMintRequest(
    val grant: Grant,
    val signature: String,
) {
    @Serializable
    data class Grant(
        val grantId: String,
        val username: String,
        /** lowercased hex, 32 bytes. */
        val delegatePubKey: String,
        val scopes: List<String>,
        val issuedAt: Long,
        val expiresAt: Long,
    )
}

@Serializable
data class WatchDelegateMintResponse(
    val ok: Boolean,
    val grantId: String,
    val expiresAt: Long,
    val replacedGrantId: String? = null,
)

@Serializable
data class WatchDelegateInfo(
    val grantId: String,
    val delegatePubKey: String,
    val scopes: List<String>,
    val issuedAt: Long,
    val expiresAt: Long,
)

@Serializable
data class WatchDelegatesListResponse(
    val username: String,
    val delegates: List<WatchDelegateInfo>,
)

@Serializable
data class WatchDelegateRevokeRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val grantId: String,
        val username: String,
        val issuedAt: Long,
    )
}

/** Login/join preflight result — Kotlin mirror of the Worker's
 *  `AccountResolution` (packages/control-plane/src/accountResolve.ts).
 *  Returned by [FlagshipServerClient.resolveAccount]. Existence and
 *  every factor are FIELDS, not status codes — a missing account is
 *  `kind="unknown"`, never an HTTP error. Wire shape MUST stay
 *  byte-identical to the Worker + iOS mirrors (iOS-Mock-matches-Worker
 *  invariant). */
@Serializable
data class AccountResolution(
    /** Normalized handle the lookup ran against (lowercased). */
    val username: String,
    val exists: Boolean,
    /** "demo" | "single" | "multi" | "unknown". Use [accountKind] for
     *  the typed, forward-compat parse. */
    val kind: String,
    val recovery: RecoveryState,
    val totpEnrolled: Boolean,
    val trustedDeviceCount: Int,
    /** Present only for demo accounts — the single sandbox device. */
    val demoServer: DemoServerBlock? = null,
    /** Server-derived recovery-speed hint:
     *  "instant" | "3d" | "24h-totp" | "none". Use [grace] for the
     *  typed parse. */
    val graceModel: String,
    /** Recovery Phase A vs B — the account's CURRENTLY registered IRK
     *  pubkey (hex), when the Worker surfaces it. The single-device
     *  takeover compares this to the IRK derived from the recovered UMK:
     *  match (or null, from a pre-Phase-B Worker) ⇒ Phase A instant pair
     *  (the recovered key IS the registered identity — exactly what lets
     *  a wiped-but-valid device come back after a Tier-2 sign out);
     *  mismatch ⇒ Phase B re-pair against the live key behind grace,
     *  carrying oldIrkPub = this value. Mirror of iOS's
     *  RecoveryViewModel.registeredIrkPubHex. */
    val registeredIrkPubHex: String? = null,
) {
    @Serializable
    data class RecoveryState(
        val present: Boolean,
        val hasFetchGate: Boolean,
        val credentialId: String? = null,
    )

    /** Forward-compat typed view over [kind]; an unknown future string
     *  parses as [AccountKind.Unknown] so an old binary on a new Worker
     *  renders the clean "no account" state rather than crashing. */
    val accountKind: AccountKind get() = when (kind) {
        "demo" -> AccountKind.Demo
        "single" -> AccountKind.Single
        "multi" -> AccountKind.Multi
        else -> AccountKind.Unknown
    }

    /** Forward-compat typed view over [graceModel]. */
    val grace: GraceModel get() = when (graceModel) {
        "instant" -> GraceModel.Instant
        "3d" -> GraceModel.ThreeDay
        "24h-totp" -> GraceModel.TwentyFourHourTotp
        else -> GraceModel.None
    }

    enum class AccountKind { Demo, Single, Multi, Unknown }
    enum class GraceModel { Instant, ThreeDay, TwentyFourHourTotp, None }
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
    /** v1.2 — second factor for a MULTI-device takeover. NOT in the
     *  signed canonical bytes (codes are ephemeral); rides beside the
     *  envelope. The Worker REQUIRES it when `account_type === 'multi'`
     *  (rePair.ts:311-340) and 401s without it. Absent on single-device
     *  takeovers. Mirror of the Worker `body.totpProof` shape +
     *  RePairInitiate.totpProof on iOS. */
    val totpProof: TotpProof? = null,
) {
    @Serializable
    data class Inner(
        val username: String,
        val newIrkPub: String,   // hex
        val oldIrkPub: String,   // hex
        val issuedAt: Long,      // ms
    )

    /** A 6-digit TOTP sample OR a single-use recovery code, tagged with
     *  which it is so the Worker routes verification. `method` is
     *  "totp" | "recovery" (rePair.ts:331). */
    @Serializable
    data class TotpProof(
        val code: String,
        val method: String,
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

/** M4 — the GET /api/users/:u/re-pair result. `pending == null` means
 *  nothing is in flight; `unavailable == true` means an older Worker
 *  (404/405) doesn't wire the endpoint — the caller hides the banner
 *  gracefully, exactly like the webapp's `{ pending: null, unavailable }`
 *  and the iOS `PendingRePairSnapshot`. `PendingRePair` itself lives in
 *  ScreensModels.kt (byte-identical to the Worker's handleGetRePair row). */
data class PendingRePairSnapshot(
    val pending: PendingRePair?,
    val unavailable: Boolean = false,
)

/** On-wire body for GET /re-pair — the Worker wraps the row (or null)
 *  under `pending`. Private so the public surface is the flattened
 *  PendingRePairSnapshot. */
@Serializable
private data class PendingRePairWireBody(val pending: PendingRePair? = null)

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
    /** Slice D — the account's ADMIN MASTER ROOT pubkey (hex), a top-level
     *  sibling `.com` stores at `usernames.admin_root_pub_hex` (usernameClaim.ts).
     *  NOT signature-covered (the claim sig is over username|irkPub|issuedAt);
     *  the admin root's authority is anchored on the box via the signed AuthCode.
     *  Omitted (null) on a legacy claim ⇒ `.com` stores no admin root. */
    val adminRootPub: String? = null,
) {
    @Serializable
    data class Inner(
        val username: String,
        val irkPub: String,          // hex
        val issuedAt: Long,
    )
}

/** Body for POST /api/account/self-delete. `accountSelfDelete` is always
 *  present; `serversSelfDelete` is included ONLY for the opt-in content-wipe
 *  (the atomic §5 bundle — `.com` rejects the whole request if a serversSelfDelete
 *  arrives without a valid last-device accountSelfDelete). Both orders carry the
 *  same lowercased username + issuedAt; signatures are IRK over the
 *  account-self-delete / servers-self-delete canonical bytes. */
@Serializable
data class AccountSelfDeleteBundleRequest(
    val accountSelfDelete: Order,
    val serversSelfDelete: Order? = null,
) {
    @Serializable
    data class Order(
        val request: Inner,
        val signature: String,       // hex, IRK over canonical bytes
    )
    @Serializable
    data class Inner(
        val username: String,
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
    /** Slice D (D-1) — the account's ADMIN MASTER ROOT pubkey (hex). Rides
     *  INSIDE the AuthCode so it is signature-covered by `authCodeUserSignature`
     *  and `.com`'s registration gate (a compromised network can't swap the
     *  admin anchor). The box pins it at first boot into
     *  `ServerConfig.adminRootPub`. Backward-compatible: null ⇒ the canonical
     *  bytes are byte-identical to a pre-D AuthCode (no `ar=` segment). */
    val adminRootPubKey: String? = null,
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

/** POST /api/server/release — IRK-signed release of a reserved server
 *  name. Fired when the user cancels a pending/abandoned server. Mirrors
 *  the canonical-bytes tag `flagship/release-server-name/v1`
 *  (`tag|username|serverDomain|issuedAt`) + the @flagship/protocol
 *  `ReleaseServerName` shape. Authorization is the IRK signature itself
 *  — only the account owner can produce it. */
@Serializable
data class ReleaseServerNameRequest(
    val request: Inner,
    val signature: String,           // hex, IRK
) {
    @Serializable
    data class Inner(
        val username: String,
        val serverDomain: String,
        val issuedAt: Long,
    )
}

/** P13 — POST /api/server-registry/revoke. IRK-signed envelope that
 *  declares a server DEAD (kill switch). The box will refuse to boot
 *  on its next reboot — irreversible. Mirrors the canonical-bytes tag
 *  `flagship/revoke/v1` (`tag|userId|revokedServerId|reason|issuedAt`)
 *  + the @flagship/protocol `ServerRevocation` shape. */
@Serializable
data class ServerRevocationRequest(
    val request: Inner,
    val signature: String,           // hex, IRK
) {
    @Serializable
    data class Inner(
        val userId: String,
        val revokedServerId: String,
        /** One of {"lost", "stolen", "decommissioned"}. */
        val reason: String,
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

/** One sign-up handle suggestion. On a 200 `name` is set + `throttled` is false;
 *  on a 429 `name` is null + `throttled` is true. `retryAfterMs` is the cooldown
 *  until the next regenerate is allowed either way. */
@Serializable
data class UsernameSuggestion(
    val name: String? = null,
    val retryAfterMs: Int = 0,
    val throttled: Boolean = false,
)

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
    /** e.g. `home.demoalice.flagship.services`. The single device the
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
    /** Fine-grained provisioning observability — the latest named PHASE
     *  checkpoint the box pushed (one of the @flagship/protocol
     *  PROVISION_PHASES), or null when no checkpoint has arrived yet.
     *  The coarse [status] is the three-state lifecycle; [phase] is the
     *  step WITHIN provisioning so the install-progress UI can render a
     *  real list instead of a spinner. Mirror of
     *  packages/control-plane/src/demoUsers.ts `DemoServerBlock.phase`. */
    val phase: String? = null,
    /** Wall-clock ms the latest phase landed; null when [phase] is null. */
    val phaseAt: Long? = null,
    /** Failure detail, present only when `phase == "failed"`. */
    val lastError: String? = null,
    /** Device-identifying metadata (migration 0036) so the user can
     *  confirm the box they're watching is theirs. Each is null when the
     *  provider hasn't returned it / pre-0036 row. Mirror of the Worker's
     *  `DemoServerBlock` ip/region/serverType/image fields. */
    val ip: String? = null,
    val region: String? = null,
    val serverType: String? = null,
    val image: String? = null,
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

/** `POST /api/recovery` — IRK-SIGNED cloud-recovery upload. Serializes to
 *  `{ request: { username, credentialId, wrappedUmk, issuedAt,
 *  wrappedAcmeAccountKey? }, signature }`, matching
 *  control-plane/webauthnRecovery.handleUploadWebauthnRecovery byte-for-byte.
 *  The Worker base64-decodes `wrappedUmk`, hashes it to wrappedUmkHashHex,
 *  and verifies `signature` (hex, ed25519 by the account IRK) over the
 *  canonical UploadRecoveryRecord. `wrappedUmk` is a SINGLE self-contained
 *  blob (nonce ‖ ct ‖ tag); there is NO separate nonce field. */
@Serializable
data class RecoveryEnvelopeRequest(
    val request: Inner,
    val signature: String,           // hex, IRK
) {
    @Serializable
    data class Inner(
        val username: String,
        val credentialId: String,
        val wrappedUmk: String,
        val issuedAt: Long,
        // #28 — the ACME account key escrowed alongside the UMK. Single
        // self-contained base64 blob (nonce‖ct‖tag) from
        // AcmeAccountKey.wrapForEscrow. The JSON key MUST be
        // `wrappedAcmeAccountKey` (read verbatim by the Worker). Optional +
        // ciphertext only — never in the signed canonical, so tampering
        // breaks recovery of the account key but can never forge it.
        val wrappedAcmeAccountKey: String? = null,
        // Slice D (D-3) — the ADMIN MASTER ROOT escrowed alongside the UMK.
        // Single self-contained base64 blob (nonce‖ct‖tag) from
        // AdminRootEscrow.wrapForEscrow, read verbatim by the Worker. Optional +
        // ciphertext-only (never in the signed canonical), so tampering can
        // break admin recovery but never forge the root.
        val wrappedAdminRoot: String? = null,
        // Task #74 — passphrase-gate hashes. Both are lowercase SHA-256 hex
        // of the Argon2id-derived fetchToken / prfSalt (see
        // RecoveryDerivation). Optional on the wire (NOT in the signed
        // canonical — the protocol only hashes wrappedUmk), but the modern
        // enroll flow always sends both. fetchTokenHash gates the
        // /fetch POST; prfSaltHash lets a recovering device confirm it
        // re-derived the same salt before trusting the PRF output.
        val fetchTokenHash: String? = null,
        val prfSaltHash: String? = null,
    )
}

@Serializable
data class RecoveryEnvelopeResponse(val ok: Boolean)

/** Response shape for the recovery fetch path. The Worker returns
 *  `wrappedUmk` (the single self-contained blob), `credentialId`, and the
 *  optional escrowed `wrappedAcmeAccountKey`. */
@Serializable
data class RecoveryEnvelope(
    val credentialId: String,
    val wrappedUmk: String,
    // #28 — present when the account minted + escrowed an ACME account key.
    // Decoded by the recovery-restore path (LoginViewModel) and imported via
    // Keystore.importAcmeAccountKeyScalar.
    val wrappedAcmeAccountKey: String? = null,
    // Slice D (D-3) — present when the account escrowed its admin master root.
    val wrappedAdminRoot: String? = null,
)

/** `POST /api/recovery/by-username/<u>/fetch` — the body the passphrase-
 *  gated fetch sends. `fetchToken` is the Argon2id-derived token (hex);
 *  the Worker rejects a `issuedAt` more than ~5 min off as stale. */
@Serializable
data class GatedRecoveryFetchRequest(
    val fetchToken: String, // hex
    val issuedAt: Long,
)

/** Success body of the gated fetch. Mirrors handleFetchWrappedUmkWithToken
 *  in control-plane/webauthnRecovery.ts: the wrapped UMK blob, the
 *  credentialId pointer, the optional escrowed ACME key, and the stored
 *  prfSaltHash (so the client can confirm its locally-derived prfSalt
 *  matches before unwrapping — defense against a malicious .com swapping
 *  the salt). `username`/`updatedAt` are returned but unused by the client. */
@Serializable
data class GatedRecoveryEnvelope(
    val username: String? = null,
    val credentialId: String,
    val wrappedUmk: String,
    val wrappedAcmeAccountKey: String? = null,
    // Slice D (D-3) — the escrowed admin master root, unwrapped on restore and
    // re-established via Keystore.importAdminRoot.
    val wrappedAdminRoot: String? = null,
    val prfSaltHash: String? = null,
    val updatedAt: Long? = null,
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

/** `{ request, signature }` body for `DELETE /api/push/<token-id>`. Revoke
 *  is IRK-signed (SEC): `.com` resolves the token owner from the stored row
 *  and verifies this signature over `flagship/push-token-revoke/v1` before
 *  deleting the tether, so a tokenId-knower can't silently kill a device's
 *  push registration. `tokenId` here MUST equal the URL segment. Mirrors
 *  the Worker's `RevokeBody` in packages/control-plane/src/push.ts. */
@Serializable
data class PushTokenRevokeRequest(
    val request: Inner,
    val signature: String,           // hex, IRK
) {
    @Serializable
    data class Inner(
        val tokenId: String,
        val issuedAt: Long,
    )
}

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
    /** Canonical provisioning channel — mirror of the Worker's
     *  `provision_status` table, keyed by auth-code SERIAL. When a serial
     *  is present here, [fetchProvisionStatus] returns the record; absent ⇒
     *  null (the Worker's 404 "no record yet"). Tests / previews script a
     *  progression by mutating this map. */
    var provisionStatuses: MutableMap<String, ProvisionStatusRecord> = mutableMapOf(),
) : FlagshipServerClient {
    private val recoveryStore = mutableMapOf<String, RecoveryEnvelope>()

    /** Mirror of the Worker's webauthn_recovery row, keyed by lowercased
     *  username — the unit the gated /fetch endpoint reads. Holds the
     *  passphrase-gate hashes so [fetchWrappedUmkWithToken] can enforce the
     *  same SHA-256(fetchToken) check the Worker does. */
    private data class MockRecoveryRecord(
        val credentialId: String,
        val wrappedUmk: String,
        val wrappedAcmeAccountKey: String?,
        val fetchTokenHashHex: String?,
        val prfSaltHashHex: String?,
        val updatedAt: Long,
    )
    private val recoveryByUsername = mutableMapOf<String, MockRecoveryRecord>()

    private val _claimedUsernames = mutableMapOf<String, String>()       // username → irkPub
    private val _issuedAuthCodes = mutableMapOf<String, AuthCodeWire>()  // serial → wire
    private val _revokedAuthCodes = mutableSetOf<String>()
    private val _releasedServerNames = mutableListOf<ReleaseServerNameRequest>()
    private val _revokedServers = mutableListOf<ServerRevocationRequest>()
    private val _registeredRcks = mutableMapOf<String, String>()         // subdomain → rckPubKey
    private val _registeredPushTokens = mutableMapOf<String, PushTokenRegisterRequest.Inner>()
    private var nextPushTokenId = 1
    /** Settable clock so tests can drive TTL/expiry math deterministically. */
    var nowMs: () -> Long = { System.currentTimeMillis() }
    /** Active watch delegates per user (un-revoked only; the list endpoint
     *  shows active-only, one-active-per-user — a mint replaces the prior). */
    val watchDelegatesByUser = mutableMapOf<String, MutableList<WatchDelegateInfo>>()

    val claimedUsernames: Map<String, String> get() = _claimedUsernames
    val issuedAuthCodes: Map<String, AuthCodeWire> get() = _issuedAuthCodes
    val revokedAuthCodes: Set<String> get() = _revokedAuthCodes
    val releasedServerNames: List<ReleaseServerNameRequest> get() = _releasedServerNames
    val revokedServers: List<ServerRevocationRequest> get() = _revokedServers
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

    override suspend fun selfDeleteAccount(req: AccountSelfDeleteBundleRequest) {
        tick()
        // Mock: hard-delete frees the name (mirrors .com dropping the row).
        _claimedUsernames.remove(req.accountSelfDelete.request.username.lowercase())
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

    override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
        tick()
        _releasedServerNames += req
    }

    override suspend fun revokeServer(req: ServerRevocationRequest) {
        tick()
        _revokedServers += req
    }

    /** Mock suggestion — a fresh random `<adjective>-<noun>` each call, fixed
     *  2 s cooldown, never throttled (offline/dev convenience; no DNS). */
    override suspend fun suggestUsername(deviceKey: String): UsernameSuggestion {
        tick()
        val adj = listOf("happy", "brave", "calm", "clever", "lucky", "swift", "sunny", "witty", "golden", "jolly").random()
        val noun = listOf("otter", "panda", "fox", "heron", "robin", "finch", "badger", "beaver", "gecko", "comet").random()
        return UsernameSuggestion(name = "$adj-$noun", retryAfterMs = 2000, throttled = false)
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
        // Mirrors the Worker's USERNAME_RE in labels.ts: 3–30 lowercase chars,
        // interior single dashes OK, no leading/trailing dash, and no `--` (the
        // `<slug>--<creator>` delimiter — docs/service-addressing-double-dash.md).
        if (lower.length < 3 || lower.length > 30) {
            return UsernameAvailabilityResponse(lower, false, "Must be 3–30 chars.", demoServer = demoBlock)
        }
        if (lower in reservedUsernames) {
            return UsernameAvailabilityResponse(lower, false, "Reserved.", demoServer = demoBlock)
        }
        if (!lower.matches(Regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$")) || lower.contains("--")) {
            return UsernameAvailabilityResponse(lower, false, "Letters, digits, and interior dashes only (no double dash).", demoServer = demoBlock)
        }
        val prior = _claimedUsernames[lower]
        if (prior != null && prior != "_self") {
            return UsernameAvailabilityResponse(lower, false, "Already claimed.", demoServer = demoBlock)
        }
        return UsernameAvailabilityResponse(lower, true, null, demoServer = demoBlock)
    }

    override suspend fun fetchProvisionStatus(serial: String): ProvisionStatusRecord? {
        tick()
        // Absent serial mirrors the Worker's 404 "no record yet" → null.
        return provisionStatuses[serial]
    }

    override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse {
        tick()
        val r = req.request
        // Preserve a previously-escrowed account key when a re-upload
        // omits it, mirroring the control-plane upsert (#28).
        val priorAcme = recoveryStore[r.credentialId]?.wrappedAcmeAccountKey
        val resolvedAcme = r.wrappedAcmeAccountKey ?: priorAcme
        recoveryStore[r.credentialId] = RecoveryEnvelope(
            credentialId = r.credentialId,
            wrappedUmk = r.wrappedUmk,
            wrappedAcmeAccountKey = resolvedAcme,
        )
        // Also mirror the by-username row the gated /fetch endpoint reads,
        // carrying the passphrase-gate hashes (Task #74). Preserve a prior
        // ACME escrow / hashes the same way the Worker's upsert does.
        val key = r.username.lowercase()
        val prior = recoveryByUsername[key]
        recoveryByUsername[key] = MockRecoveryRecord(
            credentialId = r.credentialId,
            wrappedUmk = r.wrappedUmk,
            wrappedAcmeAccountKey = resolvedAcme ?: prior?.wrappedAcmeAccountKey,
            fetchTokenHashHex = r.fetchTokenHash?.lowercase() ?: prior?.fetchTokenHashHex,
            prfSaltHashHex = r.prfSaltHash?.lowercase() ?: prior?.prfSaltHashHex,
            updatedAt = nowMs(),
        )
        return RecoveryEnvelopeResponse(ok = true)
    }

    override suspend fun fetchRecoveryEnvelope(credentialId: String): RecoveryEnvelope {
        tick()
        return recoveryStore[credentialId] ?: throw HttpException(404, "no envelope")
    }

    override suspend fun fetchWrappedUmkWithToken(
        username: String,
        fetchTokenHex: String,
        issuedAt: Long,
    ): GatedRecoveryEnvelope {
        tick()
        val rec = recoveryByUsername[username.lowercase()]
            ?: throw HttpException(404, "no recovery record")
        // Legacy row with no gate → the Worker refuses with 409.
        val storedHash = rec.fetchTokenHashHex
            ?: throw HttpException(409, "record predates passphrase gate — re-enrol cloud recovery")
        // Enforce the SHA-256(fetchToken) gate exactly like the Worker.
        val presented = com.flagshipserver.app.keystore.RecoveryDerivation.sha256Hex(
            HexUtil.decode(fetchTokenHex.lowercase()) ?: throw HttpException(400, "fetchToken must be hex"),
        )
        if (presented != storedHash) throw HttpException(403, "invalid fetch token")
        return GatedRecoveryEnvelope(
            username = username.lowercase(),
            credentialId = rec.credentialId,
            wrappedUmk = rec.wrappedUmk,
            wrappedAcmeAccountKey = rec.wrappedAcmeAccountKey,
            prfSaltHash = rec.prfSaltHashHex,
            updatedAt = rec.updatedAt,
        )
    }

    override suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse {
        tick()
        val id = "tok_%06d".format(nextPushTokenId++)
        _registeredPushTokens[id] = req.request
        return PushTokenRegisterResponse(ok = true, tokenId = id)
    }

    override suspend fun revokePushToken(req: PushTokenRevokeRequest) {
        tick()
        _registeredPushTokens.remove(req.request.tokenId)
    }

    /** Scripted devices listing per username for tests + dev mode. */
    var devicesByUser: Map<String, List<TrustedDevice>> = emptyMap()

    /** Scripted audit log per username — tests configure to drive
     *  Activity feed renders without hitting the Worker. The default
     *  seed gives the demo username "harry" a handful of plausible
     *  recent events so the P5 audit-log screen + the Activity feed
     *  both have something to render in dev/preview without any setup.
     *  Tests that need a clean state simply reassign the whole map. */
    var auditEventsByUser: Map<String, List<AuditEvent>> = run {
        val now = System.currentTimeMillis()
        val hour = 3_600_000L
        mapOf(
            "harry" to listOf(
                AuditEvent(
                    seq = 4, eventKind = "device-added",
                    detail = "Added iPad (kitchen)",
                    devicePrefix = "f9e8d7c6",
                    postedAt = now - 2 * hour,
                ),
                AuditEvent(
                    seq = 3, eventKind = "device-replaced",
                    detail = "Rotated identity key from a new device",
                    devicePrefix = "a1b2c3d4",
                    postedAt = now - 26 * hour,
                ),
                AuditEvent(
                    seq = 2, eventKind = "recovery-set-up",
                    detail = "Enrolled cloud recovery passkey",
                    devicePrefix = "a1b2c3d4",
                    postedAt = now - 5 * 24 * hour,
                ),
                AuditEvent(
                    seq = 1, eventKind = "device-disconnected",
                    detail = "Disconnected iPhone (old)",
                    devicePrefix = "deadbeef",
                    postedAt = now - 30 * 24 * hour,
                ),
            ),
        )
    }

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
        // Mirror the Worker's proof gate (byte-matching error strings):
        // multi ALWAYS requires a structurally-valid totpProof; #52 — a
        // SINGLE account with a second factor enrolled (TOTP and/or
        // unspent recovery codes) requires one too. Single with NEITHER
        // stays grace-only.
        val u = username.lowercase()
        val isMulti = accountTypeByUser[u] == "multi"
        val singleCredentialEnrolled = !isMulti &&
            (totpEnrolledAtByUser[u] != null || !recoveryCodesByUser[u].isNullOrEmpty())
        if (isMulti || singleCredentialEnrolled) {
            val proof = body.totpProof
            val structurallyValid = proof != null &&
                proof.code.isNotEmpty() &&
                (proof.method == "totp" || proof.method == "recovery")
            if (!structurallyValid) {
                throw HttpException(
                    401,
                    if (isMulti) "totpProof required for multi-device recovery"
                    else "totpProof required for single-device recovery (a second factor is enrolled)",
                )
            }
        }
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

    /** M4 — scripted pending re-pair snapshot per username. Tests set
     *  this to drive the Trusted-devices banner. Unconfigured users
     *  default to `{ pending = null }`. Flip `pendingRePairUnavailable`
     *  to model an older Worker (404). */
    var pendingRePairByUser: Map<String, PendingRePair> = emptyMap()
    var pendingRePairUnavailable: Boolean = false

    override suspend fun fetchPendingRePair(username: String): PendingRePairSnapshot {
        tick()
        if (pendingRePairUnavailable) {
            return PendingRePairSnapshot(pending = null, unavailable = true)
        }
        return PendingRePairSnapshot(pending = pendingRePairByUser[username.lowercase()])
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
                val canonical = "https://${Endpoints.serverFqdn(newLabel, username.lowercase())}"
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
        // `<creator>--<slug>` (the `--` delimiter splits — both halves may
        // carry single dashes; docs/service-addressing-double-dash.md).
        // Fragment is CONDITIONAL: `<slug>` when the running user authored
        // it, else `<slug>--<creator>`.
        val defaultLabel = run {
            val i = serviceId.indexOf("--")
            if (i > 0 && i < serviceId.length - 2) {
                val creator = serviceId.substring(0, i).lowercase()
                val slug = serviceId.substring(i + 2).lowercase()
                if (creator == username.lowercase()) slug else "$slug--$creator"
            } else {
                serviceId.lowercase()
            }
        }
        val label = alias?.first ?: defaultLabel
        val host = Endpoints.userZoneHost(username.lowercase())
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

    override suspend fun resolveAccount(username: String): AccountResolution {
        tick()
        val u = username.lowercase()
        // Demo first (mirror of the Worker's demo_users-before-users
        // ordering). A seeded demo username = entry; crypto is a no-op,
        // so we report it with `kind="demo"` + its demoServer and the
        // client skips every credential gate. The `demoServers` map is
        // the Mock's mirror of the Worker's `demo_users` table.
        demoServers[u]?.let { block ->
            return AccountResolution(
                username = u,
                exists = true,
                kind = "demo",
                recovery = AccountResolution.RecoveryState(present = false, hasFetchGate = false),
                totpEnrolled = false,
                trustedDeviceCount = 0,
                demoServer = block,
                graceModel = "instant",
            )
        }
        // A claimed real username projects its account-type / TOTP /
        // recovery / device-count scripted state (used by later phases).
        // Everything else is a clean `unknown` STATE with zeroed factors
        // — never a 404. Non-existent names return the same shape as a
        // miss so timing/shape don't distinguish them.
        val irk = _claimedUsernames[u]
        if (irk == null) {
            return AccountResolution(
                username = u,
                exists = false,
                kind = "unknown",
                recovery = AccountResolution.RecoveryState(present = false, hasFetchGate = false),
                totpEnrolled = false,
                trustedDeviceCount = 0,
                graceModel = "none",
            )
        }
        val kind = if ((accountTypeByUser[u] ?: "single") == "multi") "multi" else "single"
        // A real enrolled record (recoveryByUsername, written by
        // registerRecoveryEnvelope) is authoritative for presence + the
        // passphrase gate; the scripted cloudRecoveryByUser map is an
        // explicit override for tests that don't run a full enroll.
        val record = recoveryByUsername[u]
        val hasRecovery = (cloudRecoveryByUser[u] ?: false) || record != null
        val hasFetchGate = record?.fetchTokenHashHex != null
        val credentialId = record?.credentialId
        val devices = devicesByUser[u]?.size ?: 0
        return AccountResolution(
            username = u,
            exists = true,
            kind = kind,
            recovery = AccountResolution.RecoveryState(
                present = hasRecovery,
                hasFetchGate = hasFetchGate,
                credentialId = credentialId,
            ),
            totpEnrolled = totpEnrolledAtByUser[u] != null,
            trustedDeviceCount = devices,
            graceModel = if (kind == "multi") "24h-totp" else "3d",
            // Recovery Phase A vs B — surface the account's currently
            // registered IRK so the single-device takeover can tell a
            // wiped-but-valid device (same key ⇒ instant pair) from a
            // rotated one (re-pair behind grace).
            registeredIrkPubHex = irk,
        )
    }

    /** Phase 3b — last vouched-admit the Mock received, for test
     *  assertions (the admin's admit + the incoming device's register). */
    var lastDeviceAdmit: Pair<String, DeviceAdmitRequest>? = null
        private set

    /** Phase 3b — wall-clock the Mock stamps as `quarantineUntil` on a
     *  successful admit. 14 days, matching the Worker QUARANTINE_MS. */
    var admitQuarantineMs: Long = 14L * 86_400_000

    /** When true, [admitDevice] simulates the Worker rejecting a bad /
     *  stale admit proof (401). Tests flip this to drive the failure
     *  branch. */
    var admitShouldRejectProof: Boolean = false

    override suspend fun admitDevice(account: String, req: DeviceAdmitRequest): DeviceAdmitResponse {
        tick()
        lastDeviceAdmit = account to req
        if (admitShouldRejectProof) throw HttpException(401, "invalid admit proof")
        val id = "tok_%06d".format(nextPushTokenId++)
        _registeredPushTokens[id] = req.request
        return DeviceAdmitResponse(
            ok = true,
            tokenId = id,
            quarantineUntil = System.currentTimeMillis() + admitQuarantineMs,
        )
    }

    override suspend fun mintWatchDelegate(username: String, body: WatchDelegateMintRequest): WatchDelegateMintResponse {
        tick()
        val u = username.lowercase()
        // The Worker rejects any scope set other than ["boot-approval"]
        // (core.WatchDelegateKey.BOOT_APPROVAL_SCOPE; inlined so the api
        // package needn't depend on core).
        if (body.grant.scopes != listOf("boot-approval")) {
            throw HttpException(400, "invalid scopes")
        }
        if (body.grant.expiresAt <= nowMs()) throw HttpException(400, "delegate already expired")
        val prior = watchDelegatesByUser[u]?.firstOrNull()
        watchDelegatesByUser[u] = mutableListOf(
            WatchDelegateInfo(
                grantId = body.grant.grantId,
                delegatePubKey = body.grant.delegatePubKey.lowercase(),
                scopes = body.grant.scopes,
                issuedAt = body.grant.issuedAt,
                expiresAt = body.grant.expiresAt,
            )
        )
        return WatchDelegateMintResponse(
            ok = true,
            grantId = body.grant.grantId,
            expiresAt = body.grant.expiresAt,
            replacedGrantId = prior?.grantId,
        )
    }

    override suspend fun listWatchDelegates(username: String): WatchDelegatesListResponse {
        tick()
        val u = username.lowercase()
        val active = (watchDelegatesByUser[u] ?: emptyList()).filter { it.expiresAt > nowMs() }
        return WatchDelegatesListResponse(username = u, delegates = active)
    }

    override suspend fun revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) {
        tick()
        val u = username.lowercase()
        watchDelegatesByUser[u]?.removeAll { it.grantId == body.request.grantId }
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
        /** Control-plane apex, via [Endpoints] (prod-default + test override). */
        val DEFAULT_BASE_URL: String get() = Endpoints.controlBaseUrl
    }

    override suspend fun claimUsername(req: UsernameClaimRequest) {
        // 409 (already-claimed-by-same-IRK) is idempotent success
        transport.postJson(
            "$base/api/username/claim", req,
            serializer = UsernameClaimRequest.serializer(),
            accept = setOf(200, 201, 204, 409),
        )
    }

    override suspend fun selfDeleteAccount(req: AccountSelfDeleteBundleRequest) {
        // Only 200 is success; 403 (not last device / bad sig) + 404 throw
        // HttpException so the caller surfaces it and never wipes locally.
        transport.postJson(
            "$base/api/account/self-delete", req,
            serializer = AccountSelfDeleteBundleRequest.serializer(),
            accept = setOf(200),
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

    override suspend fun releaseServerName(req: ReleaseServerNameRequest) {
        transport.postJson(
            "$base/api/server/release", req,
            serializer = ReleaseServerNameRequest.serializer(),
        )
    }

    override suspend fun revokeServer(req: ServerRevocationRequest) {
        // P13 — the matching `.com` Worker route is not yet wired (a
        // precedent endpoint exists on the apps/web Fastify server).
        // The URL path is fixed per the orchestrator handoff so the
        // wire shape is ready once the Worker handler lands.
        transport.postJson(
            "$base/api/server-registry/revoke", req,
            serializer = ServerRevocationRequest.serializer(),
        )
    }

    override suspend fun usernameAvailable(username: String): UsernameAvailabilityResponse =
        transport.postJsonForResponse(
            "$base/api/users/check",
            UsernameAvailabilityCheckBody(username),
            serializer = UsernameAvailabilityCheckBody.serializer(),
            responseSerializer = UsernameAvailabilityResponse.serializer(),
        )

    override suspend fun suggestUsername(deviceKey: String): UsernameSuggestion {
        val bodyBytes = transport.json
            .encodeToString(SuggestUsernameBody.serializer(), SuggestUsernameBody(deviceKey))
            .encodeToByteArray()
        // accept 429 so the throttle is a normal outcome, not an exception.
        val resp = transport.execute(
            method = "POST",
            url = "$base/api/username/suggest",
            body = bodyBytes,
            contentType = "application/json",
            accept = setOf(200, 429),
        )
        val wire = transport.json.decodeFromString(
            SuggestUsernameWire.serializer(), resp.body.decodeToString(),
        )
        return if (resp.status == 429) {
            UsernameSuggestion(name = null, retryAfterMs = wire.retryAfterMs ?: 3000, throttled = true)
        } else {
            UsernameSuggestion(name = wire.name, retryAfterMs = wire.retryAfterMs ?: 2000, throttled = false)
        }
    }

    override suspend fun fetchProvisionStatus(serial: String): ProvisionStatusRecord? {
        // GET /api/order/<serial>/status — 200 carries the record; 404
        // means "no report yet" → surface as null (the poller renders the
        // booting lead-in). accept={200,404} so a missing record isn't an
        // exception.
        val encoded = java.net.URLEncoder.encode(serial, "UTF-8")
        val resp = transport.execute(
            method = "GET",
            url = "$base/api/order/$encoded/status",
            accept = setOf(200, 404),
        )
        if (resp.status == 404) return null
        return transport.json.decodeFromString(
            ProvisionStatusRecord.serializer(),
            resp.body.decodeToString(),
        )
    }

    override suspend fun registerRecoveryEnvelope(req: RecoveryEnvelopeRequest): RecoveryEnvelopeResponse =
        transport.postJsonForResponse(
            "$base/api/recovery", req,
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

    override suspend fun fetchWrappedUmkWithToken(
        username: String,
        fetchTokenHex: String,
        issuedAt: Long,
    ): GatedRecoveryEnvelope {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            "$base/api/recovery/by-username/$encoded/fetch",
            GatedRecoveryFetchRequest(fetchToken = fetchTokenHex, issuedAt = issuedAt),
            serializer = GatedRecoveryFetchRequest.serializer(),
            responseSerializer = GatedRecoveryEnvelope.serializer(),
        )
    }

    override suspend fun registerPushToken(req: PushTokenRegisterRequest): PushTokenRegisterResponse =
        transport.postJsonForResponse(
            "$base/api/push/register", req,
            serializer = PushTokenRegisterRequest.serializer(),
            responseSerializer = PushTokenRegisterResponse.serializer(),
        )

    override suspend fun revokePushToken(req: PushTokenRevokeRequest) {
        val encoded = java.net.URLEncoder.encode(req.request.tokenId, "UTF-8")
        // Revoke is now IRK-signed: ship the `{ request, signature }` body on
        // the DELETE so .com can verify against the token owner's registered
        // IRK before deleting the tether.
        val body = transport.json
            .encodeToString(PushTokenRevokeRequest.serializer(), req)
            .toByteArray(Charsets.UTF_8)
        transport.execute(
            method = "DELETE",
            url = "$base/api/push/$encoded",
            body = body,
            contentType = "application/json",
            accept = setOf(200, 204, 404),
        )
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

    override suspend fun fetchPendingRePair(username: String): PendingRePairSnapshot {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        // accept 404/405 so an older Worker (no GET wired) is surfaced as
        // `unavailable` rather than thrown — the caller just hides the
        // banner. Mirrors the webapp's `unavailable` fallback.
        val resp = transport.execute(
            method = "GET",
            url = "$base/api/users/$encoded/re-pair",
            accept = setOf(200, 404, 405),
        )
        if (resp.status == 404 || resp.status == 405) {
            return PendingRePairSnapshot(pending = null, unavailable = true)
        }
        val body = transport.json.decodeFromString(
            PendingRePairWireBody.serializer(),
            resp.body.decodeToString(),
        )
        return PendingRePairSnapshot(pending = body.pending)
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

    override suspend fun resolveAccount(username: String): AccountResolution {
        // GET /api/account/resolve/<username> — 200 ALWAYS. A missing
        // account comes back as kind="unknown", so there is no error
        // status to special-case here.
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.getJson(
            url = "$base/api/account/resolve/$encoded",
            responseSerializer = AccountResolution.serializer(),
        )
    }

    override suspend fun admitDevice(account: String, req: DeviceAdmitRequest): DeviceAdmitResponse {
        val encoded = java.net.URLEncoder.encode(account, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/devices/admit",
            body = req,
            serializer = DeviceAdmitRequest.serializer(),
            responseSerializer = DeviceAdmitResponse.serializer(),
        )
    }

    override suspend fun mintWatchDelegate(username: String, body: WatchDelegateMintRequest): WatchDelegateMintResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/watch-delegates",
            body = body,
            serializer = WatchDelegateMintRequest.serializer(),
            responseSerializer = WatchDelegateMintResponse.serializer(),
        )
    }

    override suspend fun listWatchDelegates(username: String): WatchDelegatesListResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.getJson(
            url = "$base/api/users/$encoded/watch-delegates",
            responseSerializer = WatchDelegatesListResponse.serializer(),
        )
    }

    override suspend fun revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        transport.postJson(
            url = "$base/api/users/$encoded/watch-delegates/revoke",
            body = body,
            serializer = WatchDelegateRevokeRequest.serializer(),
        )
    }
}

@Serializable
private data class UsernameAvailabilityCheckBody(@SerialName("username") val username: String)

@Serializable
private data class SuggestUsernameBody(@SerialName("deviceKey") val deviceKey: String)

@Serializable
private data class SuggestUsernameWire(
    val name: String? = null,
    val retryAfterMs: Int? = null,
)
