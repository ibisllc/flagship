import Foundation

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
    func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse
    func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse
    func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope
    /// Register an APNs device token with .com so the Worker can relay
    /// (or retry) encrypted push payloads to this device. The returned
    /// tokenId is the handle to later revoke the registration.
    func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse
    /// Drop a previously-registered push token. 404 (already gone) is
    /// treated as success by both Mock + Live implementations so a
    /// sign-out path doesn't surface "already cleaned up" as an error.
    func revokePushToken(tokenId: String) async throws
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
        appId: String,
        body: AppRenameRequest
    ) async throws -> AppRenameResponse

    /// V2 — read the per-user URL identity of an app: { displayLabel,
    /// canonical, instances[] }. Public read; falls back to the
    /// slug-creator default when no alias has been set.
    func getAppLinks(
        username: String,
        appId: String
    ) async throws -> AppLinksResponse

    /// Bind an external domain to the app (the fqdn-service-binding
    /// order). Replaces any existing one. Returns the refreshed links
    /// so callers can reflect it immediately. The real routing-claim +
    /// cert path is the staged backend; today the Mock stores it and
    /// the Live client reports it's not yet available.
    func setCustomDomain(
        username: String,
        appId: String,
        fqdn: String
    ) async throws -> AppLinksResponse
}

public struct AppRenameRequest: Encodable, Sendable {
    public struct Inner: Encodable, Sendable {
        public let username: String
        public let appId: String
        public let newDisplayLabel: String
        public let issuedAt: Int64
        public init(username: String, appId: String, newDisplayLabel: String, issuedAt: Int64) {
            self.username = username
            self.appId = appId
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
    public let appId: String
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
    public let customDomainConfirmed: Bool?
    /// Unix seconds of the last custom-domain request. Sourced from
    /// the server so the rate-limit countdown survives an app reload
    /// / VM recreation (the cooldown is reconstructed from this).
    public let customDomainLastChangedAt: Double?
    public init(
        appId: String,
        displayLabel: String,
        canonicalUrl: String,
        instances: [AppLinkInstance],
        shortUrl: String?,
        customDomain: String? = nil,
        customDomainConfirmed: Bool? = nil,
        customDomainLastChangedAt: Double? = nil
    ) {
        self.appId = appId
        self.displayLabel = displayLabel
        self.canonicalUrl = canonicalUrl
        self.instances = instances
        self.shortUrl = shortUrl
        self.customDomain = customDomain
        self.customDomainConfirmed = customDomainConfirmed
        self.customDomainLastChangedAt = customDomainLastChangedAt
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
    public let request: Inner
    public let signature: String      // hex; Ed25519 over canonical-bytes by NEW IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
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

    public var id: String { tokenId }

    public init(tokenId: String, tokenPrefix: String, label: String, platform: String, addedAt: Int64, lastSeenAt: Int64) {
        self.tokenId = tokenId; self.tokenPrefix = tokenPrefix
        self.label = label; self.platform = platform
        self.addedAt = addedAt; self.lastSeenAt = lastSeenAt
    }
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
    public init(username: String, available: Bool, reason: String?, testAccount: TestAccountMeta? = nil) {
        self.username = username; self.available = available; self.reason = reason
        self.testAccount = testAccount
    }
}

public struct TestAccountMeta: Codable, Equatable, Sendable {
    public let display: String
    public let ttlHours: Int
    public init(display: String, ttlHours: Int = 24) {
        self.display = display; self.ttlHours = ttlHours
    }
}

public struct RecoveryEnvelopeRequest: Codable, Equatable, Sendable {
    public let credentialId: String
    public let wrappedUmkBase64: String
    public let nonceBase64: String
    public init(credentialId: String, wrappedUmkBase64: String, nonceBase64: String) {
        self.credentialId = credentialId
        self.wrappedUmkBase64 = wrappedUmkBase64
        self.nonceBase64 = nonceBase64
    }
}

public struct RecoveryEnvelopeResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
}

public struct RecoveryEnvelope: Codable, Equatable, Sendable {
    public let credentialId: String
    public let wrappedUmkBase64: String
    public let nonceBase64: String
    public init(credentialId: String, wrappedUmkBase64: String, nonceBase64: String) {
        self.credentialId = credentialId
        self.wrappedUmkBase64 = wrappedUmkBase64
        self.nonceBase64 = nonceBase64
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
    private var recoveryStore: [String: RecoveryEnvelope] = [:]

    /// Tracks usernames that have been claimed so the mock can return
    /// 409 on a second different-IRK claim (idempotent under same IRK).
    public private(set) var claimedUsernames: [String: String] = [:]   // username → irkPub
    public private(set) var issuedAuthCodes: [String: AuthCodeWire] = [:]   // serial → wire
    public private(set) var revokedAuthCodes: Set<String> = []        // serial set
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

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        try await tick()
        let lower = username.lowercased()
        // Test-account match precedes every other rule so a value
        // that would otherwise look invalid still surfaces the
        // testAccount block (Worker side does the same).
        if let meta = testAccounts[lower] {
            return .init(username: lower, available: false, reason: "test account", testAccount: meta)
        }
        // Username rules. Mirrors the Worker's USERNAME_RE in
        // labels.ts so the Mock's wire shape (reason strings +
        // ordering) matches what a real Worker would return — keep
        // these in sync. NO hyphens (alphanumerics only).
        let usernameRe = "^[a-z0-9]{1,63}$"
        if lower.range(of: usernameRe, options: .regularExpression) == nil {
            return .init(
                username: lower,
                available: false,
                reason: "username must be 1–63 lowercase letters or digits (no hyphens)"
            )
        }
        if reservedUsernames.contains(lower) {
            return .init(
                username: lower,
                available: false,
                reason: "username \"\(lower)\" is reserved"
            )
        }
        if let prior = claimedUsernames[lower], prior != "_self" {
            return .init(username: lower, available: false, reason: "already claimed")
        }
        return .init(username: lower, available: true, reason: nil)
    }

    public func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse {
        try await tick()
        recoveryStore[req.credentialId] = RecoveryEnvelope(
            credentialId: req.credentialId,
            wrappedUmkBase64: req.wrappedUmkBase64,
            nonceBase64: req.nonceBase64
        )
        return RecoveryEnvelopeResponse(ok: true)
    }

    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        try await tick()
        if let env = recoveryStore[credentialId] { return env }
        throw ScreensClientError.http(status: 404, message: "no envelope")
    }

    public func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse {
        try await tick()
        let id = String(format: "tok_%06d", nextPushTokenId); nextPushTokenId += 1
        registeredPushTokens[id] = req.request
        return PushTokenRegisterResponse(ok: true, tokenId: id)
    }

    public func revokePushToken(tokenId: String) async throws {
        try await tick()
        // 404 is intentionally success: revoking an already-revoked
        // (or never-registered) token shouldn't fail the caller's
        // sign-out flow.
        registeredPushTokens.removeValue(forKey: tokenId)
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
        appId: String,
        body: AppRenameRequest
    )?
    /// Scripted alias map per (username, appId). The links endpoint
    /// returns these; the rename endpoint writes into them.
    public var appAliasByUser: [String: [String: (displayLabel: String, canonicalUrl: String)]] = [:]
    /// Bound external domains, keyed [user][appId]. A Replace never
    /// clears this — it's deliberately a separate store from aliases.
    public var customDomainByUser: [String: [String: String]] = [:]
    /// Server-side rate limit mirror: [user][appId] → last change.
    public var customDomainLastChangedByUser: [String: [String: Date]] = [:]
    /// Min seconds between custom-domain changes (server-enforced).
    public var customDomainMinInterval: TimeInterval = 300
    /// Demo only: how long after a request the Mock pretends .com
    /// finished the out-of-band CNAME verification. A real server
    /// pushes the outcome; the Mock just flips confirmed after this.
    public var customDomainConfirmDelay: TimeInterval = 6

    public func renameApp(
        username: String,
        appId: String,
        body: AppRenameRequest
    ) async throws -> AppRenameResponse {
        try await tick()
        lastAppRename = (username, appId, body)
        switch appRenameBehavior {
        case .collision:
            throw ScreensClientError.http(status: 409, message: "label collision")
        case .staleSignature:
            throw ScreensClientError.http(status: 403, message: "bad signature")
        case .ok:
            let newLabel = body.request.newDisplayLabel
            let canonical = "https://\(newLabel).\(username.lowercased()).flagship.services"
            appAliasByUser[username.lowercased(), default: [:]][appId] = (newLabel, canonical)
            return AppRenameResponse(
                ok: true,
                displayLabel: newLabel,
                canonicalUrl: canonical,
                shortUrl: "https://voi.ci/\(synthesizeMockShortCode(forAppId: appId, label: newLabel))",
                shortCode: synthesizeMockShortCode(forAppId: appId, label: newLabel),
                unchanged: false
            )
        }
    }

    public func getAppLinks(
        username: String,
        appId: String
    ) async throws -> AppLinksResponse {
        try await tick()
        let alias = appAliasByUser[username.lowercased()]?[appId]
        // Mirrors @flagship/protocol deriveUrlFragment: appId is
        // `<creator>-<slug>` (single dash; FIRST hyphen splits, since
        // usernames are hyphen-free). The fragment is CONDITIONAL on
        // who runs it: just `<slug>` when the running user authored
        // it, else `<slug>-<creator>`.
        let defaultLabel: String = {
            if let i = appId.firstIndex(of: "-"),
               i != appId.startIndex,
               appId.index(after: i) != appId.endIndex {
                let creator = appId[appId.startIndex..<i].lowercased()
                let slug = String(appId[appId.index(after: i)...]).lowercased()
                return creator == username.lowercased() ? slug : "\(slug)-\(creator)"
            }
            return appId.lowercased()
        }()
        let label = alias?.displayLabel ?? defaultLabel
        let host = "\(username.lowercased()).flagship.services"
        let canonical = alias?.canonicalUrl ?? "https://\(label).\(host)"
        // V6 — Mock now mirrors the Worker's lazy-mint contract:
        // /links always returns a populated shortUrl. The code is a
        // deterministic 6-char hex prefix of appId so the same app
        // surfaces the same link across calls (so a copy-paste in
        // demo mode is stable + previews stay snapshot-friendly).
        let shortCode = synthesizeMockShortCode(forAppId: appId, label: label)
        let lastChanged = customDomainLastChangedByUser[username.lowercased()]?[appId]
        // Demo: .com "confirms" the CNAME customDomainConfirmDelay
        // seconds after the request (a real server pushes the outcome).
        let confirmed = lastChanged.map {
            Date().timeIntervalSince($0) >= customDomainConfirmDelay
        }
        return AppLinksResponse(
            appId: appId,
            displayLabel: label,
            canonicalUrl: canonical,
            instances: [
                AppLinkInstance(
                    serverDomain: host,
                    url: canonical
                ),
            ],
            shortUrl: "https://voi.ci/\(shortCode)",
            customDomain: customDomainByUser[username.lowercased()]?[appId],
            customDomainConfirmed: confirmed,
            customDomainLastChangedAt: lastChanged?.timeIntervalSince1970
        )
    }

    public func setCustomDomain(
        username: String,
        appId: String,
        fqdn: String
    ) async throws -> AppLinksResponse {
        try await tick()
        let u = username.lowercased()
        // Server-side rate limit (the lastChanged column). The client
        // mirrors this with a cooldown, but the server is the backstop.
        if let last = customDomainLastChangedByUser[u]?[appId] {
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
        // exercise a real failure path).
        customDomainByUser[u, default: [:]][appId] =
            fqdn.trimmingCharacters(in: .whitespaces).lowercased()
        customDomainLastChangedByUser[u, default: [:]][appId] = Date()
        return try await getAppLinks(username: username, appId: appId)
    }

    /// FNV-1a over (appId|label) → first 6 hex digits, lowercased.
    /// Deterministic + stable across calls; not crypto-strong (it
    /// only feeds the Mock surface). The Worker's mintShortLink
    /// uses crypto.getRandomValues so production codes are random.
    private static func synthesizeMockShortCode(forAppId appId: String, label: String) -> String {
        var h: UInt64 = 14695981039346656037
        for byte in (appId + "|" + label).utf8 {
            h ^= UInt64(byte)
            h &*= 1099511628211
        }
        let hex = String(h, radix: 16)
        // 6 chars; pad with the appId hash's own bits if short.
        return String((hex + "000000").prefix(6))
    }

    private func synthesizeMockShortCode(forAppId appId: String, label: String) -> String {
        Self.synthesizeMockShortCode(forAppId: appId, label: label)
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
}

// MARK: - Live

public final class LiveFlagshipServerClient: FlagshipServerClient, @unchecked Sendable {
    public static let defaultBaseUrl = URL(string: "https://flagshipserver.com")!

    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    private func postJson(_ path: String, body: Data, acceptStatuses: Set<Int> = [200, 201, 204]) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
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
        let (data, resp) = try await urlSession.data(for: req)
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

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        let body = try JSONEncoder().encode(["username": username])
        return try await postJsonReturning("/api/users/check", body: body)
    }

    public func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse {
        let body = try JSONEncoder().encode(req)
        return try await postJsonReturning("/api/recovery/register", body: body)
    }

    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/recovery/fetch"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "credentialId", value: credentialId)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RecoveryEnvelope.self, from: data)
    }

    public func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse {
        let body = try JSONEncoder().encode(req)
        return try await postJsonReturning("/api/push/register", body: body)
    }

    public func revokePushToken(tokenId: String) async throws {
        let encoded = tokenId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tokenId
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/push/\(encoded)"))
        req.httpMethod = "DELETE"
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200 || status == 204 || status == 404 { return }
        let text = String(data: data, encoding: .utf8) ?? ""
        throw ScreensClientError.http(status: status, message: text)
    }

    public func getInstallEvents(serial: String, since: Int) async throws -> InstallEventsPollResponse {
        let encoded = serial.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serial
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/install-events/\(encoded)"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "since", value: String(since))]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
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
        let (data, resp) = try await urlSession.data(for: req)
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
        let (data, resp) = try await urlSession.data(for: req)
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
        let (data, resp) = try await urlSession.data(for: req)
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
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RePairCompleteResponse.self, from: data)
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
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(WipeRestartResponse.self, from: data)
    }

    public func renameApp(
        username: String,
        appId: String,
        body: AppRenameRequest
    ) async throws -> AppRenameResponse {
        let u = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let a = appId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? appId
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(u)/apps/\(a)/rename"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AppRenameResponse.self, from: data)
    }

    public func getAppLinks(
        username: String,
        appId: String
    ) async throws -> AppLinksResponse {
        let u = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let a = appId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? appId
        var req = URLRequest(url: baseUrl.appendingPathComponent("/api/users/\(u)/apps/\(a)/links"))
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AppLinksResponse.self, from: data)
    }

    public func setCustomDomain(
        username: String,
        appId: String,
        fqdn: String
    ) async throws -> AppLinksResponse {
        // The routing-claim + fleet-cert binding is the staged backend
        // (see project_external_domains memory / task #79). No live
        // endpoint yet — fail clearly rather than pretend success.
        _ = (username, appId, fqdn)
        throw ScreensClientError.http(
            status: 501,
            message: "Custom-domain binding isn't available yet."
        )
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
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(AuditEventListResponse.self, from: data)
    }
}
