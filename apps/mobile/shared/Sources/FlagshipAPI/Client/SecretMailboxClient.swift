import Foundation

/// Client for the phone-as-unlock-endpoint RELAY mailbox on
/// flagshipserver.com (the Wave-2 endpoints in
/// `packages/control-plane/src/secretMailbox.ts`). `.com` is a blind
/// store-and-forward relay; this client is the phone's push-woken HTTPS
/// half.
///
/// The wire types here are PURE (no crypto) — the FlagshipCore
/// `SecretRequestCoordinator` builds the IRK-signed mailbox auth + the
/// sealed/signed reply (via the `Flagship` crypto layer) and hands the
/// finished bytes to this client. Field names match the Worker handlers'
/// JSON exactly (the iOS-Mock-matches-Worker-wire invariant).
public protocol SecretMailboxClient: Sendable {
    /// POST /api/secret-requests — phone, IRK mailbox-auth. Returns the
    /// account's un-answered pending requests, newest first.
    func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse

    /// POST {boot}/api/boot/response — owner-IRK (the `bootAuth` header).
    /// Posts the sealed reply to the dedicated boot worker, where the box
    /// polls for it. Write-once.
    func postResponse(response: SecretResponseBody, bootAuth: String) async throws

    /// GET /api/server/:domain/sealed-luks-key — returns the LUKS key
    /// sealed FOR the phone (the phone unseals it with its delegated /
    /// BAK / IRK Ed25519 key). 404 → no sealed key on file. Stays on the
    /// identity plane (owner identity-state, set at install).
    func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse

    /// GET /api/users/:u/pods — the directory. The phone resolves the
    /// box's STK INDEPENDENTLY of the mailbox echo from here, so a lying
    /// relay can't get the phone to seal for a box it controls. Identity
    /// plane (canonical id-cert source).
    func fetchPods(username: String) async throws -> PodsDirectoryResponse

    /// GET /api/users/:u/stream?cursor=<hex> — the unified live-update channel
    /// (the hanging GET). A SUPERSET of `/pods` (same `pods`/`pending`) plus an
    /// opaque `cursor`: pass the last cursor, the server returns immediately if
    /// anything meaningful changed (or you sent none / a stale one), else HOLDS
    /// up to ~25s and returns on the next change (or a timeout, same cursor).
    /// Unauthenticated, exactly like `/pods`. The single foreground canal that
    /// feeds AppState (collapsing the many per-screen pollers); the caller falls
    /// back to `fetchPods` if this errors / is unreachable.
    func fetchLiveSync(username: String, cursor: String?) async throws -> LiveSyncResponse

    /// PUT {boot}/api/boot/lease — deposit a box-sealed auto-unlock lease on
    /// the boot worker (owner-IRK via the `bootAuth` header). The `lease`
    /// body keeps its own IRK signature so the box re-verifies it. Enables
    /// "auto"-mode self-unlock; the worker stores ciphertext only (I1).
    func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws

    /// DELETE {boot}/api/boot/lease/:domain/:id — the kill switch (owner-IRK
    /// via `bootAuth`). Drops the lease so the box can no longer self-unlock
    /// — it falls back to phone-gated approval (downgrade, not brick).
    func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws

    /// POST /api/server/:domain/pairing-deposit — phone, IRK mailbox-auth.
    /// Create-time pairing: pre-register a sealed `add-paired-session` order on
    /// `.com` the moment the recipe is minted, so the booting box claims it on
    /// first boot and comes online ALREADY paired (no "Pair this server" tap).
    /// `.com` stores only the OPAQUE sealed blob — it never sees the token (I1).
    func depositPairing(serverDomain: String, body: PairingDepositBody) async throws

    /// POST /api/server/:domain/entitlement-deposit — phone, IRK mailbox-auth.
    /// Fold "authorize to serve" into the first-boot unlock: the phone deposits an
    /// owner-IRK-signed entitlement for the box's STK so it claims it on boot with
    /// no separate tap. `deposit.sealed` is the PUBLIC entitlement carrier (what
    /// the box presents at HELLO), not a secret. Reuses `PairingDepositBody`.
    func depositEntitlement(serverDomain: String, body: PairingDepositBody) async throws

    /// POST /api/server/:domain/decommission — phone, IRK mailbox-auth (the SAME
    /// `DeviceEndpointClaim` shape the self-delete / pairing / entitlement deposits
    /// use). Deposits an owner-IRK-signed `ServerDecommission` eviction order for
    /// the retiring box instance (docs/server-replacement-graceful-decommission.md
    /// §6). `.com` mailbox-auths the depositor as the domain's registered owner,
    /// re-verifies the order under that owner's IRK, and records the eviction so
    /// the box self-retires on its next outbound poll. Throws on non-2xx.
    func depositDecommission(serverDomain: String, body: DecommissionDepositBody) async throws

    /// POST /api/server/:domain/swk-deposit — phone, IRK mailbox-auth. Secret-free
    /// recipe: the recipe carries NO SWK; after the box registers, the phone seals
    /// the SWK to the box's REGISTERED identity and IRK-signs the wrapper, depositing
    /// the sealed carrier here for the box to claim on boot. Reuses `PairingDepositBody`.
    func depositSwk(serverDomain: String, body: PairingDepositBody) async throws

    /// POST /api/server/:domain/cgk-deposit — phone, IRK mailbox-auth. The EXACT
    /// twin of `depositSwk` for the Cloud Gossip Key (per-service leadership Phase
    /// 6): the recipe carries NO CGK; after the box registers, the phone seals the
    /// per-cloud CGK to the box's REGISTERED identity + IRK-signs the wrapper and
    /// deposits the sealed carrier here for the box to claim post-boot. `.com`
    /// holds ciphertext only. Reuses `PairingDepositBody`.
    func depositCgk(serverDomain: String, body: PairingDepositBody) async throws

    /// POST /api/server/:domain/set-leader — phone, IRK mailbox-auth. Deposits the
    /// owner's PUBLIC preferred-server vote (`flagship/set-leader/v1`) addressed to
    /// a box domain. `.com` verifies the owner-IRK signature before storing; the
    /// box fetches the vote meant for it and rides it on its gossip frame (clout).
    /// Uses its own `SetLeaderDepositBody` (the `{auth, deposit, vote, signature}`
    /// shape from the TS rail).
    func depositSetLeader(serverDomain: String, body: SetLeaderDepositBody) async throws
}

/// The set-leader deposit body. `auth`/`authSignature` are the SAME IRK
/// mailbox-auth shape as the other phone-mailbox calls; `deposit` addresses the
/// vote to a box domain; `vote` is the `SetLeaderVote` field set and `signature`
/// is the owner-IRK signature over its canonical bytes. Field names match the
/// Worker handler (`handlePostSetLeaderDeposit`) exactly:
/// `{ auth, authSignature, deposit:{serverDomain,requestNonceHex}, vote:{user,
/// preferredStkPubHex,issuedAt,nonce}, signature }`.
public struct SetLeaderDepositBody: Encodable, Equatable, Sendable {
    public struct Deposit: Encodable, Equatable, Sendable {
        public let serverDomain: String
        public let requestNonceHex: String   // hex (32 bytes)
        public init(serverDomain: String, requestNonceHex: String) {
            self.serverDomain = serverDomain; self.requestNonceHex = requestNonceHex
        }
    }
    public struct Vote: Encodable, Equatable, Sendable {
        public let user: String
        public let preferredStkPubHex: String   // hex (32 bytes) or "none"
        public let issuedAt: Int64
        public let nonce: String
        public init(user: String, preferredStkPubHex: String, issuedAt: Int64, nonce: String) {
            self.user = user; self.preferredStkPubHex = preferredStkPubHex
            self.issuedAt = issuedAt; self.nonce = nonce
        }
    }
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let deposit: Deposit
    public let vote: Vote
    public let signature: String   // hex (64 bytes) — owner IRK over the vote canonical bytes
    public init(
        auth: MailboxAuthEnvelope.Auth, authSignature: String,
        deposit: Deposit, vote: Vote, signature: String
    ) {
        self.auth = auth; self.authSignature = authSignature
        self.deposit = deposit; self.vote = vote; self.signature = signature
    }
}

/// The decommission deposit body. `auth`/`authSignature` are the SAME IRK
/// mailbox-auth shape as the other phone-mailbox calls; `order` is the
/// `ServerDecommission` field set and `signature` is the owner-IRK signature
/// over its canonical bytes. Field names match the Worker handler
/// (`handlePostDecommission`) exactly: `{ auth, authSignature, order, signature }`.
public struct DecommissionDepositBody: Encodable, Equatable, Sendable {
    public struct Order: Encodable, Equatable, Sendable {
        public let podCanonical: String
        public let retiredStkPubHex: String
        public let finalBackup: Bool
        public let diskDisposition: String
        public let backupEpoch: Int64
        public let nonce: String
        public let issuedAt: Int64
        public init(
            podCanonical: String, retiredStkPubHex: String, finalBackup: Bool,
            diskDisposition: String, backupEpoch: Int64, nonce: String, issuedAt: Int64
        ) {
            self.podCanonical = podCanonical; self.retiredStkPubHex = retiredStkPubHex
            self.finalBackup = finalBackup; self.diskDisposition = diskDisposition
            self.backupEpoch = backupEpoch; self.nonce = nonce; self.issuedAt = issuedAt
        }
    }
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let order: Order
    public let signature: String
    public init(auth: MailboxAuthEnvelope.Auth, authSignature: String, order: Order, signature: String) {
        self.auth = auth; self.authSignature = authSignature
        self.order = order; self.signature = signature
    }
}

/// The create-time pairing deposit body. `auth`/`authSignature` are the SAME
/// IRK mailbox-auth shape as the other phone-mailbox calls; `deposit` carries
/// the sealed `{request,signature}` blob (sealed FOR the recipe pairing key the
/// phone embedded). Field names match the Worker handler
/// (`handlePostPairingDeposit`) exactly.
public struct PairingDepositBody: Encodable, Equatable, Sendable {
    public struct Deposit: Encodable, Equatable, Sendable {
        public let serverDomain: String
        public let requestNonceHex: String   // hex (32 bytes)
        public let stkPub: String            // hex (32 bytes) — the pairing key pub (seal recipient)
        public let sealed: String            // hex — sealed `{request,signature}` JSON
        public let issuedAt: Int64
        public init(serverDomain: String, requestNonceHex: String, stkPub: String, sealed: String, issuedAt: Int64) {
            self.serverDomain = serverDomain; self.requestNonceHex = requestNonceHex
            self.stkPub = stkPub; self.sealed = sealed; self.issuedAt = issuedAt
        }
    }
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let deposit: Deposit
    public init(auth: MailboxAuthEnvelope.Auth, authSignature: String, deposit: Deposit) {
        self.auth = auth; self.authSignature = authSignature; self.deposit = deposit
    }
}

// MARK: - Wire types

/// The IRK-signed `DeviceEndpointClaim` mailbox-auth credential + its
/// signature. Mirrors the Worker's `{ auth, authSignature }` body.
public struct MailboxAuthEnvelope: Codable, Equatable, Sendable {
    public struct Auth: Codable, Equatable, Sendable {
        public let username: String
        public let endpointLabel: String
        public let phoneIrkPub: String   // hex (32 bytes) — the account IRK
        public let issuedAt: Int64
        public let expiresAt: Int64
        public let nonce: String         // hex (32 bytes, 64 hex chars)
        public init(
            username: String, endpointLabel: String, phoneIrkPub: String,
            issuedAt: Int64, expiresAt: Int64, nonce: String
        ) {
            self.username = username; self.endpointLabel = endpointLabel
            self.phoneIrkPub = phoneIrkPub; self.issuedAt = issuedAt
            self.expiresAt = expiresAt; self.nonce = nonce
        }
    }
    public let auth: Auth
    public let authSignature: String     // hex (64 bytes) — Ed25519 by the IRK
    public init(auth: Auth, authSignature: String) {
        self.auth = auth; self.authSignature = authSignature
    }
}

/// One pending request as the mailbox returns it. `deviceInfo` is the
/// box's UNSIGNED display hint (ip/region/os) for the "is this my box?"
/// confirm — NOT the boundary. `stkPub` here is the mailbox's ECHO; the
/// phone re-resolves the STK from the directory before trusting it.
public struct PendingSecretRequest: Codable, Equatable, Sendable, Identifiable {
    public let serverDomain: String
    public let requestNonceHex: String
    public let stkPub: String            // hex echo (re-verified vs directory)
    public let purpose: String           // "unlock-key" | "entitlement"
    public let issuedAt: Int64
    public let requestSignature: String  // hex (64 bytes) — STK signature
    public let deviceInfo: DeviceInfoHint?
    public let postedAt: Int64
    public let expiresAt: Int64

    /// Stable id for SwiftUI lists — (domain, nonce) is unique per request.
    public var id: String { "\(serverDomain)#\(requestNonceHex)" }

    public init(
        serverDomain: String, requestNonceHex: String, stkPub: String,
        purpose: String, issuedAt: Int64, requestSignature: String,
        deviceInfo: DeviceInfoHint?, postedAt: Int64, expiresAt: Int64
    ) {
        self.serverDomain = serverDomain; self.requestNonceHex = requestNonceHex
        self.stkPub = stkPub; self.purpose = purpose; self.issuedAt = issuedAt
        self.requestSignature = requestSignature; self.deviceInfo = deviceInfo
        self.postedAt = postedAt; self.expiresAt = expiresAt
    }
}

/// The box's self-reported device-info display hint (the burner / boot
/// stage posts it alongside the SecretRequest). All fields optional — a
/// missing field renders as "—" in the confirm sheet.
public struct DeviceInfoHint: Codable, Equatable, Sendable {
    public let ip: String?
    public let region: String?
    public let os: String?
    public let hostname: String?
    public init(ip: String? = nil, region: String? = nil, os: String? = nil, hostname: String? = nil) {
        self.ip = ip; self.region = region; self.os = os; self.hostname = hostname
    }
}

public struct SecretRequestsResponse: Codable, Equatable, Sendable {
    public let username: String
    public let requests: [PendingSecretRequest]
    public init(username: String, requests: [PendingSecretRequest]) {
        self.username = username; self.requests = requests
    }
}

/// The phone's reply body. `sealed` is the hex of either the
/// SealedSecretResponse's sealed bytes (unlock-key) or the hex-encoded
/// EntitlementBundle JSON carrier (entitlement).
public struct SecretResponseBody: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let requestNonceHex: String
    public let purpose: String
    public let sealed: String   // hex
    public let issuedAt: Int64
    public init(serverDomain: String, requestNonceHex: String, purpose: String, sealed: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.requestNonceHex = requestNonceHex
        self.purpose = purpose; self.sealed = sealed; self.issuedAt = issuedAt
    }
}

public struct SealedLuksKeyResponse: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let sealedKey: String   // hex — sealed FOR the phone
    public let sealedAt: Int64
    public init(serverDomain: String, sealedKey: String, sealedAt: Int64) {
        self.serverDomain = serverDomain; self.sealedKey = sealedKey; self.sealedAt = sealedAt
    }
}

/// The box's STK-signed daemon-status report, relayed VERBATIM by `/pods`
/// (cert-model A′ phase 4 — cert-fingerprint pinning). `.com` stores the
/// exact signed tuple + signature the daemon POSTed and never re-derives it,
/// so a phone that derived the box STK locally re-verifies the leaf-cert
/// fingerprint end-to-end: a rogue `.com` can DROP this block but cannot
/// FORGE one. Field set + canonical bytes mirror
/// `packages/protocol/src/daemonStatus.ts` (pinned cross-platform vector in
/// its test file); verification lives in `FlagshipCore.DaemonStatus`.
public struct DaemonStatusReport: Codable, Equatable, Sendable {
    public let serverDomain: String
    /// Leaf-cert SHA-256 fingerprint: lowercase hex, no colons. Nil when the
    /// box has no cert yet (liveness-only report).
    public let certSha256: String?
    public let certValidUntil: Int64?
    public let certIssuer: String?
    public let appsServed: [String]
    public let nonce: String
    public let issuedAt: Int64

    public init(
        serverDomain: String,
        certSha256: String?,
        certValidUntil: Int64?,
        certIssuer: String?,
        appsServed: [String],
        nonce: String,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.certSha256 = certSha256
        self.certValidUntil = certValidUntil
        self.certIssuer = certIssuer
        self.appsServed = appsServed
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.serverDomain = try c.decode(String.self, forKey: .serverDomain)
        self.certSha256 = try c.decodeIfPresent(String.self, forKey: .certSha256)
        self.certValidUntil = try c.decodeIfPresent(Int64.self, forKey: .certValidUntil)
        self.certIssuer = try c.decodeIfPresent(String.self, forKey: .certIssuer)
        self.appsServed = try c.decodeIfPresent([String].self, forKey: .appsServed) ?? []
        self.nonce = try c.decode(String.self, forKey: .nonce)
        self.issuedAt = try c.decode(Int64.self, forKey: .issuedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case serverDomain, certSha256, certValidUntil, certIssuer, appsServed, nonce, issuedAt
    }
}

/// `signedStatus` on a `/pods` pod: the verbatim report + its Ed25519
/// signature (hex) under the box STK.
public struct SignedDaemonStatus: Codable, Equatable, Sendable {
    public let report: DaemonStatusReport
    public let signatureHex: String
    public init(report: DaemonStatusReport, signatureHex: String) {
        self.report = report
        self.signatureHex = signatureHex
    }
}

/// One un-answered box→owner approval request, from the cheap UNAUTHENTICATED
/// `/pods` digest that drives the Box Request Inbox (docs/box-request-inbox.md).
/// This is the detection tier only: `type` is the secret-request purpose; the
/// full signed request is fetched over the authenticated mailbox path when the
/// owner taps to satisfy it. Mirrors control-plane `PendingRequestSummary`.
public struct PendingRequestSummaryWire: Codable, Equatable, Sendable {
    /// requestNonceHex — the box's reply is keyed by (serverDomain, this).
    public let id: String
    /// Secret-request purpose: "unlock-key" | "entitlement" | …future types.
    public let type: String
    /// issuedAt from the signed SecretRequest (ms).
    public let issuedAt: Int64
    /// Row TTL (ms).
    public let expiresAt: Int64
    public init(id: String, type: String, issuedAt: Int64, expiresAt: Int64) {
        self.id = id; self.type = type
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}

/// A directory entry from GET /api/users/:u/pods. `identityPubKey` is the
/// box's registered STK — the trust anchor the phone re-verifies against.
public struct PodDirectoryEntry: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let identityPubKey: String   // hex (32 bytes) — the STK
    public let revokedAt: Int64?
    /// Wall-clock ms of the box's last daemon-status check-in, or nil if the
    /// daemon has NEVER reported. A registered server with `lastReported ==
    /// nil` AND no cert is a "registered but never came online" box — the
    /// install reserved the name + registered the STK, but the daemon never
    /// reached the cloud. The phone derives `cameOnline` from this client-side
    /// (no backend change needed; the field was already in the /pods response).
    public let lastReported: Int64?
    /// Wall-clock ms the box's registration was admitted (`registeredAt` in the
    /// `/pods` wire response, already present). Threaded onto the client model
    /// so the phone can compute a "coming online" grace window for a box that
    /// registered recently but hasn't checked in yet — distinct from a box
    /// registered long ago that genuinely never came online. nil ⇒ a pre-field
    /// Worker response (defaults to 0 downstream, i.e. no grace).
    public let registeredAt: Int64?
    /// True iff the directory carries a `currentCert` block for this box (the
    /// daemon reported a real cert). Decoded as a presence flag — the cert
    /// detail itself isn't needed to tell a dead box from a live one.
    public let hasCert: Bool
    /// A′ pinning — the STK-signed daemon-status report relayed verbatim,
    /// or nil when the daemon never reported (or `.com` dropped it).
    /// Consumed by `FlagshipCore.CertPinRegistry`; decoded LENIENTLY so a
    /// garbled relay yields nil (⇒ no pin) instead of failing the whole
    /// pods-list decode.
    public let signedStatus: SignedDaemonStatus?
    /// The typed Box Request Inbox digest for this pod (docs/box-request-inbox.md)
    /// — the list of approvals this box is currently asking its owner for
    /// (`unlock-key`, `entitlement`, …future types). The unified client inbox is
    /// the flatMap of this across pods; it replaced the old compat
    /// `awaitingUnlock` / `awaitingEntitlement` booleans (dropped from /pods
    /// once every surface read this). Lenient: absent ⇒ empty.
    public let pendingRequests: [PendingRequestSummaryWire]
    /// HONEST LIVENESS (multi-pod Fix A) — `.com`'s server-authoritative
    /// reachability for this box (`liveness: "live"|"unreachable"|"never"`),
    /// computed from the daemon-status heartbeat against a freshness window.
    /// nil ⇒ a pre-field Worker response that didn't carry it. Decoded as a raw
    /// string (forward-compatible: an unknown future value yields nil rather
    /// than failing the whole pods-list decode).
    public let liveness: String?
    /// Wall-clock ms since the box's last heartbeat (`lastSeenMsAgo`), or nil
    /// when it never checked in / a pre-field Worker.
    public let lastSeenMsAgo: Int64?
    /// Per-service leadership (Phase 6) — the service slugs this box currently
    /// LEADS, relayed verbatim from `/pods` (`leadsServices`). Additive; absent ⇒
    /// empty (a pre-field Worker, or the box leads nothing). Decoded LENIENTLY so
    /// a garbled value yields [] rather than failing the whole pods-list decode.
    public let leadsServices: [String]
    public init(
        serverDomain: String,
        identityPubKey: String,
        revokedAt: Int64? = nil,
        lastReported: Int64? = nil,
        registeredAt: Int64? = nil,
        hasCert: Bool = false,
        signedStatus: SignedDaemonStatus? = nil,
        pendingRequests: [PendingRequestSummaryWire] = [],
        liveness: String? = nil,
        lastSeenMsAgo: Int64? = nil,
        leadsServices: [String] = []
    ) {
        self.serverDomain = serverDomain; self.identityPubKey = identityPubKey
        self.revokedAt = revokedAt; self.lastReported = lastReported
        self.registeredAt = registeredAt; self.hasCert = hasCert
        self.signedStatus = signedStatus
        self.pendingRequests = pendingRequests
        self.liveness = liveness
        self.lastSeenMsAgo = lastSeenMsAgo
        self.leadsServices = leadsServices
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.serverDomain = try c.decode(String.self, forKey: .serverDomain)
        self.identityPubKey = try c.decode(String.self, forKey: .identityPubKey)
        self.revokedAt = try c.decodeIfPresent(Int64.self, forKey: .revokedAt)
        self.lastReported = try c.decodeIfPresent(Int64.self, forKey: .lastReported)
        self.registeredAt = try c.decodeIfPresent(Int64.self, forKey: .registeredAt)
        self.liveness = try c.decodeIfPresent(String.self, forKey: .liveness)
        self.lastSeenMsAgo = try c.decodeIfPresent(Int64.self, forKey: .lastSeenMsAgo)
        self.leadsServices = (try? c.decodeIfPresent([String].self, forKey: .leadsServices)) ?? []
        self.pendingRequests = (try? c.decodeIfPresent([PendingRequestSummaryWire].self, forKey: .pendingRequests)) ?? []
        // `currentCert` is an object-or-null on the wire; decode it as a
        // presence flag (we only need "is there a cert" here).
        let cert = (try? c.decodeIfPresent(CurrentCert.self, forKey: .currentCert)) ?? nil
        self.hasCert = cert != nil
        self.signedStatus = (try? c.decodeIfPresent(SignedDaemonStatus.self, forKey: .signedStatus)) ?? nil
    }

    /// Encode mirrors the wire shape (the presence flag round-trips through a
    /// minimal `currentCert` object). The type is decode-only in practice, but
    /// a custom `init(from:)` suppresses Encodable synthesis, so we provide it.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(serverDomain, forKey: .serverDomain)
        try c.encode(identityPubKey, forKey: .identityPubKey)
        try c.encodeIfPresent(revokedAt, forKey: .revokedAt)
        try c.encodeIfPresent(lastReported, forKey: .lastReported)
        try c.encodeIfPresent(registeredAt, forKey: .registeredAt)
        if hasCert { try c.encode(CurrentCert(sha256: nil), forKey: .currentCert) }
        try c.encodeIfPresent(signedStatus, forKey: .signedStatus)
        try c.encodeIfPresent(liveness, forKey: .liveness)
        try c.encodeIfPresent(lastSeenMsAgo, forKey: .lastSeenMsAgo)
        if !leadsServices.isEmpty { try c.encode(leadsServices, forKey: .leadsServices) }
        if !pendingRequests.isEmpty { try c.encode(pendingRequests, forKey: .pendingRequests) }
    }

    /// `cameOnline` derivation, shared by the reconciler. A box that has
    /// reported daemon status OR holds a cert has come online at least once.
    public var cameOnline: Bool { lastReported != nil || hasCert }

    private struct CurrentCert: Codable, Equatable { let sha256: String? }
    private enum CodingKeys: String, CodingKey {
        case serverDomain, identityPubKey, revokedAt, lastReported, registeredAt, currentCert, signedStatus, pendingRequests, liveness, lastSeenMsAgo, leadsServices
    }
}

/// #56 — an active outstanding install order, surfaced in the SAME
/// unauthenticated `/pods` response as registered servers. A just-created,
/// not-yet-registered server now rides this list instead of the fragile
/// biometric-IRK `outstanding-orders` path, so a list refresh triggers NO
/// Face ID prompt. Mirrors control-plane `PendingPodEntry`.
///
/// `orderRef` — NOT the raw auth-code serial — identifies the order:
/// `hex(sha256("flagship/order-ref/v1|" + serial))` (FlagshipCore.OrderRef).
/// The serial is a provision-status write capability, so it never rides
/// this unauthenticated response; a device that minted the order computes
/// the same ref locally to reconcile, and keeps polling deep install
/// progress with its locally-stored serial.
public struct PendingPodEntry: Codable, Equatable, Sendable {
    /// Opaque sha256 order ref (64 hex chars). Empty if a pre-cutover
    /// Worker response omitted it (mixed-deploy tolerance).
    public let orderRef: String
    public let serverName: String
    /// `<serverName>.<username>.flagship.services` — the reserved FQDN.
    public let fqdn: String
    /// Latest reported provisioning phase, or nil.
    public let phase: String?
    public let createdAt: Int64
    public init(orderRef: String, serverName: String, fqdn: String, phase: String?, createdAt: Int64) {
        self.orderRef = orderRef; self.serverName = serverName
        self.fqdn = fqdn; self.phase = phase; self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.orderRef = try c.decodeIfPresent(String.self, forKey: .orderRef) ?? ""
        self.serverName = try c.decode(String.self, forKey: .serverName)
        self.fqdn = try c.decode(String.self, forKey: .fqdn)
        self.phase = try c.decodeIfPresent(String.self, forKey: .phase)
        self.createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case orderRef, serverName, fqdn, phase, createdAt
    }
}

public struct PodsDirectoryResponse: Codable, Equatable, Sendable {
    public let username: String
    public let pods: [PodDirectoryEntry]
    /// #56 — active outstanding orders, merged into the same fetch. Optional on
    /// the wire so a pre-#56 Worker response (no `pending` key) still decodes.
    public let pending: [PendingPodEntry]
    public init(username: String, pods: [PodDirectoryEntry], pending: [PendingPodEntry] = []) {
        self.username = username; self.pods = pods; self.pending = pending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.username = try c.decode(String.self, forKey: .username)
        self.pods = try c.decode([PodDirectoryEntry].self, forKey: .pods)
        self.pending = try c.decodeIfPresent([PendingPodEntry].self, forKey: .pending) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case username, pods, pending
    }

    /// The STK registered for `serverDomain`, lowercased-domain match.
    /// Returns nil when the directory has no (non-revoked) entry for it —
    /// the coordinator MUST refuse to seal in that case.
    public func identityPubKey(forServerDomain domain: String) -> String? {
        let target = domain.lowercased()
        return pods.first(where: {
            $0.serverDomain.lowercased() == target && $0.revokedAt == nil
        })?.identityPubKey
    }
}

/// The wire shape of `GET /api/users/:u/stream` — the live-update channel. A
/// SUPERSET of `PodsDirectoryResponse` (same `pods`/`pending`) plus the opaque
/// `cursor` the client echoes back to detect change. `pods`/`pending` decode
/// with the SAME lenient rules as `/pods`, so the projection into AppState is
/// identical whether the data arrived via the stream or the fallback fetch.
public struct LiveSyncResponse: Codable, Equatable, Sendable {
    /// Opaque change-detection cursor — store it, echo it back next request.
    public let cursor: String
    public let username: String
    public let pods: [PodDirectoryEntry]
    public let pending: [PendingPodEntry]
    public init(cursor: String, username: String, pods: [PodDirectoryEntry], pending: [PendingPodEntry] = []) {
        self.cursor = cursor; self.username = username; self.pods = pods; self.pending = pending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.cursor = try c.decodeIfPresent(String.self, forKey: .cursor) ?? ""
        self.username = try c.decode(String.self, forKey: .username)
        self.pods = try c.decode([PodDirectoryEntry].self, forKey: .pods)
        self.pending = try c.decodeIfPresent([PendingPodEntry].self, forKey: .pending) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case cursor, username, pods, pending
    }

    /// Project to the `/pods`-shaped directory response the reconciler consumes
    /// (it doesn't need the cursor). Lets the same reconcile path serve both the
    /// live stream and the fallback fetch with no branching.
    public var directory: PodsDirectoryResponse {
        PodsDirectoryResponse(username: username, pods: pods, pending: pending)
    }
}

/// The wire shape of a box-sealed lease deposit body's `lease` object.
/// Field names match the Worker handler (handlePostBoxSealedLease).
public struct BoxSealedLeaseWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let stkPub: String       // hex
    public let leaseId: String
    public let sealedKey: String    // hex
    public let issuedAt: Int64
    public let expiresAt: Int64
    public let maxUses: Int?
    public init(
        serverDomain: String, stkPub: String, leaseId: String, sealedKey: String,
        issuedAt: Int64, expiresAt: Int64, maxUses: Int? = nil
    ) {
        self.serverDomain = serverDomain; self.stkPub = stkPub; self.leaseId = leaseId
        self.sealedKey = sealedKey; self.issuedAt = issuedAt; self.expiresAt = expiresAt
        self.maxUses = maxUses
    }
}

/// The wire shape of a lease-revoke body's `request` object.
public struct LeaseRevokeWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let leaseId: String
    public let issuedAt: Int64
    public init(serverDomain: String, leaseId: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.leaseId = leaseId; self.issuedAt = issuedAt
    }
}

// MARK: - Live

public final class LiveSecretMailboxClient: SecretMailboxClient, @unchecked Sendable {
    /// Control-plane apex + boot sub-origin, derived from `Endpoints`
    /// (prod-default, test-build override). Prod is byte-identical.
    public static var defaultBaseUrl: URL { Endpoints.controlBaseUrl }
    /// The dedicated boot worker — lease deposit/revoke + sealed-response
    /// post land here (identity-gated by the `bootAuth` header). Separate
    /// host so an enterprise clone can self-host boot operations.
    public static var defaultBootBaseUrl: URL { Endpoints.bootBaseUrl }

    private let urlSession: URLSession
    private let baseUrl: URL
    private let bootBaseUrl: URL
    /// A′ pinning — observer invoked with every decoded `/pods` response so
    /// the wiring layer can feed `FlagshipCore.CertPinRegistry`. LIVE-only
    /// by construction (the Mock never calls it ⇒ demo/mock sessions can
    /// never install pins). Pin maintenance must never break the directory
    /// fetch or list rendering, so the registry side never throws.
    private let onPods: (@Sendable (PodsDirectoryResponse) -> Void)?

    public init(
        urlSession: URLSession = .shared,
        baseUrl: URL = defaultBaseUrl,
        bootBaseUrl: URL = defaultBootBaseUrl,
        onPods: (@Sendable (PodsDirectoryResponse) -> Void)? = nil
    ) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
        self.bootBaseUrl = bootBaseUrl
        self.onPods = onPods
    }

    public func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
        // The list is IRK-signed in the body; the Worker exposes it as
        // POST as well as GET (a GET with a body is awkward for URLSession).
        let body = try JSONEncoder().encode(auth)
        return try await postReturning("/api/secret-requests", body: body)
    }

    public func postResponse(response: SecretResponseBody, bootAuth: String) async throws {
        // The boot worker expects `{ response: {...} }` + the owner-IRK
        // Flagship-Boot-v1 Authorization header (the gate authenticates it).
        let body = try JSONEncoder().encode(BootResponsePost(response: response))
        try await sendBoot("POST", "/api/boot/response", body: body, bootAuth: bootAuth, acceptStatuses: [200, 201, 204])
    }

    public func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        return try await getReturning("/api/server/\(encoded)/sealed-luks-key")
    }

    public func fetchPods(username: String) async throws -> PodsDirectoryResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        let response: PodsDirectoryResponse = try await getReturning("/api/users/\(encoded)/pods")
        onPods?(response)
        return response
    }

    public func fetchLiveSync(username: String, cursor: String?) async throws -> LiveSyncResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var path = "/api/users/\(encoded)/stream"
        if let cursor, !cursor.isEmpty {
            let q = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cursor
            path += "?cursor=\(q)"
        }
        // The hanging GET holds up to ~25s server-side; give the request a
        // generous timeout so a healthy hold isn't mistaken for a failure (the
        // caller's loop falls back to /pods on a real error). String-concat the
        // URL so the `?cursor=` query lands verbatim.
        guard let url = URL(string: baseUrl.absoluteString + path) else {
            throw ScreensClientError.http(status: 0, message: "bad stream URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 40
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        let decoded = try JSONDecoder().decode(LiveSyncResponse.self, from: data)
        // Reuse the A′-pin observer path — the stream carries the same
        // `signedStatus` as /pods, so the pin registry stays fed off the canal.
        onPods?(decoded.directory)
        return decoded
    }

    public func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws {
        let body = try JSONEncoder().encode(LeaseDepositPost(lease: lease, signature: signatureHex))
        try await sendBoot("PUT", "/api/boot/lease", body: body, bootAuth: bootAuth, acceptStatuses: [200, 201])
    }

    public func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws {
        // FQDN + hex leaseId are URL-safe, so the literal path matches the
        // path the `bootAuth` signature commits to (the gate binds it exactly).
        let path = "/api/boot/lease/\(request.serverDomain)/\(request.leaseId)"
        try await sendBoot("DELETE", path, body: Data(), bootAuth: bootAuth, acceptStatuses: [200, 204])
    }

    public func depositPairing(serverDomain: String, body: PairingDepositBody) async throws {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        // String-concat the URL (not appendingPathComponent) so the multi-segment
        // control-plane path lands verbatim — mirrors `sendBoot`. The deposit is
        // on `.com` (identity plane), not the boot worker.
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/pairing-deposit") else {
            throw ScreensClientError.http(status: 0, message: "bad pairing-deposit URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    public func depositEntitlement(serverDomain: String, body: PairingDepositBody) async throws {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/entitlement-deposit") else {
            throw ScreensClientError.http(status: 0, message: "bad entitlement-deposit URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    public func depositSwk(serverDomain: String, body: PairingDepositBody) async throws {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/swk-deposit") else {
            throw ScreensClientError.http(status: 0, message: "bad swk-deposit URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    public func depositCgk(serverDomain: String, body: PairingDepositBody) async throws {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/cgk-deposit") else {
            throw ScreensClientError.http(status: 0, message: "bad cgk-deposit URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    public func depositSetLeader(serverDomain: String, body: SetLeaderDepositBody) async throws {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/set-leader") else {
            throw ScreensClientError.http(status: 0, message: "bad set-leader URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    public func depositDecommission(serverDomain: String, body: DecommissionDepositBody) async throws {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/decommission") else {
            throw ScreensClientError.http(status: 0, message: "bad decommission URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    private struct BootResponsePost: Encodable { let response: SecretResponseBody }
    private struct LeaseDepositPost: Encodable { let lease: BoxSealedLeaseWire; let signature: String }

    /// A boot-worker request (POST/PUT/DELETE) with the owner-IRK
    /// `Authorization: Flagship-Boot-v1 …` header. The URL is built by
    /// string concat (not appendingPathComponent) so the path matches the
    /// one the header signature commits to, byte-for-byte.
    private func sendBoot(_ method: String, _ path: String, body: Data, bootAuth: String, acceptStatuses: Set<Int>) async throws {
        guard let url = URL(string: bootBaseUrl.absoluteString + path) else {
            throw ScreensClientError.http(status: 0, message: "bad boot URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(bootAuth, forHTTPHeaderField: "Authorization")
        if !body.isEmpty { req.httpBody = body }
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    /// A POST/DELETE with a JSON body, accepting a set of success statuses.
    private func send(_ method: String, _ path: String, body: Data, acceptStatuses: Set<Int>) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    private func post(_ path: String, body: Data, acceptStatuses: Set<Int>) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    private func postReturning<Resp: Decodable>(_ path: String, body: Data) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    private func getReturning<Resp: Decodable>(_ path: String) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }
}

// MARK: - Mock

/// In-memory mailbox for previews / the unconfigured default. Returns an
/// empty inbox so the approval surface renders the empty state without a
/// network call.
public final class MockSecretMailboxClient: SecretMailboxClient, @unchecked Sendable {
    public var pending: [PendingSecretRequest] = []
    public var directory: [PodDirectoryEntry] = []
    /// #56 — active outstanding orders the merged `/pods` fetch returns.
    public var directoryPending: [PendingPodEntry] = []
    public var sealedLuksKeyHex: String?
    public private(set) var deposited: [(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String)] = []
    public private(set) var revoked: [(request: LeaseRevokeWire, bootAuth: String)] = []
    public private(set) var postedResponses: [(response: SecretResponseBody, bootAuth: String)] = []
    public init() {}

    public func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
        SecretRequestsResponse(username: auth.auth.username, requests: pending)
    }
    public func postResponse(response: SecretResponseBody, bootAuth: String) async throws {
        postedResponses.append((response, bootAuth))
    }
    public func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
        guard let hex = sealedLuksKeyHex else {
            throw ScreensClientError.http(status: 404, message: "no sealed key on file")
        }
        return SealedLuksKeyResponse(serverDomain: serverDomain, sealedKey: hex, sealedAt: 1)
    }
    public func fetchPods(username: String) async throws -> PodsDirectoryResponse {
        PodsDirectoryResponse(username: username, pods: directory, pending: directoryPending)
    }

    /// Scripted live-sync responses for tests: each `fetchLiveSync` call pops the
    /// next entry; once exhausted it returns a DETERMINISTIC snapshot built from
    /// `directory`/`directoryPending` with a content-stable cursor (so a loop
    /// keeps a stable cursor and never hangs). Set `liveSyncError` to make the
    /// next call throw (exercising the /pods fallback).
    public var liveSyncScript: [LiveSyncResponse] = []
    public var liveSyncError: Error?
    /// Cursors observed across calls — lets a test assert the cursor is echoed.
    public private(set) var liveSyncCursors: [String?] = []

    public func fetchLiveSync(username: String, cursor: String?) async throws -> LiveSyncResponse {
        liveSyncCursors.append(cursor)
        if let err = liveSyncError {
            liveSyncError = nil
            throw err
        }
        if !liveSyncScript.isEmpty {
            return liveSyncScript.removeFirst()
        }
        // Deterministic fallback snapshot — a content-stable cursor so a steady
        // state holds the same cursor (no churn) and the test loop terminates.
        let stableCursor = "mock-\(directory.count)-\(directoryPending.count)"
        return LiveSyncResponse(
            cursor: stableCursor, username: username,
            pods: directory, pending: directoryPending
        )
    }

    public func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws {
        deposited.append((lease, signatureHex, bootAuth))
    }
    public func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws {
        revoked.append((request, bootAuth))
    }
    public private(set) var pairingDeposits: [(serverDomain: String, body: PairingDepositBody)] = []
    public func depositPairing(serverDomain: String, body: PairingDepositBody) async throws {
        pairingDeposits.append((serverDomain, body))
    }
    public private(set) var entitlementDeposits: [(serverDomain: String, body: PairingDepositBody)] = []
    public func depositEntitlement(serverDomain: String, body: PairingDepositBody) async throws {
        entitlementDeposits.append((serverDomain, body))
    }
    public private(set) var swkDeposits: [(serverDomain: String, body: PairingDepositBody)] = []
    /// When set, `depositSwk` throws it once (to exercise best-effort/retry paths).
    public var swkDepositError: Error?
    public func depositSwk(serverDomain: String, body: PairingDepositBody) async throws {
        if let e = swkDepositError {
            swkDepositError = nil
            throw e
        }
        swkDeposits.append((serverDomain, body))
    }
    public private(set) var cgkDeposits: [(serverDomain: String, body: PairingDepositBody)] = []
    /// When set, `depositCgk` throws it once (to exercise best-effort/retry paths).
    public var cgkDepositError: Error?
    public func depositCgk(serverDomain: String, body: PairingDepositBody) async throws {
        if let e = cgkDepositError {
            cgkDepositError = nil
            throw e
        }
        cgkDeposits.append((serverDomain, body))
    }
    public private(set) var setLeaderDeposits: [(serverDomain: String, body: SetLeaderDepositBody)] = []
    /// When set, `depositSetLeader` throws it once.
    public var setLeaderDepositError: Error?
    public func depositSetLeader(serverDomain: String, body: SetLeaderDepositBody) async throws {
        if let e = setLeaderDepositError {
            setLeaderDepositError = nil
            throw e
        }
        setLeaderDeposits.append((serverDomain, body))
    }
    /// Optional error to throw on the next `depositDecommission`, then cleared.
    public var nextDecommissionError: Error?
    public private(set) var decommissionDeposits: [(serverDomain: String, body: DecommissionDepositBody)] = []
    public func depositDecommission(serverDomain: String, body: DecommissionDepositBody) async throws {
        if let e = nextDecommissionError { nextDecommissionError = nil; throw e }
        decommissionDeposits.append((serverDomain, body))
    }
}
