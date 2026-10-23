// Kotlin mirror of FlagshipAPI/Client/FlagshipServerClient.swift.
//
// Pre-pairing endpoints on flagshipserver.com (the Worker). The phone
// hits these to mint an InstallBlob before delivering it through the
// QR-relay WebSocket, plus the post-pairing push + recovery surfaces.
//
// MIRRORS: apps/com/src/route.ts (v2 relay branch). Wire shapes are
// byte-identical to the Swift side — the Worker treats requests from
// both clients the same.
//
// A call `.com`'s rate limiter refuses throws RateLimitedException (an
// HttpException with status 429) whose message says who is limited and when
// to try again (OkHttpJsonTransport maps the `error: "rate-limited"` body).

package com.flagshipserver.app.api

import com.flagshipserver.app.core.AccountReadTokens
import com.flagshipserver.app.core.Endpoints
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.RateLimitedException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString

interface FlagshipServerClient {
    suspend fun bootstrapAccount(req: AccountBootstrapRequest): AccountBootstrapResponse =
        error("account bootstrap unavailable")
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
    /** P13 — per-server kill-switch. Sensitive-order-key-signed
     *  `ServerRevocation` envelope POSTed to /api/server-registry/revoke.
     *  The box can't connect or unlock until [unrevokeServer]. Reason ∈
     *  {"lost","stolen","decommissioned"}. Mirrors the webapp
     *  `revokeServer` + the iOS `revokeServer` shape. */
    suspend fun revokeServer(req: ServerRevocationRequest)
    /** POST /api/server-registry/unrevoke — undo a lost / stolen /
     *  decommissioned revoke. 403 bad signature / stale / not owner, 404
     *  unknown, 409 the server was deleted or transferred. */
    suspend fun unrevokeServer(req: UnrevokeServerRequest): UnrevokeServerResponse =
        error("server un-revoke unavailable")
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

    /** N03 — where the stored recovery record's signed history stands (null = none). A new record
     *  chains onto it. */
    suspend fun recoveryRecordState(username: String): com.flagshipserver.app.core.RecoveryRecordState? = null

    /** The admin root `.com` pins for the account, lowercase hex (null = none). The record is
     *  written under it and `.com` checks it matches. */
    suspend fun pinnedAdminRoot(username: String): String? = null
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

    suspend fun accountDirectory(
        accountId: String,
        authorization: AccountDirectoryAuthorization,
    ): AccountDirectoryResponse = error("account directory unavailable")
    suspend fun putAccountProfile(accountId: String, authorization: AccountDirectoryAuthorization, body: DirectoryProfileWriteRequest): Unit = error("account directory unavailable")
    suspend fun putDeviceSelfProfile(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, body: DirectoryProfileWriteRequest): Unit = error("account directory unavailable")
    suspend fun putDeviceManagedProfile(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, body: DirectoryManagedProfileWriteRequest): Unit = error("account directory unavailable")
    suspend fun deleteDeviceManagedProfile(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, expectedRevision: Long): Unit = error("account directory unavailable")
    suspend fun revokeAccountDevice(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization): Unit = error("account directory unavailable")

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

    /** C7 — finalize a pending re-pair after the grace. Signed by the
     *  NEW IRK (the key the pending row installs); 401 = unsigned or
     *  wrong key, 425 = grace not elapsed, 409 = objected, 200 = swap
     *  done. */
    suspend fun completeRePair(
        username: String,
        body: RePairCompleteRequest,
    ): RePairCompleteResponse

    /** M4 — read the pending re-pair row (GET /api/users/:u/re-pair).
     *  Powers the Trusted-devices "Replace pending" banner so a replace
     *  started on ANY device surfaces with a grace countdown + a
     *  "Finalize now" entry into the finalize screen. 404/405 →
     *  `unavailable` (older Worker) so the caller just hides the banner.
     *  Mirrors the webapp's `fetchPendingRePair` + the iOS client. */
    suspend fun fetchPendingRePair(username: String): PendingRePairSnapshot

    /** An active admin rejects a pending recovery (N04). POST /api/users/:u/re-pair/veto with a
     *  `RePairVeto` signed by the account's admin root. 409 = already cancelled or completed. */
    suspend fun vetoRePair(username: String, body: RePairVetoRequest)

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
     *  { displayLabel, canonicalUrl, instances, shortUrl }. */
    suspend fun getAppLinks(
        username: String,
        serviceId: String,
    ): AppLinksResponse

    /** v1.2 Phase 4 — read the account-type / TOTP-enrolled state for
     *  the Settings security badge. Maps to GET /api/users/:u. */
    suspend fun getUsernameRecord(username: String): UsernameLookupResponse

    /** The account's identity-root pub (hex) as the CA signed it, from
     *  GET /api/users/:u/pubkey-cert. A joining device verifies its invite
     *  against this; the bare /api/users/:u record no longer exists. */
    suspend fun getAccountIrkPub(username: String): String

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
    /** Demo-only session mint. `.com` signs the narrow
     *  `add-paired-session` order because demo profiles hold no local IRK. */
    suspend fun pairDemoSession(username: String, token: String): DemoPairSessionResponse =
        error("demo pairing unavailable")

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

    /** Slice D (docs/device-admin-tier-spec.md §5) — submit an admin master-root
     *  rotation proof. The OLD admin root signed `{old → new}`; `.com` records
     *  the new `admin_root_pub_hex` (advisory) + relays the signed proof to each
     *  box, which re-pins ONLY after verifying it against its pinned old root
     *  (never `.com`'s word). Rotation EXCLUDES other admin devices holding the
     *  old bare root (the revoke semantic).
     *    POST /api/users/:username/admin-root-rotation */
    suspend fun rotateAdminRoot(username: String, req: AdminRootRotationRequest)
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
    val grant: Grant,
    val grantSignature: String,
    val profile: AccountBootstrapRequest.Profile,
    val request: PushTokenRegisterRequest.Inner,
    /** PushTokenRegister signature, carried for storage. Hex. */
    val signature: String,
) {
    @Serializable
    data class Grant(
        val grantId: String,
        val username: String,
        val deviceId: String,
        val devicePubHex: String,
        val scopes: List<String>,
        val issuedAt: Long,
        val expiresAt: Long,
        val signerRoot: String,
    )
    @Serializable
    data class AdmitEnvelope(
        val username: String,
        val deviceId: String,
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
)

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
    /** `.com`'s short-lived attestation that the caller cleared the
     *  cloud-recovery passphrase gate, handed back by the gated
     *  wrapped-UMK fetch. The single-device credential. */
    val recoveryProof: RecoveryProof? = null,
    /** Hex Ed25519 signature over the SAME canonical bytes as
     *  `signature`, by the account's CURRENTLY REGISTERED IRK.
     *
     *  Why any of these three are needed: `signature` is made by the
     *  key we are asking `.com` to install, and `oldIrkPub` is public
     *  (the username lookup serves it) — so neither proves the caller
     *  owns the account. Recovery is credential-only, and `.com`
     *  refuses an initiate that carries none of them. This one is the
     *  strongest: holding the registered key IS account ownership, and
     *  it is the key-file / already-signed-in-device route. */
    val oldIrkSignature: String? = null,
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

    /** The gated wrapped-UMK fetch's recovery-session token. Opaque. */
    @Serializable
    data class RecoveryProof(
        val token: String,
    )
}

/** Body for POST /api/users/:u/re-pair/veto. */
@Serializable
data class RePairVetoRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val newIrkPub: String,
        val initiatedAt: Long,
        val completesAt: Long,
        val vetoerPub: String,
        val issuedAt: Long,
    )
}

/** Body for POST /api/users/:u/re-pair/complete — a `RePairComplete`
 *  envelope signed by the NEW IRK (the key the pending row installs).
 *  The endpoint used to be a bare public POST, so anyone could fire the
 *  swap the moment a row ripened. The swap TARGET still comes from the
 *  pending row, so this authorizes the scheduled rotation and can never
 *  redirect it. Mirrors the TS `CompleteRePairBody` + iOS
 *  `RePairCompleteRequest`. */
@Serializable
data class RePairCompleteRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val newIrkPub: String,   // hex; must equal the pending row's
        val issuedAt: Long,      // ms
    )
}

@Serializable
data class RePairInitiateResponse(
    val ok: Boolean,
    val completesAt: Long,
    val graceMs: Long,
)

/** Slice D (§5) — POST /api/users/:username/admin-root-rotation body. Mirrors
 *  the TS/iOS/webapp contract: the rotation payload + the OLD-root signature
 *  over its canonical bytes (`AdminRootRotationClaim`). The pubkeys are
 *  lowercased hex; `signatureHex` is the 64-byte Ed25519 sig, lowercased hex. */
@Serializable
data class AdminRootRotationRequest(
    val rotation: Rotation,
    val signatureHex: String,
) {
    @Serializable
    data class Rotation(
        val username: String,
        val oldAdminRootPub: String,
        val newAdminRootPub: String,
        val issuedAt: Long,
    )
}

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

data class AccountDirectoryAuthorization(
    val deviceId: String,
    val signerPubHex: String,
    val requestId: String,
    val issuedAt: Long,
    val signatureHex: String,
)

@Serializable
data class DirectoryProfileEnvelope(
    val accountId: String,
    val deviceId: String? = null,
    val revision: Long,
    val keyVersion: Long,
    val nonceHex: String,
    val ciphertextHex: String,
    val issuedAt: Long,
    val signerPubHex: String,
    val signatureHex: String,
)

@Serializable
data class DirectoryManagedProfileEnvelope(
    val accountId: String,
    val deviceId: String,
    val revision: Long,
    val keyVersion: Long,
    val nonceHex: String,
    val ciphertextHex: String,
    val locked: Boolean,
    val issuedAt: Long,
    val signerPubHex: String,
    val signatureHex: String,
)

@Serializable
data class DirectoryProfileWriteRequest(
    val profile: DirectoryProfileEnvelope,
    val expectedRevision: Long,
)

@Serializable
data class DirectoryManagedProfileWriteRequest(
    val profile: DirectoryManagedProfileEnvelope,
    val expectedRevision: Long,
)

@Serializable
private data class DirectoryDeleteRequest(val expectedRevision: Long)

@Serializable
data class AccountDirectoryAccountProfile(
    val accountId: String,
    val revision: Long,
    val keyVersion: Long,
    val nonceHex: String,
    val ciphertextHex: String,
    val signerPubHex: String,
    val signatureHex: String,
    val issuedAt: Long,
    val updatedAt: Long,
)

@Serializable
data class AccountDirectoryDevice(
    val accountId: String,
    val deviceId: String,
    val devicePubHex: String,
    val platformClass: String? = null,
    val createdAt: Long,
    val lastSeenAt: Long,
    val revokedAt: Long? = null,
    val supportCode: String,
)

@Serializable
data class AccountDirectoryGrant(
    val grantId: String,
    val username: String,
    val deviceId: String,
    val devicePubHex: String,
    val scopesJson: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val signatureHex: String,
    val revokedAt: Long? = null,
    val signerRoot: String,
) {
    fun scopes(json: kotlinx.serialization.json.Json): Set<String> =
        runCatching { json.decodeFromString<List<String>>(scopesJson).toSet() }.getOrDefault(emptySet())
}

@Serializable
data class AccountDirectorySelfProfile(
    val accountId: String,
    val deviceId: String,
    val revision: Long,
    val keyVersion: Long,
    val nonceHex: String,
    val ciphertextHex: String,
    val signerPubHex: String,
    val signatureHex: String,
    val issuedAt: Long,
    val updatedAt: Long,
)

@Serializable
data class AccountDirectoryManagedProfile(
    val accountId: String,
    val deviceId: String,
    val revision: Long,
    val keyVersion: Long,
    val nonceHex: String,
    val ciphertextHex: String,
    val locked: Boolean,
    val signerPubHex: String,
    val signatureHex: String,
    val issuedAt: Long,
    val updatedAt: Long,
)

@Serializable
data class AccountDirectoryResponse(
    val accountId: String,
    val accountProfile: AccountDirectoryAccountProfile? = null,
    val devices: List<AccountDirectoryDevice> = emptyList(),
    val grants: List<AccountDirectoryGrant> = emptyList(),
    val selfProfiles: List<AccountDirectorySelfProfile> = emptyList(),
    val managedProfiles: List<AccountDirectoryManagedProfile> = emptyList(),
)

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

/** GET /api/users/:u/pubkey-cert: only the bound key is read. */
@Serializable
data class PubkeyCertResponse(val binding: Binding) {
    @Serializable
    data class Binding(val pubKey: String)
}

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

@Serializable
data class AccountBootstrapRequest(
    val claim: Claim,
    val aidPub: String,
    val adminRootPub: String,
    val device: Device,
    val grant: Grant,
    val accountProfile: Profile,
    val deviceProfile: Profile,
) {
    @Serializable data class Claim(val request: UsernameClaimRequest.Inner, val signature: String)
    @Serializable data class Device(val deviceId: String, val devicePubHex: String, val platformClass: String)
    @Serializable data class Grant(
        val grantId: String,
        val username: String,
        val deviceId: String,
        val devicePubHex: String,
        val scopes: List<String>,
        val issuedAt: Long,
        val expiresAt: Long,
        val signatureHex: String,
    )
    @Serializable data class Profile(
        val accountId: String,
        val deviceId: String? = null,
        val revision: Long,
        val keyVersion: Long,
        val nonceHex: String,
        val ciphertextHex: String,
        val issuedAt: Long,
        val signerPubHex: String,
        val signatureHex: String,
    )
}

@Serializable
data class AccountBootstrapResponse(
    val ok: Boolean,
    val username: String,
    val accountId: String,
    val deviceId: String,
    val created: Boolean,
)

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
    /** hex, the admin root over `AuthCode.adminCanonicalBytes()`. Adding a
     *  server is admin-only: `.com` refuses a code on an admin-pinned account
     *  without it. Null only for a demo account (no admin root pinned). */
    val adminSignature: String? = null,
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
     *  admin anchor). The server pins it at first boot into
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

/** P13 — POST /api/server-registry/revoke. Signed envelope that locks a
 *  server out (kill switch) until the owner un-revokes it. Mirrors the
 *  canonical-bytes tag
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

/** POST /api/server-registry/unrevoke. Canonical bytes:
 *  `flagship/server-unrevoke/v1|<username>|<serverDomain>|<issuedAt>`
 *  (core.ServerUnrevocation), signed by the sensitive-order key. */
@Serializable
data class UnrevokeServerRequest(
    val request: Inner,
    val signature: String,
) {
    @Serializable
    data class Inner(
        val username: String,
        val serverDomain: String,
        val issuedAt: Long,
    )
}

@Serializable
data class UnrevokeServerResponse(
    val ok: Boolean = false,
    val unrevokedAt: Long? = null,
    val dnsRepublished: Int? = null,
    val alreadyActive: Boolean = false,
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

/** One sign-up handle suggestion. On a 200 `name` is set + `throttled` is false;
 *  on a 429 `name` is null + `throttled` is true. `retryAfterMs` is the cooldown
 *  until the next regenerate is allowed either way. [message] is set when `.com`'s
 *  rate limiter (not the regenerate cooldown) refused: the sentence to show. */
@Serializable
data class UsernameSuggestion(
    val name: String? = null,
    val retryAfterMs: Int = 0,
    val throttled: Boolean = false,
    val message: String? = null,
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
     *  in DemoAccount + the on-connect-provisioning flow. Absent ⇒
     *  legacy (testAccount-only) behaviour preserved. See
     *  docs/sample-users.md §10.9. */
    val demoServer: DemoServerBlock? = null,
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

@Serializable
data class DemoPairSessionRequest(val token: String)

@Serializable
data class DemoPairSessionResponse(val ok: Boolean, val fqdn: String)

/** v2 device-addressing — mirror of the Worker's `deviceCapability`
 *  block in `packages/control-plane/src/usersCheck.ts`. Embedded into
 *  the `/api/users/check` response when the typed username matched
 *  a matching active DeviceCapabilityGrant exists.
 *
 *  Note: `scopes` is a wire-format list of strings. Use [scopeSet]
 *  for the typed forward-compat parse (unknown future scope strings
 *  are silently dropped). */
@Serializable
data class DeviceCapabilityBlock(
    val deviceId: String,
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
    VIEW_DIRECTORY("view-directory"),
    DEMO_PROVISION("demo-provision");

    companion object {
        /** Forward-compat: unknown future strings return null so an
         *  older binary on a newer Worker silently drops them rather
         *  than crashing. */
        fun fromWire(wire: String): DeviceScope? =
            values().firstOrNull { it.wire == wire }
    }
}

/** `POST /api/recovery` — the IRK-SIGNED cloud-recovery upload (record v2, N03). Serializes to
 *  `{ claim, signature, wrappedUmk, wrappedAdminRoot?, wrappedAcmeAccountKey? }`.
 *
 *  `claim` is the complete signed record: it names the digest of every ciphertext, the fetch-token
 *  and PRF-salt hashes, the record's generation and the digest of the record it replaces. `.com`
 *  checks each ciphertext against its signed digest and the chain by compare-and-swap, so no valid
 *  signature authorizes a different record. `wrappedUmk` is a SINGLE self-contained blob
 *  (nonce ‖ ct ‖ tag); the admin-root and ACME ciphertexts accompany exactly the fields the claim
 *  replaces. `signature` is hex Ed25519 by the account IRK over `claim.canonicalBytes()`. */
@Serializable
data class RecoveryEnvelopeRequest(
    val claim: com.flagshipserver.app.core.RecoveryRecordV2,
    val signature: String,           // hex, IRK
    val wrappedUmk: String,
    val wrappedAdminRoot: String? = null,
    val wrappedAcmeAccountKey: String? = null,
)

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
    /** `.com`'s short-lived attestation that this fetch cleared the
     *  passphrase gate. It is the credential a follow-on re-pair
     *  initiate must present on a single-device account, whose request
     *  is otherwise signed only by the key it asks to install, over a
     *  publicly-readable `oldIrkPub`. Absent when the deployment has no
     *  `FLAGSHIP_RECOVERY_PROOF_SECRET` (the initiate then fails closed
     *  rather than proceeding unauthenticated). */
    val recoveryProof: RecoveryProofToken? = null,
    /** N03 — the owner's signed record, served exactly as stored. Check every ciphertext above
     *  against its digests BEFORE unwrapping, and its signature once the key is recovered. Absent
     *  for a legacy (v1) record, whose escrow extras carry no signature. */
    val signed: com.flagshipserver.app.core.SignedRecoveryRecord? = null,
    val legacy: Boolean? = null,
)

/** The gated fetch's recovery-session attestation. Opaque to clients. */
@Serializable
data class RecoveryProofToken(
    val token: String,
    val expiresAt: Long? = null,
)

/** POST /api/push/register canonical-bytes envelope. */
@Serializable
data class PushTokenRegisterRequest(
    val request: Inner,
    val signature: String,           // hex, IRK
) {
    @Serializable
    data class Inner(
        val username: String,
        val deviceId: String,
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

    override suspend fun bootstrapAccount(req: AccountBootstrapRequest): AccountBootstrapResponse =
        transport.postJsonForResponse(
            "$base/api/accounts",
            req,
            serializer = AccountBootstrapRequest.serializer(),
            responseSerializer = AccountBootstrapResponse.serializer(),
        )

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

    override suspend fun unrevokeServer(req: UnrevokeServerRequest): UnrevokeServerResponse =
        transport.postJsonForResponse(
            "$base/api/server-registry/unrevoke", req,
            serializer = UnrevokeServerRequest.serializer(),
            responseSerializer = UnrevokeServerResponse.serializer(),
        )

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
        val rateLimit = RateLimitedException.parse(
            resp.status,
            resp.body.decodeToString(),
            resp.headers.entries.firstOrNull { it.key.equals("Retry-After", ignoreCase = true) }?.value,
        )
        return if (rateLimit != null) {
            val ms = rateLimit.retryAfterSec?.let { (it * 1000).coerceIn(0, Int.MAX_VALUE.toLong()).toInt() }
            UsernameSuggestion(
                name = null,
                retryAfterMs = wire.retryAfterMs ?: ms ?: 3000,
                throttled = true,
                message = rateLimit.userMessage,
            )
        } else if (resp.status == 429) {
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

    override suspend fun accountDirectory(
        accountId: String,
        authorization: AccountDirectoryAuthorization,
    ): AccountDirectoryResponse {
        val normalized = accountId.lowercase()
        val encoded = java.net.URLEncoder.encode(normalized, "UTF-8")
        val resp = transport.execute(
            method = "GET",
            url = "$base/api/accounts/$encoded/directory",
            extraHeaders = mapOf(
                "x-flagship-device-id" to authorization.deviceId,
                "x-flagship-device-pub" to authorization.signerPubHex,
                "x-flagship-request-id" to authorization.requestId,
                "x-flagship-issued-at" to authorization.issuedAt.toString(),
                "x-flagship-signature" to authorization.signatureHex,
                "cache-control" to "no-store",
            ),
            accept = setOf(200),
        )
        return transport.json.decodeFromString(
            AccountDirectoryResponse.serializer(),
            resp.body.decodeToString(),
        )
    }

    override suspend fun putAccountProfile(accountId: String, authorization: AccountDirectoryAuthorization, body: DirectoryProfileWriteRequest) {
        directoryMutation(
            "PUT", "/api/accounts/${accountId.lowercase()}/profile", authorization,
            transport.json.encodeToString(DirectoryProfileWriteRequest.serializer(), body).toByteArray(),
        )
    }

    override suspend fun putDeviceSelfProfile(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, body: DirectoryProfileWriteRequest) {
        directoryMutation(
            "PUT", "/api/accounts/${accountId.lowercase()}/devices/${deviceId.lowercase()}/profile", authorization,
            transport.json.encodeToString(DirectoryProfileWriteRequest.serializer(), body).toByteArray(),
        )
    }

    override suspend fun putDeviceManagedProfile(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, body: DirectoryManagedProfileWriteRequest) {
        directoryMutation(
            "PUT", "/api/accounts/${accountId.lowercase()}/devices/${deviceId.lowercase()}/managed-profile", authorization,
            transport.json.encodeToString(DirectoryManagedProfileWriteRequest.serializer(), body).toByteArray(),
        )
    }

    override suspend fun deleteDeviceManagedProfile(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization, expectedRevision: Long) {
        directoryMutation(
            "DELETE", "/api/accounts/${accountId.lowercase()}/devices/${deviceId.lowercase()}/managed-profile", authorization,
            transport.json.encodeToString(DirectoryDeleteRequest.serializer(), DirectoryDeleteRequest(expectedRevision)).toByteArray(),
        )
    }

    override suspend fun revokeAccountDevice(accountId: String, deviceId: String, authorization: AccountDirectoryAuthorization) {
        directoryMutation(
            "DELETE", "/api/accounts/${accountId.lowercase()}/devices/${deviceId.lowercase()}", authorization,
            transport.json.encodeToString(DirectoryDeleteRequest.serializer(), DirectoryDeleteRequest(0)).toByteArray(),
        )
    }

    private suspend fun directoryMutation(
        method: String,
        path: String,
        authorization: AccountDirectoryAuthorization,
        body: ByteArray,
    ) {
        transport.execute(
            method = method,
            url = "$base$path",
            body = body,
            contentType = "application/json; charset=utf-8",
            extraHeaders = mapOf(
                "x-flagship-device-id" to authorization.deviceId,
                "x-flagship-device-pub" to authorization.signerPubHex,
                "x-flagship-request-id" to authorization.requestId,
                "x-flagship-issued-at" to authorization.issuedAt.toString(),
                "x-flagship-signature" to authorization.signatureHex,
                "cache-control" to "no-store",
            ),
            accept = setOf(200),
        )
    }

    override suspend fun listAuditEvents(username: String, sinceSeq: Int, limit: Int): AuditEventListResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val since = sinceSeq.coerceAtLeast(0)
        val capped = limit.coerceIn(1, 50)
        return AccountReadTokens.authorize(username) { auth ->
            transport.getJson(
                "$base/api/users/$encoded/audit?since=$since&limit=$capped",
                responseSerializer = AuditEventListResponse.serializer(),
                extraHeaders = auth,
            )
        }
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

    override suspend fun recoveryRecordState(username: String): com.flagshipserver.app.core.RecoveryRecordState? {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val resp = transport.execute(
            method = "GET",
            url = "$base/api/recovery/by-username/$encoded",
            accept = setOf(200, 404),
        )
        if (resp.status == 404) return null
        return transport.json.decodeFromString(
            com.flagshipserver.app.core.RecoveryRecordState.serializer(),
            resp.body.decodeToString(),
        )
    }

    override suspend fun pinnedAdminRoot(username: String): String? {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val resp = transport.execute(method = "GET", url = "$base/api/username/$encoded", accept = setOf(200))
        val pub = transport.json.parseToJsonElement(resp.body.decodeToString())
            .let { (it as? kotlinx.serialization.json.JsonObject)?.get("adminRootPub") }
            ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        return pub?.lowercase()
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

    override suspend fun completeRePair(
        username: String,
        body: RePairCompleteRequest,
    ): RePairCompleteResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/users/$encoded/re-pair/complete",
            body = body,
            serializer = RePairCompleteRequest.serializer(),
            responseSerializer = RePairCompleteResponse.serializer(),
        )
    }

    override suspend fun vetoRePair(username: String, body: RePairVetoRequest) {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        transport.postJson(
            url = "$base/api/users/$encoded/re-pair/veto",
            body = body,
            serializer = RePairVetoRequest.serializer(),
            accept = setOf(200),
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
        return AccountReadTokens.authorize(username) { auth ->
            transport.getJson(
                url = "$base/api/users/$u/apps/$a/links",
                responseSerializer = AppLinksResponse.serializer(),
                extraHeaders = auth,
            )
        }
    }

    override suspend fun getUsernameRecord(username: String): UsernameLookupResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.getJson(
            url = "$base/api/users/$encoded",
            responseSerializer = UsernameLookupResponse.serializer(),
        )
    }

    override suspend fun getAccountIrkPub(username: String): String {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.getJson(
            url = "$base/api/users/$encoded/pubkey-cert",
            responseSerializer = PubkeyCertResponse.serializer(),
        ).binding.pubKey
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

    override suspend fun pairDemoSession(username: String, token: String): DemoPairSessionResponse {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        return transport.postJsonForResponse(
            url = "$base/api/dev/sample-user/$encoded/pair",
            body = DemoPairSessionRequest(token),
            serializer = DemoPairSessionRequest.serializer(),
            responseSerializer = DemoPairSessionResponse.serializer(),
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

    override suspend fun rotateAdminRoot(username: String, req: AdminRootRotationRequest) {
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        transport.postJson(
            url = "$base/api/users/$encoded/admin-root-rotation",
            body = req,
            serializer = AdminRootRotationRequest.serializer(),
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
