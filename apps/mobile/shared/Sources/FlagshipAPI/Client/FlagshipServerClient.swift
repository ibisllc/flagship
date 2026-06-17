import Foundation
import CryptoKit

/// Client for the pre-pairing endpoints on flagshipserver.com (the
/// Cloudflare Worker at `apps/com/`). The phone hits these BEFORE it has
/// a paired pod and a session token.
///
/// As of relay-v2 (apps/com `41a126e`), the mint-build-code flow is
/// retired. The phone instead drives a three-step control-plane sequence
/// to mint an InstallBlob, then delivers the blob to a desktop browser
/// over the QR-relay WebSocket (see QrRelayClient + create-server.js).
///
///   1. POST /api/username/claim       (idempotent; 409 on collision OK)
///   2. POST /api/auth-code/issue      (issues a signed AuthCode)
///   3. POST /api/routing/register-rck (registers the routing-control key)
///
/// Each request body is a signed canonical-bytes envelope using the
/// device's IRK (derived via Flagship/Keystore.deriveIRK).
public protocol FlagshipServerClient: Sendable {
    func claimUsername(_ req: UsernameClaimRequest) async throws
    func issueAuthCode(_ req: AuthCodeIssueRequest) async throws
    func registerRck(_ req: RckRegisterRequest) async throws
    /// Revoke an outstanding auth-code so a server that hasn't phoned
    /// home yet can't register with this serial. User-facing this is
    /// the "Cancel order" action on a pending pod. 404 is treated as
    /// success by both Mock + Live impls.
    func revokeAuthCode(_ req: AuthCodeRevokeRequest) async throws
    /// Release a reserved server name (free the name) so it can be
    /// claimed again. The real mechanism behind "Cancel server": an
    /// IRK-signed `ReleaseServerName` envelope POSTed to
    /// `/api/server/release`, which drops the routing record + active
    /// auth-codes + the server record. Unlike a bare auth-code revoke
    /// this un-pins the name itself. Mirrors webapp `releaseServerName`.
    func releaseServerName(_ req: ReleaseServerNameRequest) async throws
    /// P13 — per-server kill-switch. IRK-signed `ServerRevocation`
    /// envelope POSTed to `/api/server-registry/revoke`. The server
    /// will refuse to boot on its next reboot (the box becomes a
    /// brick). Reason ∈ {"lost", "stolen", "decommissioned"}. Mirrors
    /// the webapp `revokeServer` + the Android `revokeServer` shape.
    func revokeServer(_ req: ServerRevocationRequest) async throws
    func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse
    /// Login/join preflight. GET /api/account/resolve/<username>. The
    /// sign-in space is access-control evaluation, not a fetch: this
    /// reads what credentials + factors exist for the named account and
    /// returns them as FIELDS so the client login state machine can
    /// branch. **Returns 200 ALWAYS** — a missing account resolves to
    /// `kind:"unknown"`, never a 404. Mirrors the Worker handler in
    /// packages/control-plane/src/accountResolve.ts. See
    /// docs/login-and-account-redesign.md.
    func resolveAccount(username: String) async throws -> AccountResolution
    func registerRecoveryEnvelope(_ req: RecoveryUploadRequest) async throws -> RecoveryEnvelopeResponse
    func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope
    /// Task #74 — the passphrase-gated wrapped-UMK fetch. POSTs
    /// `{ fetchToken: <hex>, issuedAt: <ms> }` to
    /// `POST /api/recovery/by-username/<username>/fetch`; `.com` releases
    /// the ciphertext only when `SHA-256(fetchToken)` matches the stored
    /// hash (a wrong passphrase → 403; rate-limited 429). Replaces the
    /// dead `GET /api/recovery/fetch` path for the native cloud-recovery
    /// flow. See `RecoveryFetchResponse` for the body shape and
    /// recovery.js `fetchWrappedUmk` for the canonical reference.
    func fetchWrappedUmk(username: String, fetchTokenHex: String) async throws -> RecoveryFetchResponse
    /// Register an APNs device token with .com so the Worker can relay
    /// (or retry) encrypted push payloads to this device. The returned
    /// tokenId is the handle to later revoke the registration.
    func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse
    /// Drop a previously-registered push token. Revoke is IRK-signed
    /// (SEC): the caller signs a `flagship/push-token-revoke/v1` envelope
    /// behind the biometric (deriveIRK) and `.com` verifies it against the
    /// token owner's registered IRK before deleting the tether — a
    /// tokenId-knower can no longer silently kill a device's push
    /// registration. 404 (already gone) is treated as success by both Mock
    /// + Live so a sign-out path doesn't surface "already cleaned up" as an
    /// error.
    func revokePushToken(_ req: PushTokenRevokeRequest) async throws

    /// Phase 3b — vouched cross-device admit. The incoming (collaborator)
    /// device POSTs the admin-signed `DeviceAdmit` envelope + its own
    /// push-token registration to `/api/users/<account>/devices/admit`.
    /// .com verifies the admit under the account's CURRENT IRK (the
    /// admin/vouching device holds it) and admits this device QUARANTINED
    /// (now + 14 days). The response carries that `quarantineUntil` so
    /// the UI can render the countdown. Mirrors handleVouchedDeviceAdmit
    /// in packages/control-plane/src/push.ts.
    func admitDevice(account: String, body: DeviceAdmitRequest) async throws -> DeviceAdmitResponse
    /// Poll-based read of install-events the Worker has accumulated
    /// for a given auth-code serial. Use `since: 0` to read from
    /// the beginning; subsequent polls pass the response's
    /// `cursor`. Worker side: GET /api/install-events/<serial>?since=N.
    func getInstallEvents(serial: String, since: Int) async throws -> InstallEventsPollResponse
    /// List the peer-class trusted devices on the user's account.
    /// Returns the ETag the Worker computed so the caller can pass it
    /// as If-Match on revocation / rotation requests. Worker side:
    /// GET /api/users/:u/devices.
    func listDevices(username: String) async throws -> TrustedDevicesListResponse

    /// Watch delegate keys — opt-in "quick approve a box boot from the Watch".
    /// The phone mints an IRK-signed `WatchDelegateKey` (scoped boot-approval,
    /// 7-day TTL) and registers it; the boot worker then accepts the delegate
    /// key's signature on a boot approval. Mirrors the cloud handlers in
    /// packages/control-plane/src/watchDelegates.ts.
    ///   POST /api/users/:u/watch-delegates
    func mintWatchDelegate(username: String, body: WatchDelegateMintRequest) async throws -> WatchDelegateMintResponse
    ///   GET  /api/users/:u/watch-delegates
    func listWatchDelegates(username: String) async throws -> WatchDelegatesListResponse
    ///   POST /api/users/:u/watch-delegates/revoke
    func revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) async throws

    /// Account-level audit log surfaced via /api/users/:u/audit. Used
    /// by the Activity feed to render device-disconnect / device-
    /// replaced / wipe-restart / recovery-set-up events alongside
    /// the daemon-side install events. `sinceSeq` is exclusive lower
    /// bound; `limit` is clamped server-side to 50.
    func listAuditEvents(username: String, sinceSeq: Int, limit: Int) async throws -> AuditEventListResponse

    /// Returns true iff a cloud-stored recovery envelope exists for the
    /// given username. Powers the Home recovery-setup nudge (B9). The
    /// underlying endpoint is GET /api/recovery/by-username/:u — 200 +
    /// metadata means yes, 404 means no, and any other status is
    /// surfaced as an error so the caller can decide whether to retry
    /// or just hide the nudge until next launch.
    func hasCloudRecovery(username: String) async throws -> Bool

    /// B7 — initiate IRK rotation. POSTs the NEW-IRK-signed re-pair
    /// envelope to /api/users/:u/re-pair. Optional `ifMatch` ETag
    /// (from a fresh listDevices call) fences the concurrent-rotation
    /// race — see Worker A3. Returns the server's pending-grace info.
    func initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?
    ) async throws -> RePairInitiateResponse

    /// B7 — finalize a pending re-pair. Public read (no signature gate);
    /// the server checks completesAt + objectedAt before swapping the
    /// stored IRK pubkey atomically. 425 = grace not elapsed; 409 =
    /// objected; 200 = swap succeeded.
    func completeRePair(username: String) async throws -> RePairCompleteResponse

    /// M4 — read the pending re-pair row, if any. Public GET (no
    /// signature gate), maps to GET /api/users/:u/re-pair. Powers the
    /// Trusted-devices "Replace pending" banner so a replace started on
    /// ANY device surfaces here with a grace countdown + a "Finalize now"
    /// entry into the existing finalize screen. 404/405 → `unavailable`
    /// (older Worker) so the caller just hides the banner. Mirrors the
    /// webapp's `fetchPendingRePair`.
    func fetchPendingRePair(username: String) async throws -> PendingRePairSnapshot

    /// E2 — atomic Wipe & restart. Rotates IRK + recovery envelope in
    /// one server transaction. Body carries OLD-IRK signature over
    /// canonical flagship/wipe-restart/v1 bytes + the new envelope.
    /// 429 = rate-limited (1/hour/username); 409 = lost the CAS race
    /// (concurrent rotation); 412 = stale ETag.
    func wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?
    ) async throws -> WipeRestartResponse

    /// V2 — rename the user-visible URL stem for an app. Signed by
    /// the user's current IRK. The Worker upserts the alias,
    /// cascade-deletes old voi.ci codes, mints a fresh one against
    /// the new canonical URL, emits an audit row.
    func renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest
    ) async throws -> AppRenameResponse

    /// V2 — read the per-user URL identity of an app: { displayLabel,
    /// canonical, instances[] }. Public read; falls back to the
    /// slug-creator default when no alias has been set.
    func getAppLinks(
        username: String,
        serviceId: String
    ) async throws -> AppLinksResponse

    /// Bind an external domain to the app (#79A). Decoupled
    /// request/confirm: a 200 only RECORDS it (.com verifies the CNAME
    /// out-of-band and pushes the outcome); the ONLY synchronous denial
    /// is the 300s rate limit (429 "Too soon — try again in Ns.").
    /// Returns the refreshed links so callers reflect it immediately.
    func setCustomDomain(
        username: String,
        serviceId: String,
        body: SetCustomDomainRequest
    ) async throws -> AppLinksResponse

    /// v1.2 Phase 4 — read the account-type / TOTP-enrolled state for
    /// the Settings security badge. Maps to GET /api/users/:u — public
    /// read; the Worker echoes `accountType` ("single" | "multi") +
    /// `totpEnrolledAt` (ms epoch or null). The TOTP secret itself
    /// is NEVER returned here.
    func getUsernameRecord(username: String) async throws -> UsernameLookupResponse

    /// v1.2 Phase 3/4 — begin TOTP enrollment. IRK-signed envelope
    /// over the `flagship/totp-enroll-begin/v1` canonical bytes; the
    /// Worker stages an encrypted TOTP secret + returns the otpauth
    /// URL + a base64-PNG QR code the UI can render in an <img>.
    /// The account stays `'single'` until enroll-confirm.
    func totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest
    ) async throws -> TotpEnrollBeginResponse

    /// v1.2 Phase 3/4 — finalize TOTP enrollment. IRK-signed envelope
    /// (canonical `flagship/totp-enroll-confirm/v1`) + the user-entered
    /// sample 6-digit code (carried beside the signed body — codes are
    /// ephemeral and don't belong in canonical bytes). On success the
    /// Worker flips `account_type='multi'`, stamps `totp_enrolled_at`,
    /// generates 10 single-use recovery codes (returned ONCE here),
    /// and writes their argon2id hashes.
    func totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest
    ) async throws -> TotpEnrollConfirmResponse

    /// v1.2 Phase 3 — disable TOTP (drop secret + recovery codes,
    /// flip back to `'single'`). Refused by the Worker if other
    /// paired sessions exist (single-device state requires single-
    /// device count).
    func totpDisable(
        username: String,
        body: TotpDisableRequest
    ) async throws -> TotpDisableResponse

    /// Live provisioning-status timeline. GET /api/order/<serial>/status —
    /// keyed by the auth-code SERIAL (the order id the app already holds).
    /// Returns the latest reported phase + the append-only history so a
    /// pending pod can render a real install timeline instead of a bare
    /// spinner. **404 maps to nil** (no checkpoint has arrived yet — a
    /// state, not an error). Mirrors handleGetProvisionStatus in
    /// packages/control-plane/src/provisionStatus.ts.
    func fetchProvisionStatus(serial: String) async throws -> ProvisionStatus?

    /// #43 — list the account's OUTSTANDING install orders (every recipe
    /// minted that the box hasn't registered against and the user hasn't
    /// cancelled). IRK-signed POST to /api/users/:u/outstanding-orders. This
    /// is the server authority the phone reconciles its LOCAL pending-server
    /// cache against: an order present here is a real in-flight install
    /// (surface it even if there's no local record); a local record whose
    /// serial is absent from BOTH this list and the registered `/pods`
    /// inventory is a ghost (drop it). Mirrors handleListOutstandingOrders
    /// in packages/control-plane/src/outstandingOrders.ts.
    func listOutstandingOrders(_ req: OutstandingOrdersRequest) async throws -> OutstandingOrdersResponse
}

public struct AppRenameRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let serviceId: String
        public let newDisplayLabel: String
        public let issuedAt: Int64
        public init(username: String, serviceId: String, newDisplayLabel: String, issuedAt: Int64) {
            self.username = username
            self.serviceId = serviceId
            self.newDisplayLabel = newDisplayLabel
            self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String   // hex; Ed25519 by the user's IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// #79A — IRK-signed external-domain attach request. Same envelope
/// shape as AppRenameRequest; canonical bytes = SetCustomDomainClaim
/// (flagship/custom-domain/v1 | username | serviceId | fqdn | issuedAt),
/// matching the .com verifier + the Android/webapp clients.
public struct SetCustomDomainRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let serviceId: String
        public let fqdn: String
        public let issuedAt: Int64
        public init(username: String, serviceId: String, fqdn: String, issuedAt: Int64) {
            self.username = username
            self.serviceId = serviceId
            self.fqdn = fqdn
            self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String   // hex; Ed25519 by the user's IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

public struct AppRenameResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let displayLabel: String?
    public let canonicalUrl: String?
    public let shortUrl: String?
    public let shortCode: String?
    public let unchanged: Bool?
}

public struct AppLinkInstance: Decodable, Equatable, Sendable, Identifiable {
    public let serverDomain: String
    public let url: String
    public var id: String { serverDomain }
    public init(serverDomain: String, url: String) {
        self.serverDomain = serverDomain
        self.url = url
    }
}

public struct AppLinksResponse: Decodable, Equatable, Sendable {
    public let serviceId: String
    public let displayLabel: String
    public let canonicalUrl: String
    public let instances: [AppLinkInstance]
    /// V4 — lazy-minted by handleGetAppLinks on first call; preserved
    /// across calls until the next Replace cascade-deletes it.
    public let shortUrl: String?
    /// The attached external domain, if the user has requested one. A
    /// Replace never touches it. Shown optimistically at the top of
    /// WEB DOMAINS as soon as it's requested.
    public let customDomain: String?
    /// Whether .com has verified the CNAME. nil/false = requested but
    /// not yet confirmed. Drives the SUBTLE confirm signal: the apps
    /// list swaps the short link for the custom domain only once true.
    /// (The last-change *time* is NOT here — that's stored on-device;
    /// the server keeps its own rate-limit timer in its DB.)
    public let customDomainConfirmed: Bool?
    public init(
        serviceId: String,
        displayLabel: String,
        canonicalUrl: String,
        instances: [AppLinkInstance],
        shortUrl: String?,
        customDomain: String? = nil,
        customDomainConfirmed: Bool? = nil
    ) {
        self.serviceId = serviceId
        self.displayLabel = displayLabel
        self.canonicalUrl = canonicalUrl
        self.instances = instances
        self.shortUrl = shortUrl
        self.customDomain = customDomain
        self.customDomainConfirmed = customDomainConfirmed
    }
}

public struct WipeRestartRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let oldIrkPub: String         // hex
        public let newIrkPub: String         // hex
        public let newCredentialId: String   // hex
        public let newWrappedUmk: String     // base64
        public let issuedAt: Int64           // ms
        public init(
            username: String,
            oldIrkPub: String,
            newIrkPub: String,
            newCredentialId: String,
            newWrappedUmk: String,
            issuedAt: Int64
        ) {
            self.username = username
            self.oldIrkPub = oldIrkPub
            self.newIrkPub = newIrkPub
            self.newCredentialId = newCredentialId
            self.newWrappedUmk = newWrappedUmk
            self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    /// Hex Ed25519 signature by the OLD IRK over the canonical bytes.
    public let signature: String
    /// 32 hex chars (16 random bytes) — server dedupes within 5 min.
    public let idempotencyKey: String

    public init(request: Inner, signature: String, idempotencyKey: String) {
        self.request = request; self.signature = signature
        self.idempotencyKey = idempotencyKey
    }
}

public struct WipeRestartResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let auditSeq: Int
    public let newIrkPub: String
    public let etag: String?
}

public struct RePairInitiateRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let newIrkPub: String   // hex
        public let oldIrkPub: String   // hex
        public let issuedAt: Int64     // ms
        public init(username: String, newIrkPub: String, oldIrkPub: String, issuedAt: Int64) {
            self.username = username; self.newIrkPub = newIrkPub
            self.oldIrkPub = oldIrkPub; self.issuedAt = issuedAt
        }
    }

    /// v1.2 — the out-of-Apple second factor the Worker REQUIRES when
    /// `account_type === 'multi'` — and (#52) for SINGLE-device
    /// accounts with a second factor enrolled (the 401 carries
    /// `credentialRequired`). Carries a live 6-digit TOTP or a
    /// 10-char recovery code beside (NOT inside) the signed envelope —
    /// codes are ephemeral so they don't belong in canonical bytes
    /// (see RePairInitiate.totpProof in packages/protocol/src/auth.ts).
    /// Omitted only when nothing is enrolled. `method` is one of the
    /// two allowed literals the Worker validates structurally.
    public struct TotpProof: Encodable, Equatable, Sendable {
        public let code: String
        public let method: String   // "totp" | "recovery"
        public init(code: String, method: String) {
            self.code = code; self.method = method
        }
    }

    public let request: Inner
    public let signature: String      // hex; Ed25519 over canonical-bytes by NEW IRK
    /// Present for multi-device takeovers AND (#52) for single-device
    /// accounts with an enrolled second factor. The Worker rejects an
    /// initiate that needs-but-omits it (401 + `credentialRequired`)
    /// and ignores it when nothing is enrolled.
    public let totpProof: TotpProof?
    public init(request: Inner, signature: String, totpProof: TotpProof? = nil) {
        self.request = request; self.signature = signature
        self.totpProof = totpProof
    }
}

public struct RePairInitiateResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let completesAt: Int64
    public let graceMs: Int64
}

public struct RePairCompleteResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let newIrkPub: String
    public let swappedAt: Int64
}

/// M4 — the pending re-pair row as returned by GET /api/users/:u/re-pair.
/// Mirrors the Worker's `handleGetRePair` body (`{ pending }`) and the
/// webapp's `fetchPendingRePair` parse. `objectedAt` non-nil means the
/// rotation was cancelled by another device — the banner hides it.
public struct PendingRePairInfo: Decodable, Equatable, Sendable {
    public let newIrkPub: String
    public let oldIrkPub: String
    public let initiatedAt: Int64
    public let completesAt: Int64
    public let objectedAt: Int64?
    public init(
        newIrkPub: String,
        oldIrkPub: String,
        initiatedAt: Int64,
        completesAt: Int64,
        objectedAt: Int64? = nil
    ) {
        self.newIrkPub = newIrkPub; self.oldIrkPub = oldIrkPub
        self.initiatedAt = initiatedAt; self.completesAt = completesAt
        self.objectedAt = objectedAt
    }
}

/// M4 — the GET /re-pair snapshot. `pending == nil` means nothing is in
/// flight; `unavailable == true` means an older Worker doesn't implement
/// the endpoint (404/405) — the caller hides the banner gracefully,
/// exactly like the webapp's `{ pending: null, unavailable: true }`.
/// Built in code from the wire body (PendingRePairWireBody), never
/// decoded directly, so it isn't `Decodable`.
public struct PendingRePairSnapshot: Equatable, Sendable {
    public let pending: PendingRePairInfo?
    public let unavailable: Bool
    public init(pending: PendingRePairInfo?, unavailable: Bool = false) {
        self.pending = pending
        self.unavailable = unavailable
    }
}

public struct AuditEvent: Codable, Equatable, Sendable, Identifiable {
    public let seq: Int
    public let eventKind: String   // "device-disconnected" | "device-replaced" | …
    public let detail: String
    public let devicePrefix: String
    public let postedAt: Int64

    public var id: Int { seq }

    public init(seq: Int, eventKind: String, detail: String, devicePrefix: String, postedAt: Int64) {
        self.seq = seq; self.eventKind = eventKind
        self.detail = detail; self.devicePrefix = devicePrefix
        self.postedAt = postedAt
    }
}

public struct AuditEventListResponse: Codable, Equatable, Sendable {
    public let events: [AuditEvent]
    public init(events: [AuditEvent]) { self.events = events }
}

public struct TrustedDevice: Codable, Equatable, Sendable, Identifiable {
    public let tokenId: String
    public let tokenPrefix: String
    public let label: String
    public let platform: String   // "apns" | "fcm" | "webpush"
    public let addedAt: Int64
    public let lastSeenAt: Int64
    /// v1.2 Phase 4 — wall-clock ms before which this device cannot
    /// revoke another device on the account. Nil / 0 / past = the
    /// 14-day quarantine has elapsed (or never applied), so Remove
    /// / Replace flow as normal. A future value means the row was
    /// freshly admitted and the UI must show a clock indicator +
    /// gate the destructive actions.
    public let quarantineUntil: Int64?

    public var id: String { tokenId }

    /// Convenience for the UI — returns true iff the quarantine
    /// window is in the future relative to `now`. Surfacing here so
    /// view code doesn't replicate the `> now` comparison everywhere.
    public func isQuarantined(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> Bool {
        guard let until = quarantineUntil, until > 0 else { return false }
        return until > now
    }

    public init(
        tokenId: String,
        tokenPrefix: String,
        label: String,
        platform: String,
        addedAt: Int64,
        lastSeenAt: Int64,
        quarantineUntil: Int64? = nil
    ) {
        self.tokenId = tokenId; self.tokenPrefix = tokenPrefix
        self.label = label; self.platform = platform
        self.addedAt = addedAt; self.lastSeenAt = lastSeenAt
        self.quarantineUntil = quarantineUntil
    }
}

/// v1.2 Phase 4 — GET /api/users/:u response shape. The Worker
/// returns the canonical claimedAt + accountType + totpEnrolledAt
/// columns; nothing else security-sensitive is echoed. Used by the
/// Settings → Account security screen to render the account-type
/// badge ("Single-device" vs "Multi-device + 2FA") without a
/// separate roundtrip.
public struct UsernameLookupResponse: Codable, Equatable, Sendable {
    public let username: String
    public let irkPub: String
    public let claimedAt: Int64
    /// "single" or "multi". Pre-migration rows default to "single".
    public let accountType: String
    /// Wall-clock ms of the successful TOTP enroll-confirm, or nil.
    public let totpEnrolledAt: Int64?

    public init(
        username: String,
        irkPub: String,
        claimedAt: Int64,
        accountType: String,
        totpEnrolledAt: Int64?
    ) {
        self.username = username
        self.irkPub = irkPub
        self.claimedAt = claimedAt
        self.accountType = accountType
        self.totpEnrolledAt = totpEnrolledAt
    }
}

/// v1.2 Phase 3 — POST /api/users/:u/totp/enroll-begin. The signed
/// body's canonical-bytes spec lives in @flagship/protocol
/// `TAG_TOTP_ENROLL_BEGIN`. The Worker rejects unless the IRK
/// signature matches the row's stored irkPubHex AND the issuedAt
/// is within the 5-minute freshness window.
public struct TotpEnrollBeginRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let issuedAt: Int64
        public init(username: String, issuedAt: Int64) {
            self.username = username; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String  // hex Ed25519 by the user's IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

public struct TotpEnrollBeginResponse: Decodable, Equatable, Sendable {
    /// Base32 secret the user can paste into an authenticator app
    /// that doesn't support QR scanning.
    public let secret: String
    /// Full otpauth:// URL — used for "Copy link" affordances and as
    /// the source of the QR rendering.
    public let otpauthUrl: String
    /// PNG-encoded QR code, base64-encoded WITHOUT a data-URL prefix.
    /// SwiftUI clients prepend `data:image/png;base64,` before
    /// feeding it into an Image view (see AccountSecurityEnableSheet).
    public let qrPngBase64: String
    /// "Flagship" — surfaced as the authenticator app's issuer label.
    public let issuer: String
}

/// v1.2 Phase 3 — POST /api/users/:u/totp/enroll-confirm. Canonical
/// bytes match `TAG_TOTP_ENROLL_CONFIRM`. The 6-digit `code` is
/// validated against the staged secret synchronously beside the
/// signature check; the code is NOT in the canonical bytes (codes
/// are ephemeral, see RePairInitiate.totpProof for the same
/// rationale).
public struct TotpEnrollConfirmRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let issuedAt: Int64
        public init(username: String, issuedAt: Int64) {
            self.username = username; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String  // hex
    public let code: String       // 6-digit TOTP sample
    public init(request: Inner, signature: String, code: String) {
        self.request = request; self.signature = signature; self.code = code
    }
}

public struct TotpEnrollConfirmResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    /// Always "multi" on success.
    public let accountType: String
    public let totpEnrolledAt: Int64
    /// 10 plaintext recovery codes. This is the ONE time they leave
    /// the Worker — losing this response means the user has to
    /// re-enroll. The UI MUST gate dismissal of the codes screen
    /// behind an explicit "I've saved these" confirmation.
    public let recoveryCodes: [String]
}

/// v1.2 Phase 3 — POST /api/users/:u/totp/disable.
public struct TotpDisableRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let issuedAt: Int64
        public init(username: String, issuedAt: Int64) {
            self.username = username; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String
    /// Live 6-digit TOTP OR a 10-char recovery code. Same dual-mode
    /// shape as RePairInitiate.totpProof.
    public let code: String
    public init(request: Inner, signature: String, code: String) {
        self.request = request; self.signature = signature; self.code = code
    }
}

public struct TotpDisableResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    /// Always "single" on success.
    public let accountType: String
}

/// Response wrapper that surfaces the ETag header alongside the body.
/// Callers feed the ETag to subsequent /re-pair / Disconnect requests
/// as If-Match to fence against another device joining mid-revoke.
public struct TrustedDevicesListResponse: Equatable, Sendable {
    public let devices: [TrustedDevice]
    /// Server-supplied ETag for the snapshot (form `W/"hex"`). Nil
    /// only when the Mock impl didn't compute one.
    public let etag: String?

    public init(devices: [TrustedDevice], etag: String?) {
        self.devices = devices; self.etag = etag
    }
}

/// On-wire body shape — separate from TrustedDevicesListResponse so
/// the ETag (header, not body) doesn't leak into Codable.
private struct TrustedDevicesWireBody: Codable {
    let devices: [TrustedDevice]
}

/// On-wire body for GET /api/users/:u/re-pair — the Worker wraps the
/// row (or null) under `pending`. Kept private so the public surface is
/// the flattened `PendingRePairSnapshot`.
private struct PendingRePairWireBody: Decodable {
    let pending: PendingRePairInfo?
}

/// Worker-side install-event row. The daemon (and the Alpine
/// installer scripts) POST these as `{ event, detail }`; the Worker
/// assigns a `seq` and `postedAt` and lists them back.
public struct InstallEventRecord: Codable, Equatable, Sendable {
    public let seq: Int
    public let eventName: String       // "registered" | "boot" | "tunnel-online" | "cert-issued" | "ready" | "failed" …
    public let detail: String          // for "ready" carries serverFqdn; for "failed" carries the reason
    public let postedAt: Int64

    public init(seq: Int, eventName: String, detail: String, postedAt: Int64) {
        self.seq = seq; self.eventName = eventName
        self.detail = detail; self.postedAt = postedAt
    }
}

public struct InstallEventsPollResponse: Codable, Equatable, Sendable {
    public let serial: String
    public let events: [InstallEventRecord]
    public let cursor: Int

    public init(serial: String, events: [InstallEventRecord], cursor: Int) {
        self.serial = serial; self.events = events; self.cursor = cursor
    }
}

// MARK: - Provisioning status (per-order install timeline)

/// One ordered step of the provisioning timeline. Mirrors
/// `PROVISION_STATUS_PHASES` in
/// packages/control-plane/src/provisionStatus.ts. The string raw value
/// IS the wire phase the box reports; `.unknown` is the forward-compat
/// fallback for a phase a newer Worker introduces that this binary
/// doesn't yet know about (it is decoded but never appears in the
/// canonical `ordered` ladder so the timeline still renders cleanly).
public enum ProvisionStatusPhase: String, Codable, Equatable, Sendable, CaseIterable {
    case booting
    case partitioning
    case installing
    /// The flagship bootstrap (git clone + apt + nodejs) — the post-install
    /// software fetch. The base OS is already on the USB, so this follows
    /// `installing` on the wire.
    case downloading
    case registering
    case sealing
    /// The install finished + the box has registered + sealed: it powered off
    /// awaiting the user to unplug the USB + power back on. ACTION-NEEDED, the
    /// final pre-poweroff checkpoint — sorts AFTER sealing (`live` is success).
    case installed
    case pairing
    case live
    case error
    /// Forward-compat sentinel for an unrecognised wire phase. Never
    /// part of `ordered`.
    case unknown

    /// The happy-path ladder, in order, EXCLUDING the terminal `error`
    /// (and the `unknown` sentinel). The timeline renders one row per
    /// entry here; `live` is the terminal success state. `installed`
    /// sits between `sealing` and `pairing` — the final pre-poweroff
    /// action-needed rung, not a done state.
    public static let ordered: [ProvisionStatusPhase] = [
        .booting, .partitioning, .installing, .downloading,
        .registering, .sealing, .installed, .pairing, .live,
    ]

    /// Human, on-brand title for each step. THE single source of phase
    /// titles for every iOS/watch/widget/push surface — byte-identical
    /// to `PHASE_TITLES` in packages/control-plane/src/provisionStatus.ts
    /// so the in-app copy matches the push banner the user just tapped.
    public var title: String {
        switch self {
        case .booting:      return "Booting up"
        case .downloading:  return "Downloading"
        case .partitioning: return "Partitioning disk"
        case .installing:   return "Installing"
        case .installed:    return "Install complete — unplug the USB"
        case .registering:  return "Registering with Flagship"
        case .sealing:      return "Sealing your disk key"
        case .pairing:      return "Pairing with your phone"
        case .live:         return "Your server is live"
        case .error:        return "Setup hit a problem"
        case .unknown:      return "Working…"
        }
    }

    /// Longer body copy per phase — byte-identical to `PHASE_BODIES` in
    /// provisionStatus.ts (the push body source). The error body is
    /// "Setup failed: <detail>" when a detail is present; consumers
    /// compose that themselves.
    public var body: String {
        switch self {
        case .booting:      return "Your server has booted and started setting itself up."
        case .downloading:  return "Downloading the server software."
        case .partitioning: return "Preparing the disk."
        case .installing:   return "Installing the server software."
        case .installed:    return "Unplug the USB stick, then power the box back on."
        case .registering:  return "Your server is checking in with Flagship."
        case .sealing:      return "Sealing your encrypted disk key."
        case .pairing:      return "Your server is pairing with your phone."
        case .live:         return "Your server is live and ready to use."
        case .error:        return "Setup ran into a problem."
        case .unknown:      return ""
        }
    }

    /// The canonical UI group this phase rolls up into. Mirrors the
    /// contract projection table (design §1.2) — every iOS/Android/
    /// webapp grouped ladder derives the SAME grouping from this:
    ///   Booting     ← booting, partitioning
    ///   Installing  ← installing, downloading
    ///   Registering ← registering, pairing
    ///   Securing    ← sealing
    ///   Installed   ← installed  (ACTION-NEEDED: unplug the USB)
    ///   Ready       ← live
    /// (`error` fails the currently-active group; it has no group of its
    /// own and is handled separately by the renderer.)
    public enum Group: String, Sendable, Equatable, CaseIterable {
        case booting, installing, registering, securing, installed, ready

        public var label: String {
            switch self {
            case .booting:      return "Booting"
            case .installing:   return "Installing"
            case .registering:  return "Registering"
            case .securing:     return "Securing"
            case .installed:    return "Install complete — unplug the USB"
            case .ready:        return "Ready"
            }
        }
    }

    /// Maps a ladder phase onto its canonical UI group. `error`/`unknown`
    /// have no own group → nil (the renderer fails the active group).
    public var group: Group? {
        switch self {
        case .booting, .partitioning:               return .booting
        case .installing, .downloading:             return .installing
        case .registering, .pairing:                return .registering
        case .sealing:                              return .securing
        case .installed:                            return .installed
        case .live:                                 return .ready
        case .error, .unknown:                      return nil
        }
    }

    /// Forward-compatible decode: an unrecognised wire string decodes to
    /// `.unknown` rather than throwing so an older client doesn't crash
    /// on a newer Worker.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProvisionStatusPhase(rawValue: raw) ?? .unknown
    }

    /// Terminal phases stop the poller (success or failure).
    public var isTerminal: Bool { self == .live || self == .error }
}

/// One entry in a provision-status row's append-only history. Mirrors
/// `ProvisionStatusHistoryEntry` in packages/storage/src/types.ts
/// EXACTLY: `{ phase, detail?, ts }`.
public struct ProvisionStatusEntry: Codable, Equatable, Sendable, Identifiable {
    public let phase: ProvisionStatusPhase
    public let detail: String?
    /// Wall-clock ms of the report.
    public let ts: Int64

    /// Stable id for SwiftUI lists — phase + timestamp uniquely
    /// identifies a checkpoint (the box never posts two of the same
    /// phase at the same ms).
    public var id: String { "\(phase.rawValue)-\(ts)" }

    public init(phase: ProvisionStatusPhase, detail: String? = nil, ts: Int64) {
        self.phase = phase
        self.detail = detail
        self.ts = ts
    }
}

/// GET /api/order/<serial>/status response. Mirrors
/// `ProvisionStatusRecord` in packages/storage/src/types.ts EXACTLY:
/// `{ serial, serverDomain?, phase, detail?, updatedAt, history[] }`.
/// A 404 ("no status") is surfaced as `nil` by the client, not this
/// type — there is no separate "absent" sentinel.
public struct ProvisionStatus: Codable, Equatable, Sendable {
    public let serial: String
    /// The server FQDN once the box has registered it; nil before then.
    public let serverDomain: String?
    /// The latest reported phase.
    public let phase: ProvisionStatusPhase
    /// Free-form latest detail (error text, percentage, etc.).
    public let detail: String?
    /// Wall-clock ms of the latest report.
    public let updatedAt: Int64
    /// Append-only history of every phase report, oldest first.
    public let history: [ProvisionStatusEntry]

    public init(
        serial: String,
        serverDomain: String? = nil,
        phase: ProvisionStatusPhase,
        detail: String? = nil,
        updatedAt: Int64,
        history: [ProvisionStatusEntry]
    ) {
        self.serial = serial
        self.serverDomain = serverDomain
        self.phase = phase
        self.detail = detail
        self.updatedAt = updatedAt
        self.history = history
    }
}

/// POST /api/push/register — IRK-signed registration of an APNs (or FCM,
/// or webpush) provider token + a per-device X25519 pubkey. Canonical
/// bytes spec lives in packages/protocol/src/auth.ts
/// `TAG_PUSH_TOKEN_REGISTER`; iOS computes the same string via
/// `PushTokenRegister.canonicalBytes(...)` in Flagship/InstallBlob.swift.
public struct PushTokenRegisterRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let platform: String            // "apns" | "fcm" | "webpush"
        public let providerToken: String       // APNs hex token (lowercased)
        public let pushX25519Pub: String       // hex
        /// User-facing device label (e.g. "Harry's iPhone"). Surfaced
        /// in the Trusted-devices list on .com. Must be part of the
        /// canonical bytes the IRK signs — the field slots between
        /// pushX25519Pub and issuedAt to match the Worker side.
        public let label: String
        public let issuedAt: Int64
        public init(
            username: String, platform: String, providerToken: String,
            pushX25519Pub: String, label: String, issuedAt: Int64
        ) {
            self.username = username; self.platform = platform
            self.providerToken = providerToken
            self.pushX25519Pub = pushX25519Pub
            self.label = label
            self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String               // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

public struct PushTokenRegisterResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let tokenId: String
    public init(ok: Bool, tokenId: String) { self.ok = ok; self.tokenId = tokenId }
}

/// `{ request, signature }` body for `DELETE /api/push/<token-id>`. Revoke
/// is IRK-signed (SEC): `.com` resolves the token owner from the stored row
/// and verifies this signature over `flagship/push-token-revoke/v1` before
/// deleting the tether. The `tokenId` here MUST equal the URL segment.
/// Mirrors the Worker's `RevokeBody` in packages/control-plane/src/push.ts.
public struct PushTokenRevokeRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let tokenId: String
        public let issuedAt: Int64
        public init(tokenId: String, issuedAt: Int64) {
            self.tokenId = tokenId; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String               // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// Phase 3b — POST /api/users/<account>/devices/admit body. Carries the
/// admin-signed `DeviceAdmit` envelope + the incoming device's own
/// push-token registration. The Worker verifies `admitSig` under the
/// account's CURRENT IRK; the registration `signature` is carried for
/// storage but NOT verified (the incoming device holds no account IRK —
/// the admit is the IRK consent). Field names mirror the Worker's
/// `AdmitBody` exactly. See handleVouchedDeviceAdmit in
/// packages/control-plane/src/push.ts.
public struct DeviceAdmitRequest: Codable, Equatable, Sendable {
    public struct Admit: Codable, Equatable, Sendable {
        public let username: String
        public let newDevicePubHex: String   // lowercased hex, 32 bytes
        public let issuedAt: Int64
        public init(username: String, newDevicePubHex: String, issuedAt: Int64) {
            self.username = username
            self.newDevicePubHex = newDevicePubHex
            self.issuedAt = issuedAt
        }
    }
    public let admit: Admit
    public let admitSig: String                    // hex; Ed25519 by account IRK
    public let request: PushTokenRegisterRequest.Inner
    public let signature: String                   // hex; carried, not verified
    public init(
        admit: Admit,
        admitSig: String,
        request: PushTokenRegisterRequest.Inner,
        signature: String
    ) {
        self.admit = admit
        self.admitSig = admitSig
        self.request = request
        self.signature = signature
    }
}

/// Phase 3b — devices/admit success body. `quarantineUntil` is the
/// wall-clock ms (now + 14d) before which the freshly-admitted device
/// can't revoke others / reach `ukey.*`; the incoming UI renders the
/// countdown from it.
public struct DeviceAdmitResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let tokenId: String
    public let quarantineUntil: Int64?
    public init(ok: Bool, tokenId: String, quarantineUntil: Int64?) {
        self.ok = ok
        self.tokenId = tokenId
        self.quarantineUntil = quarantineUntil
    }
}

// MARK: - Watch delegate keys (wire types)

/// POST /api/users/:u/watch-delegates body. `grant` mirrors the cloud's
/// `WatchDelegateKey` (the field names match the Worker's MintBody.grant) and
/// `signature` is the IRK Ed25519 signature over its canonical bytes.
public struct WatchDelegateMintRequest: Codable, Equatable, Sendable {
    public struct Grant: Codable, Equatable, Sendable {
        public let grantId: String
        public let username: String
        /// lowercased hex, 32 bytes.
        public let delegatePubKey: String
        public let scopes: [String]
        public let issuedAt: Int64
        public let expiresAt: Int64
        public init(grantId: String, username: String, delegatePubKey: String, scopes: [String], issuedAt: Int64, expiresAt: Int64) {
            self.grantId = grantId
            self.username = username
            self.delegatePubKey = delegatePubKey
            self.scopes = scopes
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
        }
    }
    public let grant: Grant
    /// hex; Ed25519 by account IRK over the grant's canonical bytes.
    public let signature: String
    public init(grant: Grant, signature: String) {
        self.grant = grant
        self.signature = signature
    }
}

/// POST /api/users/:u/watch-delegates success body.
public struct WatchDelegateMintResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let grantId: String
    public let expiresAt: Int64
    /// Present when the mint replaced a prior active delegate (one-per-user).
    public let replacedGrantId: String?
    public init(ok: Bool, grantId: String, expiresAt: Int64, replacedGrantId: String?) {
        self.ok = ok
        self.grantId = grantId
        self.expiresAt = expiresAt
        self.replacedGrantId = replacedGrantId
    }
}

/// One active delegate as returned by GET /api/users/:u/watch-delegates.
public struct WatchDelegateInfo: Codable, Equatable, Sendable, Identifiable {
    public let grantId: String
    public let delegatePubKey: String
    public let scopes: [String]
    public let issuedAt: Int64
    public let expiresAt: Int64
    public var id: String { grantId }
    public init(grantId: String, delegatePubKey: String, scopes: [String], issuedAt: Int64, expiresAt: Int64) {
        self.grantId = grantId
        self.delegatePubKey = delegatePubKey
        self.scopes = scopes
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }
}

/// GET /api/users/:u/watch-delegates body. The cloud lists only delegates
/// that are un-revoked AND still verify under the account's current IRK.
public struct WatchDelegatesListResponse: Codable, Equatable, Sendable {
    public let username: String
    public let delegates: [WatchDelegateInfo]
    public init(username: String, delegates: [WatchDelegateInfo]) {
        self.username = username
        self.delegates = delegates
    }
}

/// POST /api/users/:u/watch-delegates/revoke body.
public struct WatchDelegateRevokeRequest: Codable, Equatable, Sendable {
    public struct Request: Codable, Equatable, Sendable {
        public let grantId: String
        public let username: String
        public let issuedAt: Int64
        public init(grantId: String, username: String, issuedAt: Int64) {
            self.grantId = grantId
            self.username = username
            self.issuedAt = issuedAt
        }
    }
    public let request: Request
    /// hex; Ed25519 by account IRK over the revoke envelope's canonical bytes.
    public let signature: String
    public init(request: Request, signature: String) {
        self.request = request
        self.signature = signature
    }
}

/// POST /api/auth-code/<serial>/revoke — IRK-signed revocation. The
/// phone fires this when the user taps Cancel order on a pending pod.
/// Mirrors the canonical-bytes tag `flagship/auth-code-revoke/v1` +
/// the existing handler in packages/control-plane/src/authCode.ts.
public struct AuthCodeRevokeRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let serial: String
        public let username: String
        public let issuedAt: Int64
        public init(serial: String, username: String, issuedAt: Int64) {
            self.serial = serial; self.username = username; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// POST /api/server/release — IRK-signed release of a reserved server
/// name. The phone fires this when the user cancels a pending/abandoned
/// server. Mirrors the canonical-bytes tag
/// `flagship/release-server-name/v1` (`tag|username|serverDomain|issuedAt`)
/// + the @flagship/protocol `ReleaseServerName` shape. Authorization is
/// the IRK signature itself — only the account owner can produce it.
public struct ReleaseServerNameRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let serverDomain: String
        public let issuedAt: Int64
        public init(username: String, serverDomain: String, issuedAt: Int64) {
            self.username = username; self.serverDomain = serverDomain; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// #43 — POST /api/users/:u/outstanding-orders. IRK-signed envelope
/// listing the account's in-flight install orders. Canonical bytes =
/// `flagship/outstanding-orders/v1|username|issuedAt` (see
/// FlagshipCore.OutstandingOrders.canonicalBytes), matching the .com
/// handler. A read, but POST-with-signed-body is the IRK-auth shape.
public struct OutstandingOrdersRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let issuedAt: Int64
        public init(username: String, issuedAt: Int64) {
            self.username = username; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// One in-flight install order. `fqdn` is the predicted
/// `<serverName>.<username>.flagship.services` (identical whether or not
/// the box has registered). `phase` is the latest reported provisioning
/// phase, or nil if none reported yet.
public struct OutstandingOrder: Codable, Equatable, Sendable, Identifiable {
    public let serial: String
    public let serverName: String
    public let fqdn: String
    public let phase: ProvisionStatusPhase?
    public let createdAt: Int64
    public var id: String { serial }
    public init(serial: String, serverName: String, fqdn: String, phase: ProvisionStatusPhase?, createdAt: Int64) {
        self.serial = serial; self.serverName = serverName
        self.fqdn = fqdn; self.phase = phase; self.createdAt = createdAt
    }
}

public struct OutstandingOrdersResponse: Codable, Equatable, Sendable {
    public let username: String
    public let orders: [OutstandingOrder]
    public init(username: String, orders: [OutstandingOrder]) {
        self.username = username; self.orders = orders
    }
}

/// P13 — POST /api/server-registry/revoke. IRK-signed envelope that
/// declares a server DEAD (kill switch). The box will refuse to boot
/// on its next reboot — irreversible. Mirrors the canonical-bytes
/// tag `flagship/revoke/v1` (`tag|userId|revokedServerId|reason|issuedAt`)
/// + the @flagship/protocol `ServerRevocation` shape.
public struct ServerRevocationRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let userId: String
        public let revokedServerId: String
        /// One of {"lost", "stolen", "decommissioned"}.
        public let reason: String
        public let issuedAt: Int64
        public init(userId: String, revokedServerId: String, reason: String, issuedAt: Int64) {
            self.userId = userId; self.revokedServerId = revokedServerId
            self.reason = reason; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

// MARK: - Wire types

/// POST /api/username/claim — idempotent. The Worker checks the IRK
/// signature and persists the binding {username → irkPub}. A 409 means
/// the same IRK already owns this username (still success on retry).
public struct UsernameClaimRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let irkPub: String       // hex
        public let issuedAt: Int64
        public init(username: String, irkPub: String, issuedAt: Int64) {
            self.username = username; self.irkPub = irkPub; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String        // hex, IRK over canonical bytes
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// POST /api/auth-code/issue — registers a serial-keyed AuthCode that
/// authorizes the freshly-booted server to register itself.
public struct AuthCodeIssueRequest: Codable, Equatable, Sendable {
    public let code: AuthCodeWire
    public let signature: String        // hex, IRK over canonical bytes
    public init(code: AuthCodeWire, signature: String) {
        self.code = code; self.signature = signature
    }
}

public struct AuthCodeWire: Codable, Equatable, Sendable {
    public let version: Int
    public let serial: String
    public let username: String
    public let serverName: String
    public let serverDomain: String
    public let delegatedPubKey: String   // hex
    public let userPubKey: String        // hex (the IRK's public key)
    public let issuedAt: Int64
    public let expiresAt: Int64
    public init(
        version: Int, serial: String, username: String, serverName: String,
        serverDomain: String, delegatedPubKey: String, userPubKey: String,
        issuedAt: Int64, expiresAt: Int64
    ) {
        self.version = version; self.serial = serial; self.username = username
        self.serverName = serverName; self.serverDomain = serverDomain
        self.delegatedPubKey = delegatedPubKey; self.userPubKey = userPubKey
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}

/// POST /api/routing/register-rck — binds an Ed25519 routing-control
/// key to the server's subdomain.
public struct RckRegisterRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let subdomain: String
        public let rckPubKey: String     // hex
        public let issuedAt: Int64
        public init(username: String, subdomain: String, rckPubKey: String, issuedAt: Int64) {
            self.username = username; self.subdomain = subdomain
            self.rckPubKey = rckPubKey; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

public struct UsernameAvailabilityResponse: Codable, Equatable, Sendable {
    public let username: String
    public let available: Bool
    public let reason: String?
    /// When non-nil, the typed username matched a Worker-side test
    /// account (env.TEST_ACCOUNTS). iOS branches on this BEFORE
    /// looking at `available` — a test-account hit returns
    /// available=false to keep accidental claims impossible, while
    /// this field tells the client to enter the sandbox demo flow.
    public let testAccount: TestAccountMeta?
    /// Plan A — present when the typed username matches a `demo_users`
    /// row on the Worker. Drives the new "one real device" rendering
    /// in DemoFixtures + the on-connect-provisioning flow. Absent ⇒
    /// legacy (testAccount-only) behaviour preserved. See
    /// docs/sample-users.md §10.9.
    public let demoServer: DemoServerBlock?
    /// v2 device-addressing — present when the typed username matched
    /// the `<u>.<device-label>` syntax AND a matching active grant
    /// exists in `device_capability_grants` on the Worker. The mobile
    /// client treats this as a strong declaration of "you are a
    /// restricted device under this user" and greys out actions
    /// absent from `scopes`. See
    /// docs/v2-device-addressing-and-real-ticket.md §5.1.
    public let deviceCapability: DeviceCapabilityBlock?
    public init(
        username: String,
        available: Bool,
        reason: String?,
        testAccount: TestAccountMeta? = nil,
        demoServer: DemoServerBlock? = nil,
        deviceCapability: DeviceCapabilityBlock? = nil
    ) {
        self.username = username; self.available = available; self.reason = reason
        self.testAccount = testAccount
        self.demoServer = demoServer
        self.deviceCapability = deviceCapability
    }
}

public struct TestAccountMeta: Codable, Equatable, Sendable {
    public let display: String
    public let ttlHours: Int
    public init(display: String, ttlHours: Int = 24) {
        self.display = display; self.ttlHours = ttlHours
    }
}

/// Plan A — embedded into the /api/users/check response when a typed
/// username matches a `demo_users` row on the Worker. Mirrors the
/// shape produced by `demoServerBlockFromRow` in
/// packages/control-plane/src/demoUsers.ts. See
/// docs/sample-users.md §10.9.
public struct DemoServerBlock: Codable, Equatable, Hashable, Sendable {
    /// e.g. `home.demoalice.flagship.services`. The single device the
    /// new demo-mode renders.
    public let fqdn: String
    /// Server-lifecycle state surfaced to clients. The Worker collapses
    /// the internal four-state machine into three public statuses (see
    /// docs/sample-users.md §10.9 mapping table):
    ///   "none"         — no Hetzner VPS yet; tap connect to provision.
    ///   "provisioning" — POST /connect issued; client should poll.
    ///   "up"           — VPS booted and registered; safe to open.
    public let status: String
    /// Operator-set idle-teardown horizon in minutes. UIs can surface
    /// this in a tooltip; the cron lives on the Worker.
    public let ttlIdleMinutes: Int
    /// Fine-grained provisioning observability — the latest named PHASE
    /// checkpoint the box pushed (one of `@flagship/protocol`
    /// PROVISION_PHASES), or nil when no checkpoint has arrived yet.
    /// The coarse `status` is the three-state lifecycle; `phase` is the
    /// step WITHIN provisioning so the install-progress UI can render a
    /// real list instead of a spinner. Mirror of
    /// packages/control-plane/src/demoUsers.ts `DemoServerBlock.phase`.
    public let phase: String?
    /// Wall-clock ms the latest phase landed; nil when `phase` is nil.
    public let phaseAt: Double?
    /// Failure detail, present only when `phase == "failed"`.
    public let lastError: String?
    /// Device-identifying metadata (migration 0036) so the user can
    /// confirm the box they're watching is theirs. Each is nil when the
    /// provider hasn't returned it / pre-0036 row. Mirror of the Worker's
    /// `DemoServerBlock` ip/region/serverType/image fields.
    public let ip: String?
    public let region: String?
    public let serverType: String?
    public let image: String?
    public init(
        fqdn: String,
        status: String,
        ttlIdleMinutes: Int = 30,
        phase: String? = nil,
        phaseAt: Double? = nil,
        lastError: String? = nil,
        ip: String? = nil,
        region: String? = nil,
        serverType: String? = nil,
        image: String? = nil
    ) {
        self.fqdn = fqdn
        self.status = status
        self.ttlIdleMinutes = ttlIdleMinutes
        self.phase = phase
        self.phaseAt = phaseAt
        self.lastError = lastError
        self.ip = ip
        self.region = region
        self.serverType = serverType
        self.image = image
    }

    /// Typed convenience over the raw string. Forward-compatible: an
    /// unknown future value parses as `.provisioning` so a client that
    /// hasn't been updated still polls instead of opening an unhealthy
    /// pod.
    public var lifecycle: Lifecycle {
        switch status {
        case "up":   return .up
        case "none": return .none
        default:     return .provisioning
        }
    }

    public enum Lifecycle: String, Sendable, Equatable, Hashable {
        case none, provisioning, up
    }
}

/// v2 device-addressing — mirror of the Worker's `deviceCapability`
/// block in `packages/control-plane/src/usersCheck.ts`. Embedded into
/// the `/api/users/check` response when the typed username matched
/// the `<u>.<device-label>` syntax AND a matching active
/// DeviceCapabilityGrant exists. See
/// docs/v2-device-addressing-and-real-ticket.md §2 + §5.1.
public struct DeviceCapabilityBlock: Codable, Equatable, Sendable {
    /// Human-meaningful label the user typed after the dot
    /// ("reviewer", "ipad", "work-laptop"). RFC-1035-ish (a-z, 0-9,
    /// hyphen; not at start/end; ≤24 chars). Used in the chip below
    /// the username.
    public let label: String
    /// Device's Ed25519 pubkey, 32 bytes hex. Identifies the device
    /// across re-issuance. Not displayed in the UI; the client uses
    /// it when signing requests on behalf of this device.
    public let devicePubKey: String
    /// Authorized scopes for this device. The Worker may return ANY
    /// subset of `DeviceScope`; the UI greys out actions absent from
    /// this set. Unknown future scope strings are parsed as nil and
    /// silently dropped so an older client doesn't crash on a newer
    /// Worker.
    public let scopes: [DeviceScope]
    /// Grant identifier (v4 UUID). Audit / debugging only.
    public let grantId: String
    /// ms since epoch. The client SHOULD treat the block as expired
    /// after this and prompt re-enrollment.
    public let expiresAt: Int64
    /// Owner-IRK Ed25519 signature over the canonical bytes of the
    /// underlying DeviceCapabilityGrant. 64 bytes hex. Verification
    /// happens at the daemon layer; surfaced here for forward-compat
    /// and parity with the Worker wire shape.
    public let signature: String

    public init(
        label: String,
        devicePubKey: String,
        scopes: [DeviceScope],
        grantId: String,
        expiresAt: Int64,
        signature: String
    ) {
        self.label = label
        self.devicePubKey = devicePubKey
        self.scopes = scopes
        self.grantId = grantId
        self.expiresAt = expiresAt
        self.signature = signature
    }

    /// Forward-compat decoder: unknown scope strings (a newer Worker
    /// emitting a scope this binary doesn't know about) are silently
    /// dropped so the client falls open to whatever it CAN parse. The
    /// daemon does the authoritative enforcement; this UI-layer parse
    /// is best-effort for rendering.
    private enum CodingKeys: String, CodingKey {
        case label, devicePubKey, scopes, grantId, expiresAt, signature
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.label = try c.decode(String.self, forKey: .label)
        self.devicePubKey = try c.decode(String.self, forKey: .devicePubKey)
        self.grantId = try c.decode(String.self, forKey: .grantId)
        self.expiresAt = try c.decode(Int64.self, forKey: .expiresAt)
        self.signature = try c.decode(String.self, forKey: .signature)
        let rawScopes = try c.decode([String].self, forKey: .scopes)
        self.scopes = rawScopes.compactMap(DeviceScope.init(rawValue:))
    }

    /// Convenience: scopes as a Set for membership checks. Stable
    /// across decode order; UI rendering callsites use this.
    public var scopeSet: Set<DeviceScope> { Set(scopes) }

    /// True iff this device's scopes cover the full DeviceScope set
    /// — i.e. the device is a primary device with no restrictions.
    /// The chip + button-disable surfaces hide when this is true.
    public var isFullyScoped: Bool {
        DeviceScope.allCases.allSatisfy(scopes.contains)
    }
}

/// v2 device-addressing — scopes mirror the Worker wire strings in
/// `packages/protocol/src/auth.ts` (`DEVICE_SCOPES`). Order MUST
/// match the canonical sort order so a future audit-trail render
/// stays stable. Unknown future values decode to nil and are dropped
/// (forward-compat).
public enum DeviceScope: String, Codable, Equatable, Sendable, CaseIterable {
    case browse = "browse"
    case installService = "install-service"
    case vibeCode = "vibe-code"
    case addDevice = "add-device"
    case manageServices = "manage-services"
    case revokeOthers = "revoke-others"
    case demoProvision = "demo-provision"

    /// Decoder that tolerates unknown future strings: an unrecognised
    /// scope returns nil so `Array<DeviceScope?>.compactMap` drops it.
    /// Used by the array decoder via a wrapper.
    public init?(wire: String) {
        self.init(rawValue: wire)
    }
}

/// Login/join preflight result. Mirrors the Worker's `AccountResolution`
/// in packages/control-plane/src/accountResolve.ts EXACTLY (the
/// iOS-Mock-matches-Worker-wire invariant). Returned by
/// `GET /api/account/resolve/<username>`, which is **200 always** —
/// every "absent" is a field, never an HTTP status. The client login
/// state machine branches on `kind`:
///   - "demo"    → skip all credentials; attach a new device + open the
///                 sandbox via DemoFixtures.activate(demoServer:).
///   - "unknown" → render "No Flagship account by that name" (not a 404).
///   - "single" / "multi" → real-account recovery branches (Phase 3).
public struct AccountResolution: Codable, Equatable, Hashable, Sendable {
    /// The recovery sub-block: whether a cloud-stored recovery envelope
    /// exists for the account, whether fetching it is gated behind a
    /// passphrase/fetch-token, and (when present) the credentialId.
    public struct Recovery: Codable, Equatable, Hashable, Sendable {
        public let present: Bool
        public let hasFetchGate: Bool
        public let credentialId: String?
        public init(present: Bool, hasFetchGate: Bool, credentialId: String? = nil) {
            self.present = present
            self.hasFetchGate = hasFetchGate
            self.credentialId = credentialId
        }
    }

    /// Forward-compatible decode of the account `kind`. An unknown
    /// future value parses to `.unknown` so an older client renders the
    /// "no account" state instead of crashing on a newer Worker.
    public enum Kind: String, Codable, Equatable, Hashable, Sendable {
        case demo
        case single
        case multi
        case unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    /// Server-derived recovery-speed hint so every client renders
    /// identical copy without re-deriving the account-type matrix.
    /// Unknown future values parse to `.none`.
    public enum GraceModel: String, Codable, Equatable, Hashable, Sendable {
        case instant
        case threeDay = "3d"
        case twentyFourHourTotp = "24h-totp"
        case none

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = GraceModel(rawValue: raw) ?? .none
        }
    }

    /// Normalized handle the lookup ran against.
    public let username: String
    public let exists: Bool
    public let kind: Kind
    public let recovery: Recovery
    public let totpEnrolled: Bool
    public let trustedDeviceCount: Int
    /// Present only for demo accounts. Same shape /api/users/check
    /// returns today.
    public let demoServer: DemoServerBlock?
    public let graceModel: GraceModel

    public init(
        username: String,
        exists: Bool,
        kind: Kind,
        recovery: Recovery,
        totpEnrolled: Bool,
        trustedDeviceCount: Int,
        demoServer: DemoServerBlock? = nil,
        graceModel: GraceModel
    ) {
        self.username = username
        self.exists = exists
        self.kind = kind
        self.recovery = recovery
        self.totpEnrolled = totpEnrolled
        self.trustedDeviceCount = trustedDeviceCount
        self.demoServer = demoServer
        self.graceModel = graceModel
    }

    /// The zeroed `kind:"unknown"` result the Worker returns for a
    /// non-existent (or label-invalid) name. Surfaced as a state, never
    /// an error. Matches the Worker's `unknown(username)` helper.
    public static func unknown(_ username: String) -> AccountResolution {
        AccountResolution(
            username: username,
            exists: false,
            kind: .unknown,
            recovery: Recovery(present: false, hasFetchGate: false),
            totpEnrolled: false,
            trustedDeviceCount: 0,
            demoServer: nil,
            graceModel: .none
        )
    }
}

/// POST /api/recovery — SIGNED cloud-recovery upload. Codable-encodes to
/// `{ request: { username, credentialId, wrappedUmk, issuedAt,
/// wrappedAcmeAccountKey? }, signature }`, the exact body
/// `handleUploadWebauthnRecovery` expects.
///
/// - `wrappedUmk` is a SINGLE self-contained base64 blob (nonce‖ct‖tag from
///   AES-GCM `.combined`). The Worker base64-decodes it and SHA-256s the
///   bytes; there is NO separate nonce field.
/// - `signature` is hex Ed25519 by the account IRK over the canonical
///   `flagship/upload-recovery-record/v1|<username>|<credentialId>|<wrappedUmkHashHex>|<issuedAt>`
///   (see Flagship/RecoveryUpload). The IRK signs the HASH of the
///   ciphertext, not the ciphertext, so the bytes stay small.
public struct RecoveryUploadRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let credentialId: String      // hex (8..256 bytes)
        public let wrappedUmk: String        // base64 of nonce‖ct‖tag
        public let issuedAt: Int64           // ms epoch; 5-min freshness
        /// #28 — escrow-wrapped ACME account key (base64 of nonce‖ct‖tag),
        /// shipped INSIDE `request` so the Worker reads `r.wrappedAcmeAccountKey`.
        /// Optional: absent for accounts that never minted an account key.
        /// Not in the signed canonical bytes — it's opaque ciphertext, so
        /// tampering breaks account-key recovery, never forges it.
        public let wrappedAcmeAccountKey: String?
        /// Task #74 — SHA-256 hex (64 chars) of the passphrase-derived
        /// `fetchToken`. The Worker stores it and later compares it to
        /// `SHA-256(presented fetchToken)` to gate the wrapped-UMK fetch.
        /// Optional on the wire (accept-if-present server-side) so the
        /// signed canonical-bytes type stays stable — the IRK signs only
        /// over the wrappedUmk hash — but the native enroll always sends it.
        public let fetchTokenHash: String?
        /// Task #74 — SHA-256 hex (64 chars) of the passphrase-derived
        /// `prfSalt`. Returned on the gated fetch so a recovering device
        /// can confirm it re-derives the same salt (anti-coercion). Same
        /// accept-if-present optionality as `fetchTokenHash`.
        public let prfSaltHash: String?
        public init(
            username: String,
            credentialId: String,
            wrappedUmk: String,
            issuedAt: Int64,
            wrappedAcmeAccountKey: String? = nil,
            fetchTokenHash: String? = nil,
            prfSaltHash: String? = nil
        ) {
            self.username = username
            self.credentialId = credentialId
            self.wrappedUmk = wrappedUmk
            self.issuedAt = issuedAt
            self.wrappedAcmeAccountKey = wrappedAcmeAccountKey
            self.fetchTokenHash = fetchTokenHash
            self.prfSaltHash = prfSaltHash
        }
    }
    public let request: Inner
    public let signature: String             // hex Ed25519 by the account IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

public struct RecoveryEnvelopeResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    /// Whether the upsert replaced an existing record. The Worker returns
    /// `{ ok, updated }`; absent on the Mock's synthetic success.
    public let updated: Bool?
    public init(ok: Bool, updated: Bool? = nil) { self.ok = ok; self.updated = updated }
}

/// Recovery-envelope fetch response, aligned to the Worker's gated-fetch
/// body (`handleFetchWrappedUmkWithToken`): `{ username, credentialId,
/// wrappedUmk, wrappedAcmeAccountKey?, prfSaltHash?, updatedAt }`. The
/// ciphertext field is `wrappedUmk` (single self-contained blob); there is
/// no separate `nonceBase64`.
public struct RecoveryEnvelope: Codable, Equatable, Sendable {
    public let credentialId: String
    public let wrappedUmk: String
    /// #28 — the escrow-wrapped ACME account key the Worker releases on
    /// fetch. Absent when the account never minted an account key. A
    /// recovering device unwraps this with the same PRF secret and imports
    /// it via `Keystore.importAcmeAccountKey`.
    public let wrappedAcmeAccountKey: String?
    public init(
        credentialId: String,
        wrappedUmk: String,
        wrappedAcmeAccountKey: String? = nil
    ) {
        self.credentialId = credentialId
        self.wrappedUmk = wrappedUmk
        self.wrappedAcmeAccountKey = wrappedAcmeAccountKey
    }
}

/// Request body of the Task #74 gated fetch — `{ fetchToken: <hex>,
/// issuedAt: <ms> }`. `issuedAt` is checked for 5-min freshness by the
/// Worker (replay defense).
public struct RecoveryFetchTokenBody: Codable, Equatable, Sendable {
    public let fetchToken: String
    public let issuedAt: Int64
    public init(fetchToken: String, issuedAt: Int64) {
        self.fetchToken = fetchToken
        self.issuedAt = issuedAt
    }
}

/// Body of the Task #74 gated fetch (`POST /api/recovery/by-username/<u>/fetch`),
/// mirroring the Worker's `handleFetchWrappedUmkWithToken` response:
/// `{ username, credentialId, wrappedUmk, wrappedAcmeAccountKey?, prfSaltHash?, updatedAt }`.
///
/// `prfSaltHash` is the lowercase SHA-256 hex of the enroll-time `prfSalt`.
/// A recovering device MUST verify it equals `SHA-256(local prfSalt)` before
/// proceeding — a malicious `.com` returning a different salt would otherwise
/// coerce the wrong PRF output and surface only as an opaque AES-GCM tag
/// mismatch. `credentialId` is hex (the form `navigator.credentials.get`'s
/// `allowCredentials` needs after a hex→bytes decode).
public struct RecoveryFetchResponse: Codable, Equatable, Sendable {
    public let username: String
    public let credentialId: String
    public let wrappedUmk: String
    public let wrappedAcmeAccountKey: String?
    public let prfSaltHash: String?
    public let updatedAt: Int64?
    /// Recovery Phase B — the account's CURRENTLY registered IRK pubkey (hex).
    /// The recovered UMK deterministically yields the IRK it had at enrollment,
    /// so the client compares this against the recovered IRK: equal ⇒ the key
    /// never moved (instant pair); different ⇒ the key rotated and this device
    /// must re-pair with `oldIrkPub = registeredIrkPubHex` + the grace window.
    /// Absent on pre-Phase-B Workers.
    public let registeredIrkPubHex: String?
    public init(
        username: String,
        credentialId: String,
        wrappedUmk: String,
        wrappedAcmeAccountKey: String? = nil,
        prfSaltHash: String? = nil,
        updatedAt: Int64? = nil,
        registeredIrkPubHex: String? = nil
    ) {
        self.username = username
        self.credentialId = credentialId
        self.wrappedUmk = wrappedUmk
        self.wrappedAcmeAccountKey = wrappedAcmeAccountKey
        self.prfSaltHash = prfSaltHash
        self.updatedAt = updatedAt
        self.registeredIrkPubHex = registeredIrkPubHex
    }
}

// MARK: - Mock

public final class MockFlagshipServerClient: FlagshipServerClient, @unchecked Sendable {
    public var simulatedLatency: TimeInterval = 0.2
    public var shouldFail: Bool = false
    public var reservedUsernames: Set<String> = ["root", "admin", "flagship", "system", "support"]
    /// Mirror of the Worker's env.TEST_ACCOUNTS map. Set in tests to
    /// exercise the test-account branch; production talks to the real
    /// Worker which reads its own off-git secret.
    public var testAccounts: [String: TestAccountMeta] = [:]
    /// Plan A — mirror of the Worker's `demo_users` D1 table. When a
    /// typed username is present here, `usernameAvailable` embeds the
    /// corresponding `demoServer` block. Independent of `testAccounts`
    /// — a username may carry both (legacy reviewer compat) or just
    /// the new block (live demo only).
    public var demoServers: [String: DemoServerBlock] = [:]
    /// v2 device-addressing — mirror of the Worker's
    /// `device_capability_grants` D1 table. Keyed by the full
    /// `<u>.<label>` string the user types. When `usernameAvailable`
    /// is called with a key here AND the user-part has a `demoServers`
    /// row, the response carries the `deviceCapability` block + the
    /// `demoServer` block from the user-part row (the underlying
    /// demo server the device is observing). See
    /// docs/v2-device-addressing-and-real-ticket.md §5.1.
    public var deviceCapabilities: [String: DeviceCapabilityBlock] = [:]
    private var recoveryStore: [String: RecoveryEnvelope] = [:]
    /// Username-keyed mirror of the Worker's `webauthn_recovery` row,
    /// holding the Task #74 passphrase-gate hashes so the gated fetch can
    /// be exercised end-to-end (enroll → gated-fetch → unwrap) in tests.
    /// Lower-cased username → stored record.
    private struct MockRecoveryRow: Sendable {
        var credentialId: String
        var wrappedUmk: String
        var wrappedAcmeAccountKey: String?
        var fetchTokenHash: String?   // SHA-256 hex of the fetchToken
        var prfSaltHash: String?      // SHA-256 hex of the prfSalt
        var updatedAt: Int64
    }
    private var recoveryRowsByUser: [String: MockRecoveryRow] = [:]
    /// Test hook — when set, the gated fetch returns THIS `prfSaltHash`
    /// instead of the stored one, modelling a tampered/malicious `.com`.
    /// Exercises the recover-path anti-coercion check.
    public var tamperedPrfSaltHashOnFetch: String? = nil

    /// Tracks usernames that have been claimed so the mock can return
    /// 409 on a second different-IRK claim (idempotent under same IRK).
    public private(set) var claimedUsernames: [String: String] = [:]   // username → irkPub
    public private(set) var issuedAuthCodes: [String: AuthCodeWire] = [:]   // serial → wire
    public private(set) var revokedAuthCodes: Set<String> = []        // serial set
    public private(set) var releasedServerNames: [ReleaseServerNameRequest] = [] // recorded releases
    public private(set) var revokedServers: [ServerRevocationRequest] = [] // recorded P13 kill-switch calls
    public private(set) var registeredRcks: [String: String] = [:]    // serverDomain → rckPubKey
    public private(set) var registeredPushTokens: [String: PushTokenRegisterRequest.Inner] = [:] // tokenId → inner
    private var nextPushTokenId = 1

    public init() {}

    private func tick() async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        if shouldFail {
            throw ScreensClientError.http(status: 503, message: "simulated failure")
        }
    }

    public func claimUsername(_ req: UsernameClaimRequest) async throws {
        try await tick()
        let u = req.request.username.lowercased()
        if let prior = claimedUsernames[u], prior != req.request.irkPub {
            throw ScreensClientError.http(status: 409, message: "username taken")
        }
        claimedUsernames[u] = req.request.irkPub
    }

    public func issueAuthCode(_ req: AuthCodeIssueRequest) async throws {
        try await tick()
        issuedAuthCodes[req.code.serial] = req.code
    }

    public func registerRck(_ req: RckRegisterRequest) async throws {
        try await tick()
        registeredRcks[req.request.subdomain] = req.request.rckPubKey
    }

    public func revokeAuthCode(_ req: AuthCodeRevokeRequest) async throws {
        try await tick()
        revokedAuthCodes.insert(req.request.serial)
    }

    public func releaseServerName(_ req: ReleaseServerNameRequest) async throws {
        try await tick()
        releasedServerNames.append(req)
    }

    public func revokeServer(_ req: ServerRevocationRequest) async throws {
        try await tick()
        revokedServers.append(req)
    }

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        try await tick()
        let lower = username.lowercased()
        // v2 device-addressing — `<u>.<label>` syntax precedes every
        // other rule. The Worker behaves the same way: when a typed
        // dot-form matches both a demo_users row AND an active
        // device_capability_grants row, the response carries the
        // `deviceCapability` block + the underlying demoServer. Any
        // other dot-form returns 404 — we translate that to
        // available=false + a `reason` mirroring the Worker.
        if lower.contains(".") {
            if let cap = deviceCapabilities[lower] {
                let dot = lower.firstIndex(of: ".")!
                let userPart = String(lower[..<dot])
                let underlyingDemo = demoServers[userPart]
                return .init(
                    username: lower,
                    available: false,
                    reason: "device capability",
                    demoServer: underlyingDemo,
                    deviceCapability: cap
                )
            }
            // Mirror the Worker's 404 → "unknown demo device label".
            // Returning available=false here so the Mock's wire shape
            // stays parseable; the Live client surfaces the 404 via
            // `usernameLookupBadRequest` / errors.
            throw ScreensClientError.http(status: 404, message: "unknown demo device label")
        }
        // Plan A — every return branch folds in the demoServer block
        // when present. Independent of the testAccount / claim
        // branches; the Worker behaves the same way.
        let demoBlock = demoServers[lower]
        // Test-account match precedes every other rule so a value
        // that would otherwise look invalid still surfaces the
        // testAccount block (Worker side does the same).
        if let meta = testAccounts[lower] {
            return .init(
                username: lower,
                available: false,
                reason: "test account",
                testAccount: meta,
                demoServer: demoBlock
            )
        }
        // Username rules. Mirrors the Worker's USERNAME_RE in
        // labels.ts so the Mock's wire shape (reason strings +
        // ordering) matches what a real Worker would return — keep
        // these in sync. 3–30 chars, NO hyphens (alphanumerics only).
        let usernameRe = "^[a-z0-9]{3,30}$"
        if lower.range(of: usernameRe, options: .regularExpression) == nil {
            return .init(
                username: lower,
                available: false,
                reason: "username must be 3–30 lowercase letters or digits (no hyphens)",
                demoServer: demoBlock
            )
        }
        if reservedUsernames.contains(lower) {
            return .init(
                username: lower,
                available: false,
                reason: "username \"\(lower)\" is reserved",
                demoServer: demoBlock
            )
        }
        if let prior = claimedUsernames[lower], prior != "_self" {
            return .init(
                username: lower,
                available: false,
                reason: "already claimed",
                demoServer: demoBlock
            )
        }
        return .init(
            username: lower,
            available: true,
            reason: nil,
            demoServer: demoBlock
        )
    }

    /// Login/join preflight. Mirrors the Worker's
    /// `handleAccountResolve` decision order:
    ///   1. demo_users (here: `demoServers`) checked FIRST — a hit is
    ///      `kind:"demo"` + the demoServer block + `graceModel:"instant"`.
    ///      Demo crypto is a no-op so no other field matters.
    ///   2. otherwise project the claimed-username row: `kind` is
    ///      "multi" iff `accountTypeByUser[u] == "multi"`, else "single";
    ///      recovery presence from `cloudRecoveryByUser`; totpEnrolled
    ///      from `totpEnrolledAtByUser`; trustedDeviceCount from
    ///      `devicesByUser`; graceModel derived per the matrix.
    ///   3. a name with no claim (and no demo row) resolves to
    ///      `kind:"unknown"` with zeroed factors — NEVER throws / 404s.
    /// The Live client GETs the endpoint; this keeps the two wire-shapes
    /// byte-aligned.
    public func resolveAccount(username: String) async throws -> AccountResolution {
        try await tick()
        let u = username.lowercased()
        // 1. Demo first. The username IS the capability for a demo
        // account; any seeded demo username opens with crypto skipped.
        if let demo = demoServers[u] {
            return AccountResolution(
                username: u,
                exists: true,
                kind: .demo,
                recovery: .init(present: false, hasFetchGate: false),
                totpEnrolled: false,
                trustedDeviceCount: 0,
                demoServer: demo,
                graceModel: .instant
            )
        }
        // 2. Real claimed account.
        guard claimedUsernames[u] != nil else {
            // 3. No account by that name — a STATE, not an error.
            return .unknown(u)
        }
        let kind: AccountResolution.Kind =
            (accountTypeByUser[u] == "multi") ? .multi : .single
        let hasRecovery = cloudRecoveryByUser[u] ?? false
        let deviceCount = (devicesByUser[u] ?? []).count
        return AccountResolution(
            username: u,
            exists: true,
            kind: kind,
            recovery: .init(present: hasRecovery, hasFetchGate: false),
            totpEnrolled: totpEnrolledAtByUser[u] != nil,
            trustedDeviceCount: deviceCount,
            demoServer: nil,
            graceModel: kind == .multi ? .twentyFourHourTotp : .threeDay
        )
    }

    public func registerRecoveryEnvelope(_ req: RecoveryUploadRequest) async throws -> RecoveryEnvelopeResponse {
        try await tick()
        let updated = recoveryStore[req.request.credentialId] != nil
        recoveryStore[req.request.credentialId] = RecoveryEnvelope(
            credentialId: req.request.credentialId,
            wrappedUmk: req.request.wrappedUmk,
            wrappedAcmeAccountKey: req.request.wrappedAcmeAccountKey
        )
        // Mirror the Worker's username-keyed row + Task #74 gate hashes so
        // the gated fetch round-trips. Preserve an existing escrowed ACME
        // key on a UMK-only re-upload, matching handleUploadWebauthnRecovery.
        let u = req.request.username.lowercased()
        let existing = recoveryRowsByUser[u]
        let acme = (req.request.wrappedAcmeAccountKey?.isEmpty == false)
            ? req.request.wrappedAcmeAccountKey
            : existing?.wrappedAcmeAccountKey
        recoveryRowsByUser[u] = MockRecoveryRow(
            credentialId: req.request.credentialId,
            wrappedUmk: req.request.wrappedUmk,
            wrappedAcmeAccountKey: acme,
            fetchTokenHash: req.request.fetchTokenHash?.lowercased() ?? existing?.fetchTokenHash,
            prfSaltHash: req.request.prfSaltHash?.lowercased() ?? existing?.prfSaltHash,
            updatedAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
        return RecoveryEnvelopeResponse(ok: true, updated: updated)
    }

    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        try await tick()
        if let env = recoveryStore[credentialId] { return env }
        throw ScreensClientError.http(status: 404, message: "no envelope")
    }

    public func fetchWrappedUmk(username: String, fetchTokenHex: String) async throws -> RecoveryFetchResponse {
        try await tick()
        guard let row = recoveryRowsByUser[username.lowercased()] else {
            throw ScreensClientError.http(status: 404, message: "no recovery record")
        }
        // Legacy row with no gate → 409, same as the Worker.
        guard let storedHash = row.fetchTokenHash else {
            throw ScreensClientError.http(status: 409, message: "record predates passphrase gate")
        }
        // The Worker hashes the PRESENTED fetchToken bytes and compares.
        guard let tokenBytes = Self.hexToBytes(fetchTokenHex.lowercased()) else {
            throw ScreensClientError.http(status: 400, message: "fetchToken must be hex")
        }
        let presented = SHA256.hash(data: tokenBytes).map { String(format: "%02x", $0) }.joined()
        guard presented == storedHash.lowercased() else {
            throw ScreensClientError.http(status: 403, message: "invalid fetch token")
        }
        return RecoveryFetchResponse(
            username: username.lowercased(),
            credentialId: row.credentialId,
            wrappedUmk: row.wrappedUmk,
            wrappedAcmeAccountKey: row.wrappedAcmeAccountKey,
            prfSaltHash: tamperedPrfSaltHashOnFetch ?? row.prfSaltHash,
            updatedAt: row.updatedAt,
            // Recovery Phase B — mirror the Worker, which returns the currently
            // registered IRK from the usernames table. The Mock's analog is
            // `claimedUsernames`; nil when the account wasn't claimed in this
            // test harness (the client then stays on the instant path).
            registeredIrkPubHex: claimedUsernames[username.lowercased()]
        )
    }

    private static func hexToBytes(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            guard let b = UInt8(hex[idx..<next], radix: 16) else { return nil }
            out.append(b)
            idx = next
        }
        return out
    }

    public func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse {
        try await tick()
        let id = String(format: "tok_%06d", nextPushTokenId); nextPushTokenId += 1
        registeredPushTokens[id] = req.request
        return PushTokenRegisterResponse(ok: true, tokenId: id)
    }

    public func revokePushToken(_ req: PushTokenRevokeRequest) async throws {
        try await tick()
        // 404 is intentionally success: revoking an already-revoked
        // (or never-registered) token shouldn't fail the caller's
        // sign-out flow.
        registeredPushTokens.removeValue(forKey: req.request.tokenId)
    }

    /// Phase 3b — the 14-day quarantine the Worker stamps on a vouched
    /// admit (matches QUARANTINE_MS in packages/control-plane/src/push.ts).
    public static let quarantineMs: Int64 = 14 * 24 * 60 * 60 * 1000

    /// Phase 3b — admitted devices, keyed by account → list of admit
    /// bodies, so tests can assert the incoming device's pubkey + the
    /// registration landed. The Mock applies the Worker's username-match
    /// gates; the admit-signature verify is exercised directly against
    /// the `Flagship.DeviceAdmit` crypto in the test target (FlagshipAPI
    /// has no dependency on the Flagship crypto module).
    public private(set) var admittedDevices: [String: [DeviceAdmitRequest]] = [:]

    /// Injectable clock for the quarantine deadline (tests can pin it).
    public var nowProvider: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    public func admitDevice(account: String, body: DeviceAdmitRequest) async throws -> DeviceAdmitResponse {
        try await tick()
        let acct = account.lowercased()
        // Worker gate: admit username must match the path + the register
        // body's username.
        if body.admit.username.lowercased() != acct {
            throw ScreensClientError.http(status: 403, message: "admit username / url mismatch")
        }
        if body.request.username.lowercased() != body.admit.username.lowercased() {
            throw ScreensClientError.http(status: 403, message: "register username does not match admit")
        }
        admittedDevices[acct, default: []].append(body)
        let id = String(format: "tok_%06d", nextPushTokenId); nextPushTokenId += 1
        registeredPushTokens[id] = body.request
        let until = nowProvider() + Self.quarantineMs
        return DeviceAdmitResponse(ok: true, tokenId: id, quarantineUntil: until)
    }

    /// Active watch delegates per user. The Mock holds only the un-revoked
    /// rows (the list endpoint shows active-only), mirroring the Worker's
    /// one-active-per-user invariant: a mint replaces the prior.
    public var watchDelegatesByUser: [String: [WatchDelegateInfo]] = [:]

    public func mintWatchDelegate(username: String, body: WatchDelegateMintRequest) async throws -> WatchDelegateMintResponse {
        try await tick()
        let u = username.lowercased()
        // The Worker rejects a scope set other than ["boot-approval"]
        // (FlagshipCore's WatchDelegateKeyEnvelope.bootApprovalScope; inlined
        // here so the API module needn't depend on FlagshipCore).
        guard body.grant.scopes == ["boot-approval"] else {
            throw ScreensClientError.http(status: 400, message: "invalid scopes")
        }
        guard body.grant.expiresAt > nowProvider() else {
            throw ScreensClientError.http(status: 400, message: "delegate already expired")
        }
        // One active per user — replace the prior (matches the Worker, which
        // revokes the existing active row before insert).
        let prior = watchDelegatesByUser[u]?.first
        watchDelegatesByUser[u] = [
            WatchDelegateInfo(
                grantId: body.grant.grantId,
                delegatePubKey: body.grant.delegatePubKey.lowercased(),
                scopes: body.grant.scopes,
                issuedAt: body.grant.issuedAt,
                expiresAt: body.grant.expiresAt
            )
        ]
        return WatchDelegateMintResponse(
            ok: true,
            grantId: body.grant.grantId,
            expiresAt: body.grant.expiresAt,
            replacedGrantId: prior?.grantId
        )
    }

    public func listWatchDelegates(username: String) async throws -> WatchDelegatesListResponse {
        try await tick()
        let u = username.lowercased()
        let active = (watchDelegatesByUser[u] ?? []).filter { $0.expiresAt > nowProvider() }
        return WatchDelegatesListResponse(username: u, delegates: active)
    }

    public func revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) async throws {
        try await tick()
        let u = username.lowercased()
        watchDelegatesByUser[u]?.removeAll { $0.grantId == body.request.grantId }
    }

    /// Scripted install-event log per serial. Tests configure
    /// `installEventScripts[serial]` with a sequence of (eventName,
    /// detail, postedAt) tuples; each `getInstallEvents` call serves
    /// from index `since` onward and rolls the cursor forward by the
    /// number of new events.
    public var installEventScripts: [String: [(eventName: String, detail: String, postedAt: Int64)]] = [:]

    /// Scripted devices listing per username for tests + dev mode.
    /// The Mock returns a synthesized ETag (sha-prefix of JSON) so
    /// If-Match flows can be exercised without the real Worker.
    public var devicesByUser: [String: [TrustedDevice]] = [:]

    /// Scripted audit log per username. Tests configure the array
    /// to drive ActivityViewModel renders without hitting the
    /// Worker. Defaults to empty so unconfigured tests see a clean
    /// (no Account events) section.
    public var auditEventsByUser: [String: [AuditEvent]] = [:]

    public func listAuditEvents(username: String, sinceSeq: Int, limit: Int) async throws -> AuditEventListResponse {
        try await tick()
        let all = auditEventsByUser[username.lowercased()] ?? []
        let filtered = all.filter { $0.seq > sinceSeq }.sorted { $0.seq > $1.seq }
        return AuditEventListResponse(events: Array(filtered.prefix(max(0, min(limit, 50)))))
    }

    /// Scripted recovery enrollment state per username. Tests set this
    /// to drive the Home recovery-setup nudge (B9). Unconfigured users
    /// default to `false` (no envelope on .com) — the "fresh install,
    /// hasn't enrolled yet" baseline. Set to `true` to suppress the
    /// nudge in tests that aren't exercising the B9 path.
    public var cloudRecoveryByUser: [String: Bool] = [:]

    public func hasCloudRecovery(username: String) async throws -> Bool {
        try await tick()
        return cloudRecoveryByUser[username.lowercased()] ?? false
    }

    /// Scripted re-pair behavior per username. Tests configure
    /// `rePairBehavior` to drive happy-path / 412 / 409 outcomes
    /// without spinning up a real Worker.
    public enum RePairBehavior: Sendable {
        case ok                        // initiate returns 200 + grace
        case staleEtag(currentEtag: String) // 412 → throws as http(412)
        case alreadyPending            // 409
    }
    public var rePairBehavior: RePairBehavior = .ok
    /// Captures the last initiate call so tests can assert on the
    /// signed request shape.
    public private(set) var lastRePairInitiate: (
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?
    )?

    public func initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?
    ) async throws -> RePairInitiateResponse {
        try await tick()
        lastRePairInitiate = (username, body, ifMatch)
        // v1.2 — mirror the Worker's gate: a re-pair on a `multi`
        // account is rejected (401) unless it carries a structurally-
        // valid totpProof (non-empty code + an allowed method). #52 —
        // a SINGLE-device account with an enrolled second factor
        // (TOTP enrolled and/or unspent recovery codes) is gated the
        // same way; single accounts with NEITHER stay grace-only.
        // Lets the login state machine + its tests exercise the
        // second-factor requirement against the Mock.
        let u = username.lowercased()
        let isMulti = accountTypeByUser[u] == "multi"
        let singleCredentialEnrolled = !isMulti
            && (totpEnrolledAtByUser[u] != nil || !(recoveryCodesByUser[u] ?? []).isEmpty)
        if isMulti || singleCredentialEnrolled {
            let proof = body.totpProof
            let methodOk = proof?.method == "totp" || proof?.method == "recovery"
            let codeOk = !(proof?.code.isEmpty ?? true)
            guard let proof, methodOk, codeOk else {
                throw ScreensClientError.http(
                    status: 401,
                    message: isMulti
                        ? "totpProof required for multi-device re-pair"
                        : "totpProof required for single-device recovery (a second factor is enrolled)"
                )
            }
            _ = proof
        }
        switch rePairBehavior {
        case .staleEtag(let etag):
            throw ScreensClientError.http(status: 412, message: "{\"error\":\"stale\",\"currentEtag\":\"\(etag)\"}")
        case .alreadyPending:
            throw ScreensClientError.http(status: 409, message: "already pending")
        case .ok:
            return RePairInitiateResponse(ok: true, completesAt: Int64(Date().timeIntervalSince1970 * 1000) + 24 * 3600 * 1000, graceMs: 24 * 3600 * 1000)
        }
    }

    public func completeRePair(username: String) async throws -> RePairCompleteResponse {
        try await tick()
        return RePairCompleteResponse(ok: true, newIrkPub: "00", swappedAt: Int64(Date().timeIntervalSince1970 * 1000))
    }

    /// M4 — scripted pending re-pair snapshot per username. Tests set
    /// this to drive the Trusted-devices banner. Unconfigured users
    /// default to `{ pending: nil }` (nothing in flight). Set
    /// `pendingRePairUnavailable` to model an older Worker (404).
    public var pendingRePairByUser: [String: PendingRePairInfo] = [:]
    public var pendingRePairUnavailable: Bool = false

    public func fetchPendingRePair(username: String) async throws -> PendingRePairSnapshot {
        try await tick()
        if pendingRePairUnavailable {
            return PendingRePairSnapshot(pending: nil, unavailable: true)
        }
        return PendingRePairSnapshot(pending: pendingRePairByUser[username.lowercased()])
    }

    /// Drives wipe-restart outcomes in tests.
    public enum WipeRestartBehavior: Sendable {
        case ok
        case rateLimited
        case staleEtag(String)
        case concurrentRotation
    }
    public var wipeRestartBehavior: WipeRestartBehavior = .ok
    public private(set) var lastWipeRestart: (
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?
    )?

    public func wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?
    ) async throws -> WipeRestartResponse {
        try await tick()
        lastWipeRestart = (username, body, ifMatch)
        switch wipeRestartBehavior {
        case .ok:
            return WipeRestartResponse(
                ok: true,
                auditSeq: 42,
                newIrkPub: body.request.newIrkPub,
                etag: "W/\"post-wipe\""
            )
        case .rateLimited:
            throw ScreensClientError.http(status: 429, message: "wipe-restart rate-limited")
        case .staleEtag(let etag):
            throw ScreensClientError.http(status: 412, message: "{\"currentEtag\":\"\(etag)\"}")
        case .concurrentRotation:
            throw ScreensClientError.http(status: 409, message: "concurrent rotation won")
        }
    }

    /// V2 — scripted Replace behaviour. Same shape as the other
    /// scripted enums.
    public enum AppRenameBehavior: Sendable {
        case ok
        case collision
        case staleSignature
    }
    public var appRenameBehavior: AppRenameBehavior = .ok
    public private(set) var lastAppRename: (
        username: String,
        serviceId: String,
        body: AppRenameRequest
    )?
    /// Scripted alias map per (username, serviceId). The links endpoint
    /// returns these; the rename endpoint writes into them.
    public var appAliasByUser: [String: [String: (displayLabel: String, canonicalUrl: String)]] = [:]
    /// Bound external domains, keyed [user][serviceId]. A Replace never
    /// clears this — it's deliberately a separate store from aliases.
    public var customDomainByUser: [String: [String: String]] = [:]
    /// Server-side rate limit mirror: [user][serviceId] → last change.
    public var customDomainLastChangedByUser: [String: [String: Date]] = [:]
    /// Min seconds between custom-domain changes (server-enforced).
    public var customDomainMinInterval: TimeInterval = 300
    /// Demo only: how long after a request the Mock pretends .com
    /// finished the out-of-band CNAME verification. A real server
    /// pushes the outcome; the Mock just flips confirmed after this.
    public var customDomainConfirmDelay: TimeInterval = 6

    public func renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest
    ) async throws -> AppRenameResponse {
        try await tick()
        lastAppRename = (username, serviceId, body)
        switch appRenameBehavior {
        case .collision:
            throw ScreensClientError.http(status: 409, message: "label collision")
        case .staleSignature:
            throw ScreensClientError.http(status: 403, message: "bad signature")
        case .ok:
            let newLabel = body.request.newDisplayLabel
            let canonical = "https://\(Endpoints.serverFqdn(server: newLabel, user: username.lowercased()))"
            appAliasByUser[username.lowercased(), default: [:]][serviceId] = (newLabel, canonical)
            return AppRenameResponse(
                ok: true,
                displayLabel: newLabel,
                canonicalUrl: canonical,
                shortUrl: "https://voi.ci/\(synthesizeMockShortCode(forServiceId: serviceId, label: newLabel))",
                shortCode: synthesizeMockShortCode(forServiceId: serviceId, label: newLabel),
                unchanged: false
            )
        }
    }

    public func getAppLinks(
        username: String,
        serviceId: String
    ) async throws -> AppLinksResponse {
        try await tick()
        let alias = appAliasByUser[username.lowercased()]?[serviceId]
        // Mirrors @flagship/protocol deriveUrlFragment: serviceId is
        // `<creator>-<slug>` (single dash; FIRST hyphen splits, since
        // usernames are hyphen-free). The fragment is CONDITIONAL on
        // who runs it: just `<slug>` when the running user authored
        // it, else `<slug>-<creator>`.
        let defaultLabel: String = {
            if let i = serviceId.firstIndex(of: "-"),
               i != serviceId.startIndex,
               serviceId.index(after: i) != serviceId.endIndex {
                let creator = serviceId[serviceId.startIndex..<i].lowercased()
                let slug = String(serviceId[serviceId.index(after: i)...]).lowercased()
                return creator == username.lowercased() ? slug : "\(slug)-\(creator)"
            }
            return serviceId.lowercased()
        }()
        let label = alias?.displayLabel ?? defaultLabel
        let host = Endpoints.userZoneHost(username.lowercased())
        let canonical = alias?.canonicalUrl ?? "https://\(label).\(host)"
        // V6 — Mock now mirrors the Worker's lazy-mint contract:
        // /links always returns a populated shortUrl. The code is a
        // deterministic 6-char hex prefix of serviceId so the same app
        // surfaces the same link across calls (so a copy-paste in
        // demo mode is stable + previews stay snapshot-friendly).
        let shortCode = synthesizeMockShortCode(forServiceId: serviceId, label: label)
        let lastChanged = customDomainLastChangedByUser[username.lowercased()]?[serviceId]
        // Demo: .com "confirms" the CNAME customDomainConfirmDelay
        // seconds after the request (a real server pushes the outcome).
        // The server keeps its own lastChanged timer for the rate
        // limit; it is NOT echoed to the client (the client stores its
        // own local timestamp for the countdown).
        let confirmed = lastChanged.map {
            Date().timeIntervalSince($0) >= customDomainConfirmDelay
        }
        return AppLinksResponse(
            serviceId: serviceId,
            displayLabel: label,
            canonicalUrl: canonical,
            instances: [
                AppLinkInstance(
                    serverDomain: host,
                    url: canonical
                ),
            ],
            shortUrl: "https://voi.ci/\(shortCode)",
            customDomain: customDomainByUser[username.lowercased()]?[serviceId],
            customDomainConfirmed: confirmed
        )
    }

    public func setCustomDomain(
        username: String,
        serviceId: String,
        body: SetCustomDomainRequest
    ) async throws -> AppLinksResponse {
        try await tick()
        let u = username.lowercased()
        // Server-side rate limit (the lastChanged column). The client
        // mirrors this with a cooldown, but the server is the backstop.
        if let last = customDomainLastChangedByUser[u]?[serviceId] {
            let elapsed = Date().timeIntervalSince(last)
            if elapsed < customDomainMinInterval {
                let wait = Int((customDomainMinInterval - elapsed).rounded(.up))
                throw ScreensClientError.http(
                    status: 429,
                    message: "Too soon — try again in \(wait)s."
                )
            }
        }
        // Synchronous confirmation: a real server fetches the CNAME
        // here and only commits if it points at the user's stub. The
        // Mock has no DNS, so it accepts the claim (the demo can't
        // exercise a real failure path). Record from the signed body.
        customDomainByUser[u, default: [:]][serviceId] =
            body.request.fqdn.trimmingCharacters(in: .whitespaces).lowercased()
        customDomainLastChangedByUser[u, default: [:]][serviceId] = Date()
        return try await getAppLinks(username: username, serviceId: serviceId)
    }

    /// FNV-1a over (serviceId|label) → first 6 hex digits, lowercased.
    /// Deterministic + stable across calls; not crypto-strong (it
    /// only feeds the Mock surface). The Worker's mintShortLink
    /// uses crypto.getRandomValues so production codes are random.
    private static func synthesizeMockShortCode(forServiceId serviceId: String, label: String) -> String {
        var h: UInt64 = 14695981039346656037
        for byte in (serviceId + "|" + label).utf8 {
            h ^= UInt64(byte)
            h &*= 1099511628211
        }
        let hex = String(h, radix: 16)
        // 6 chars; pad with the serviceId hash's own bits if short.
        return String((hex + "000000").prefix(6))
    }

    private func synthesizeMockShortCode(forServiceId serviceId: String, label: String) -> String {
        Self.synthesizeMockShortCode(forServiceId: serviceId, label: label)
    }

    public func listDevices(username: String) async throws -> TrustedDevicesListResponse {
        try await tick()
        let devices = devicesByUser[username.lowercased()] ?? []
        let sorted = devices.sorted { a, b in
            a.addedAt != b.addedAt ? a.addedAt < b.addedAt : a.tokenId < b.tokenId
        }
        let etag = Self.etagFor(sorted)
        return TrustedDevicesListResponse(devices: sorted, etag: etag)
    }

    private static func etagFor(_ devices: [TrustedDevice]) -> String {
        // Identity-significant subset only; lastSeenAt deliberately
        // excluded so test push-delivery doesn't flutter the ETag.
        // We hash the canonicalized bytes directly (FNV-1a) instead
        // of going through JSONEncoder — Swift's synthesized Codable
        // for a local struct nested inside a function doesn't
        // guarantee stable byte output across calls, which made the
        // ETag non-deterministic.
        var hash: UInt64 = 14695981039346656037
        func feedString(_ s: String) {
            for b in s.utf8 { hash ^= UInt64(b); hash &*= 1099511628211 }
            // Separator so concatenation collisions are impossible
            // (e.g. {"abc"+"d"} vs {"ab"+"cd"}).
            hash ^= 0x1f; hash &*= 1099511628211
        }
        func feedInt(_ n: Int64) {
            let bits = UInt64(bitPattern: n)
            for shift in stride(from: 0, through: 56, by: 8) {
                hash ^= UInt64((bits >> UInt64(shift)) & 0xff)
                hash &*= 1099511628211
            }
            hash ^= 0x1f; hash &*= 1099511628211
        }
        for d in devices {
            feedString(d.tokenId)
            feedString(d.label)
            feedString(d.platform)
            feedInt(d.addedAt)
        }
        let hex = String(hash, radix: 16, uppercase: false)
        return "W/\"\(String(repeating: "0", count: max(0, 16 - hex.count)) + hex)\""
    }

    public func getInstallEvents(serial: String, since: Int) async throws -> InstallEventsPollResponse {
        try await tick()
        let script = installEventScripts[serial] ?? []
        let starting = max(since, 0)
        let slice = script.enumerated()
            .filter { $0.offset >= starting }
            .map { idx, e in
                InstallEventRecord(
                    seq: idx + 1,
                    eventName: e.eventName,
                    detail: e.detail,
                    postedAt: e.postedAt
                )
            }
        return InstallEventsPollResponse(
            serial: serial,
            events: slice,
            cursor: starting + slice.count
        )
    }

    // v1.2 Phase 4 — scripted account-type + TOTP state per username,
    // mirroring the Worker's `usernames` row + the four /totp/*
    // handlers. Tests drive these to exercise the Mobile flow without
    // a live Worker.

    /// Per-username `account_type`. Defaults to "single" when absent
    /// (matching the column DEFAULT). Tests set this to "multi" to
    /// drive the multi-device badge / re-pair branch.
    public var accountTypeByUser: [String: String] = [:]

    /// Per-username `totp_enrolled_at` (ms epoch). Nil while the row
    /// is still single-device.
    public var totpEnrolledAtByUser: [String: Int64] = [:]

    /// Per-username staged TOTP secret (base32). Set on enroll-begin
    /// + cleared on disable; mirrors the Worker's
    /// `totp_secret_encrypted` row column.
    public var totpSecretByUser: [String: String] = [:]

    /// Per-username recovery codes (plaintext mirror). The Worker
    /// stores argon2id hashes — for the Mock we store plaintexts so
    /// tests can assert on the round-trip without standing up a
    /// hashing primitive.
    public var recoveryCodesByUser: [String: [String]] = [:]

    /// Scripted enroll-confirm code that the Mock accepts. Tests set
    /// this to drive happy-path (match) vs sad-path (mismatch) flows.
    public var totpExpectedConfirmCode: String = "123456"

    /// Scripted recovery codes to hand back on enroll-confirm. Tests
    /// can assert on these directly; the default is deterministic.
    public var totpRecoveryCodesToIssue: [String] = [
        "AAAA-BBBB", "CCCC-DDDD", "EEEE-FFFF", "GGGG-HHHH", "IIII-JJJJ",
        "KKKK-LLLL", "MMMM-NNNN", "OOOO-PPPP", "QQQQ-RRRR", "SSSS-TTTT",
    ]

    public func getUsernameRecord(username: String) async throws -> UsernameLookupResponse {
        try await tick()
        let u = username.lowercased()
        guard claimedUsernames[u] != nil else {
            throw ScreensClientError.http(status: 404, message: "not found")
        }
        return UsernameLookupResponse(
            username: u,
            irkPub: claimedUsernames[u] ?? "",
            claimedAt: 0,
            accountType: accountTypeByUser[u] ?? "single",
            totpEnrolledAt: totpEnrolledAtByUser[u]
        )
    }

    public func totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest
    ) async throws -> TotpEnrollBeginResponse {
        try await tick()
        let u = username.lowercased()
        // Synthesize a deterministic base32 secret per username so
        // tests can assert on it without depending on Mock-internal
        // randomness.
        let secret = "JBSWY3DPEHPK3PXP\(u.prefix(4).uppercased().padding(toLength: 4, withPad: "X", startingAt: 0))"
        totpSecretByUser[u] = secret
        let issuer = "Flagship"
        let otpauthUrl = "otpauth://totp/\(issuer):\(u)?secret=\(secret)&issuer=\(issuer)&algorithm=SHA1&digits=6&period=30"
        // 4×4 hex sample (44 bytes) -> "fake QR" base64 placeholder
        // the iOS Image renderer can decode as a 1×1 PNG. Real Worker
        // returns a 4×-scale PNG; tests don't pixel-compare.
        let qrPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        return TotpEnrollBeginResponse(
            secret: secret,
            otpauthUrl: otpauthUrl,
            qrPngBase64: qrPngBase64,
            issuer: issuer
        )
    }

    public func totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest
    ) async throws -> TotpEnrollConfirmResponse {
        try await tick()
        let u = username.lowercased()
        guard totpSecretByUser[u] != nil else {
            throw ScreensClientError.http(status: 409, message: "no staged TOTP secret; call enroll-begin first")
        }
        guard body.code == totpExpectedConfirmCode else {
            throw ScreensClientError.http(status: 401, message: "invalid TOTP code")
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        accountTypeByUser[u] = "multi"
        totpEnrolledAtByUser[u] = now
        recoveryCodesByUser[u] = totpRecoveryCodesToIssue
        return TotpEnrollConfirmResponse(
            ok: true,
            accountType: "multi",
            totpEnrolledAt: now,
            recoveryCodes: totpRecoveryCodesToIssue
        )
    }

    public func totpDisable(
        username: String,
        body: TotpDisableRequest
    ) async throws -> TotpDisableResponse {
        try await tick()
        let u = username.lowercased()
        guard body.code == totpExpectedConfirmCode else {
            throw ScreensClientError.http(status: 401, message: "invalid TOTP code")
        }
        accountTypeByUser[u] = "single"
        totpEnrolledAtByUser.removeValue(forKey: u)
        totpSecretByUser.removeValue(forKey: u)
        recoveryCodesByUser.removeValue(forKey: u)
        return TotpDisableResponse(ok: true, accountType: "single")
    }

    // MARK: - Provisioning status (Mock)

    /// Fixed provision-status records keyed by serial. When a serial is
    /// present here, `fetchProvisionStatus` returns this record verbatim
    /// (so tests can pin an exact wire shape). A serial that is neither
    /// here nor in `provisionStatusScripts` returns nil (the Worker's
    /// 404 → "no status").
    public var provisionStatusFixtures: [String: ProvisionStatus] = [:]

    /// Scripted phase PROGRESSION per serial. Each `fetchProvisionStatus`
    /// call advances one step along the script and returns a record whose
    /// `phase` is the current step + a `history` built from every step
    /// served so far (oldest first), matching the Worker's append-only
    /// history. The poller drives the timeline pending → … → live this
    /// way without real time. `provisionStatusFixtures` takes precedence.
    public var provisionStatusScripts: [String: [(phase: ProvisionStatusPhase, detail: String?)]] = [:]

    /// serverDomain echoed by the scripted progression (the box usually
    /// learns it at `registering`). Keyed by serial; optional.
    public var provisionStatusServerDomains: [String: String] = [:]

    /// Per-serial cursor into `provisionStatusScripts`, advanced one step
    /// per call.
    private var provisionStatusCursors: [String: Int] = [:]

    public func fetchProvisionStatus(serial: String) async throws -> ProvisionStatus? {
        try await tick()
        if let fixed = provisionStatusFixtures[serial] { return fixed }
        guard let script = provisionStatusScripts[serial], !script.isEmpty else {
            // No checkpoint yet — the Worker would 404; we map that to nil.
            return nil
        }
        // Advance one step per call; clamp at the final step so a poller
        // that keeps polling after the terminal phase keeps seeing it.
        let prev = provisionStatusCursors[serial] ?? -1
        let idx = min(prev + 1, script.count - 1)
        provisionStatusCursors[serial] = idx
        let baseTs: Int64 = 1_000
        let history = script[0...idx].enumerated().map { (i, step) in
            ProvisionStatusEntry(phase: step.phase, detail: step.detail, ts: baseTs + Int64(i))
        }
        let current = script[idx]
        return ProvisionStatus(
            serial: serial,
            serverDomain: provisionStatusServerDomains[serial],
            phase: current.phase,
            detail: current.detail,
            updatedAt: baseTs + Int64(idx),
            history: Array(history)
        )
    }

    /// #43 — mirror of the Worker's outstanding-orders response, keyed by
    /// lower-cased username. Tests seed this to model orders the account has
    /// in flight server-side (including ones the phone has NO local record
    /// of, the home2-invisible bug). `listOutstandingOrders` returns the
    /// rows for the requested user; an unseeded user yields an empty list.
    public var outstandingOrdersByUser: [String: [OutstandingOrder]] = [:]

    public func listOutstandingOrders(_ req: OutstandingOrdersRequest) async throws -> OutstandingOrdersResponse {
        try await tick()
        let u = req.request.username.lowercased()
        return OutstandingOrdersResponse(username: u, orders: outstandingOrdersByUser[u] ?? [])
    }
}

// MARK: - Live

public final class LiveFlagshipServerClient: FlagshipServerClient, @unchecked Sendable {
    /// The control-plane apex. Derived from `Endpoints` (prod-default, with a
    /// test-build override) so the gym build retargets with one knob; prod is
    /// byte-identical.
    public static var defaultBaseUrl: URL { Endpoints.controlBaseUrl }

    private let urlSession: URLSession
    private let baseUrl: URL
    /// Maintainer-trust short-circuit. Returns the app's current
    /// `isServerTrusted` foundation boolean; when it returns false EVERY
    /// backend call throws `controlServerUntrusted` BEFORE any bytes leave the
    /// device. nil ⇒ no gate installed (every call proceeds — the default, so
    /// existing call sites + tests are unaffected). `.unknown`/`.trusted`
    /// verdicts and a network-error "no verdict" all return true here (we never
    /// halt on the absence of a positive-untrusted verdict).
    private let trustGate: (@Sendable () async -> Bool)?

    public init(
        urlSession: URLSession = .shared,
        baseUrl: URL = defaultBaseUrl,
        trustGate: (@Sendable () async -> Bool)? = nil
    ) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
        self.trustGate = trustGate
    }

    /// The single gate-checked transport every request routes through. The
    /// trust gate is consulted FIRST so an untrusted control server halts the
    /// call before it touches the network.
    private func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
        if let trustGate, await trustGate() == false {
            throw ScreensClientError.controlServerUntrusted
        }
        return try await urlSession.data(for: req)
    }

    private func postJson(_ path: String, body: Data, acceptStatuses: Set<Int> = [200, 201, 204]) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        let text = String(data: data, encoding: .utf8) ?? ""
        throw ScreensClientError.http(status: status, message: text)
    }

    private func postJsonReturning<Resp: Decodable>(_ path: String, body: Data) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    public func claimUsername(_ req: UsernameClaimRequest) async throws {
        let body = try JSONEncoder().encode(req)
        // 409 = idempotent retake under same IRK; treat as success.
        try await postJson("/api/username/claim", body: body, acceptStatuses: [200, 201, 204, 409])
    }

    public func issueAuthCode(_ req: AuthCodeIssueRequest) async throws {
        let body = try JSONEncoder().encode(req)
        try await postJson("/api/auth-code/issue", body: body)
    }

    public func registerRck(_ req: RckRegisterRequest) async throws {
        let body = try JSONEncoder().encode(req)
        try await postJson("/api/routing/register-rck", body: body)
    }

    public func revokeAuthCode(_ req: AuthCodeRevokeRequest) async throws {
        let body = try JSONEncoder().encode(req)
        // The serial lives in the path; the body still carries it so
        // the Worker can refuse mismatched envelopes. 403 covers every
        // authentication-or-existence failure (the Worker collapses
        // these to one response to avoid an enumeration oracle). We
        // accept 200/204 and treat 403/404 as "already gone" so the
        // user's UI experience stays consistent.
        let encodedSerial = req.request.serial.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? req.request.serial
        try await postJson(
            "/api/auth-code/\(encodedSerial)/revoke",
            body: body,
            acceptStatuses: [200, 201, 204, 403, 404]
        )
    }

    public func releaseServerName(_ req: ReleaseServerNameRequest) async throws {
        let body = try JSONEncoder().encode(req)
        try await postJson("/api/server/release", body: body)
    }

    public func revokeServer(_ req: ServerRevocationRequest) async throws {
        // P13 — the matching `.com` Worker route is not yet wired (a
        // precedent endpoint exists on the apps/web Fastify server).
        // The URL path is fixed per the orchestrator handoff so the
        // wire shape is ready once the Worker handler lands.
        let body = try JSONEncoder().encode(req)
        try await postJson("/api/server-registry/revoke", body: body)
    }

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        let body = try JSONEncoder().encode(["username": username])
        return try await postJsonReturning("/api/users/check", body: body)
    }

    public func resolveAccount(username: String) async throws -> AccountResolution {
        // GET /api/account/resolve/<username> — 200 always. We still
        // surface a non-2xx as an error (a 5xx is a real outage, not a
        // login-state node) but the Worker never 404s a missing account:
        // that comes back as kind:"unknown" in the body.
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/account/resolve/\(encoded)"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AccountResolution.self, from: data)
    }

    public func registerRecoveryEnvelope(_ req: RecoveryUploadRequest) async throws -> RecoveryEnvelopeResponse {
        let body = try JSONEncoder().encode(req)
        return try await postJsonReturning("/api/recovery", body: body)
    }

    /// LEGACY — there is no live `GET /api/recovery/fetch` on the Worker;
    /// the native cloud-recovery flow uses `fetchWrappedUmk` (the gated
    /// POST) instead. This method survives only for the Mock-only takeover
    /// VMs (RealAccountLogin / WipeRestart), whose live ASAuthorization
    /// wiring is a separate task. Do NOT use it on the live recovery path.
    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/recovery/fetch"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "credentialId", value: credentialId)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RecoveryEnvelope.self, from: data)
    }

    public func fetchWrappedUmk(username: String, fetchTokenHex: String) async throws -> RecoveryFetchResponse {
        // Task #74 — the gate. POST the passphrase-derived fetchToken;
        // `.com` only releases the ciphertext when SHA-256(fetchToken)
        // matches the stored hash. Maps the Worker's status codes to the
        // same human errors recovery.js surfaces (wrong passphrase / rate
        // limit / legacy pre-gate row).
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/recovery/by-username/\(encoded)/fetch"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        req.httpBody = try JSONEncoder().encode(RecoveryFetchTokenBody(fetchToken: fetchTokenHex, issuedAt: issuedAt))
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200..<300:
            return try JSONDecoder().decode(RecoveryFetchResponse.self, from: data)
        case 403:
            throw ScreensClientError.http(status: 403, message: "wrong passphrase")
        case 404:
            throw ScreensClientError.http(status: 404, message: "no cloud recovery for that username")
        case 409:
            throw ScreensClientError.http(status: 409, message: "this record predates the passphrase gate — re-enrol cloud recovery first")
        case 429:
            throw ScreensClientError.http(status: 429, message: "too many attempts — wait 15 minutes before retrying")
        default:
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
    }

    public func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse {
        let body = try JSONEncoder().encode(req)
        return try await postJsonReturning("/api/push/register", body: body)
    }

    public func revokePushToken(_ req: PushTokenRevokeRequest) async throws {
        let encoded = req.request.tokenId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? req.request.tokenId
        var httpReq = URLRequest(url: baseUrl.appendingPathComponent("/api/push/\(encoded)"))
        httpReq.httpMethod = "DELETE"
        httpReq.setValue("application/json", forHTTPHeaderField: "content-type")
        httpReq.httpBody = try JSONEncoder().encode(req)
        let (data, resp) = try await send(httpReq)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200 || status == 204 || status == 404 { return }
        let text = String(data: data, encoding: .utf8) ?? ""
        throw ScreensClientError.http(status: status, message: text)
    }

    public func admitDevice(account: String, body: DeviceAdmitRequest) async throws -> DeviceAdmitResponse {
        let encoded = account.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? account
        let payload = try JSONEncoder().encode(body)
        return try await postJsonReturning("/api/users/\(encoded)/devices/admit", body: payload)
    }

    public func mintWatchDelegate(username: String, body: WatchDelegateMintRequest) async throws -> WatchDelegateMintResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let payload = try JSONEncoder().encode(body)
        return try await postJsonReturning("/api/users/\(encoded)/watch-delegates", body: payload)
    }

    public func listWatchDelegates(username: String) async throws -> WatchDelegatesListResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/watch-delegates"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(WatchDelegatesListResponse.self, from: data)
    }

    public func revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) async throws {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let payload = try JSONEncoder().encode(body)
        try await postJson("/api/users/\(encoded)/watch-delegates/revoke", body: payload)
    }

    public func getInstallEvents(serial: String, since: Int) async throws -> InstallEventsPollResponse {
        let encoded = serial.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serial
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/install-events/\(encoded)"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "since", value: String(since))]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(InstallEventsPollResponse.self, from: data)
    }

    public func listDevices(username: String) async throws -> TrustedDevicesListResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/devices"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let http = resp as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        let body = try JSONDecoder().decode(TrustedDevicesWireBody.self, from: data)
        // ETag header — case-insensitive lookup, may be missing if a
        // proxy strips it. Callers tolerate nil by skipping If-Match.
        let etag = http?.value(forHTTPHeaderField: "Etag") ?? http?.value(forHTTPHeaderField: "ETag")
        return TrustedDevicesListResponse(devices: body.devices, etag: etag)
    }

    public func hasCloudRecovery(username: String) async throws -> Bool {
        // The .com endpoint is GET /api/recovery/by-username/<u>; 200
        // means an envelope exists, 404 means it doesn't, anything
        // else is a transient failure the caller should surface.
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/recovery/by-username/\(encoded)"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200 { return true }
        if status == 404 { return false }
        let text = String(data: data, encoding: .utf8) ?? ""
        throw ScreensClientError.http(status: status, message: text)
    }

    public func initiateRePair(
        username: String,
        body: RePairInitiateRequest,
        ifMatch: String?
    ) async throws -> RePairInitiateResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/re-pair"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let ifMatch { req.setValue(ifMatch, forHTTPHeaderField: "If-Match") }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RePairInitiateResponse.self, from: data)
    }

    public func completeRePair(username: String) async throws -> RePairCompleteResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/re-pair/complete"))
        req.httpMethod = "POST"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RePairCompleteResponse.self, from: data)
    }

    public func fetchPendingRePair(username: String) async throws -> PendingRePairSnapshot {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/re-pair"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        // 404/405 = an older Worker that doesn't wire the GET; treat it
        // the same as "no pending row" but flag it so the caller hides
        // the banner gracefully (mirrors the webapp's `unavailable`).
        if status == 404 || status == 405 {
            return PendingRePairSnapshot(pending: nil, unavailable: true)
        }
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        // The Worker wraps the row as `{ pending: {...} | null }`.
        let body = try JSONDecoder().decode(PendingRePairWireBody.self, from: data)
        return PendingRePairSnapshot(pending: body.pending)
    }

    public func wipeRestart(
        username: String,
        body: WipeRestartRequest,
        ifMatch: String?
    ) async throws -> WipeRestartResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/wipe-restart"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let ifMatch { req.setValue(ifMatch, forHTTPHeaderField: "If-Match") }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(WipeRestartResponse.self, from: data)
    }

    public func renameApp(
        username: String,
        serviceId: String,
        body: AppRenameRequest
    ) async throws -> AppRenameResponse {
        let u = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let a = serviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceId
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(u)/apps/\(a)/rename"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AppRenameResponse.self, from: data)
    }

    public func getAppLinks(
        username: String,
        serviceId: String
    ) async throws -> AppLinksResponse {
        let u = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let a = serviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceId
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(u)/apps/\(a)/links"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AppLinksResponse.self, from: data)
    }

    public func setCustomDomain(
        username: String,
        serviceId: String,
        body: SetCustomDomainRequest
    ) async throws -> AppLinksResponse {
        let u = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let a = serviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceId
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(u)/apps/\(a)/custom-domain"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // .com returns { "error": "…" } on the synchronous denials
            // (429 rate-limit / 400 apex / 403 sig). Surface .error
            // verbatim so the 429 message is byte-identical to the
            // Mock ("Too soon — try again in Ns.", U+2014); fall back
            // to the raw body if it isn't the {error} shape.
            struct ErrBody: Decodable { let error: String? }
            let decoded = try? JSONDecoder().decode(ErrBody.self, from: data)
            let message = decoded?.error
                ?? String(data: data, encoding: .utf8)
                ?? "Couldn't request custom domain."
            throw ScreensClientError.http(status: status, message: message)
        }
        // 200 = recorded only (the POST returns { recorded:true }, NOT
        // the links). Re-read links so the pending domain surfaces
        // optimistically; .com confirms the CNAME out-of-band.
        return try await getAppLinks(username: username, serviceId: serviceId)
    }

    public func listAuditEvents(username: String, sinceSeq: Int, limit: Int) async throws -> AuditEventListResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/audit"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "since", value: String(max(0, sinceSeq))),
            URLQueryItem(name: "limit", value: String(max(1, min(limit, 50)))),
        ]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AuditEventListResponse.self, from: data)
    }

    public func getUsernameRecord(username: String) async throws -> UsernameLookupResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(UsernameLookupResponse.self, from: data)
    }

    public func totpEnrollBegin(
        username: String,
        body: TotpEnrollBeginRequest
    ) async throws -> TotpEnrollBeginResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/totp/enroll-begin"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(TotpEnrollBeginResponse.self, from: data)
    }

    public func totpEnrollConfirm(
        username: String,
        body: TotpEnrollConfirmRequest
    ) async throws -> TotpEnrollConfirmResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/totp/enroll-confirm"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(TotpEnrollConfirmResponse.self, from: data)
    }

    public func totpDisable(
        username: String,
        body: TotpDisableRequest
    ) async throws -> TotpDisableResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(encoded)/totp/disable"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(TotpDisableResponse.self, from: data)
    }

    public func fetchProvisionStatus(serial: String) async throws -> ProvisionStatus? {
        let encoded = serial.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serial
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/order/\(encoded)/status"))
        req.httpMethod = "GET"
        let (data, resp) = try await send(req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        // 404 = no checkpoint has arrived yet ("no status"). A STATE, not
        // an error — map it to nil so the caller renders "waiting for the
        // box to phone home" rather than surfacing a failure.
        if status == 404 { return nil }
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(ProvisionStatus.self, from: data)
    }

    public func listOutstandingOrders(_ req: OutstandingOrdersRequest) async throws -> OutstandingOrdersResponse {
        let encoded = req.request.username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? req.request.username
        let body = try JSONEncoder().encode(req)
        return try await postJsonReturning("/api/users/\(encoded)/outstanding-orders", body: body)
    }
}
