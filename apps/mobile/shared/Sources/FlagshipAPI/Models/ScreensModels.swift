// Flagship `/api/screens/*` BFF contract — Swift mirror.
//
// MIRRORS: packages/server-daemon/src/screens/types.ts
// When the daemon's BFF contract changes, update this file in lockstep.
// Keep field names + JSON keys identical; native callers depend on
// `Codable` round-tripping with the daemon's `JSON.stringify(...)` output.

import Foundation

// MARK: - Shared

public struct AppSummary: Codable, Equatable, Sendable {
    public let serviceId: String
    public let creator: String
    public let slug: String
    public let urlLabel: String
    public let summary: String?
    public let url: String
    public let status: String   // "running" | "stopped" | "unknown"
    public let version: String?
    public let installedAt: Int64
}

public struct RecentInstallEvent: Codable, Equatable, Sendable {
    public let at: Int64
    public let kind: String     // "installed" | "uninstalled" | "deploy" | "update-pulled"
    public let serviceId: String
    public let detail: String?
}

// MARK: - P1.1 server-detail

public struct ServerDetailResponse: Codable, Equatable, Sendable {
    public let serverFqdn: String
    public let username: String
    public let daemonVersion: String
    public let startedAt: Int64
    public let uptimeMs: Int64
    public let certNotAfter: Int64?
    public let certNotBefore: Int64?
    public let certSans: [String]?
    public let serviceCount: Int
    public let pairedSessionCount: Int
    public let recentInstallEvents: [RecentInstallEvent]
}

// MARK: - P1.2 apps-list

public struct AppsListResponse: Codable, Equatable, Sendable {
    public let apps: [AppSummary]
}

// MARK: - P1.3 app-detail

public struct AppDetailResponse: Codable {
    public let app: AppSummary
    public let manifest: [String: AnyCodable]
    public let dataLayerInstances: [DataLayerInstance]
    public let members: [AppMember]
    public let browserTabs: [BrowserTabRef]
    public let lastBackup: BackupSummary?
    public let recentLogs: [String]

    public struct DataLayerInstance: Codable, Equatable {
        public let store: String
        public let instanceName: String
    }
    public struct AppMember: Codable, Equatable {
        public let stableIdPrefix: String
        public let role: String
        public let addedAt: Int64
    }
    public struct BrowserTabRef: Codable, Equatable {
        public let tabId: String
    }
    public struct BackupSummary: Codable, Equatable {
        public let backupId: String
        public let createdAt: Int64
        public let bytes: Int64
    }
}

// MARK: - P1.5 vibe-code/start

public struct VibeCodeStartRequest: Codable, Equatable, Sendable {
    public let prompt: String
    public let model: String?
    public init(prompt: String, model: String?) {
        self.prompt = prompt
        self.model = model
    }
}

public struct VibeCodeStartResponse: Codable, Equatable, Sendable {
    public let sessionId: String
}

// MARK: - P1.6 vibe-code/:id/stream (WS frames)

public enum VibeCodeFrame: Codable, Equatable {
    case token(text: String)
    case manifestEmit(manifestJson: String)
    case repoCreate(repoFullName: String)
    case buildStart
    case buildLog(line: String)
    case deploy(serviceId: String, url: String)
    case done
    case error(message: String)

    private enum CodingKeys: String, CodingKey { case kind, text, manifestJson, repoFullName, line, serviceId, url, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "token": self = .token(text: try c.decode(String.self, forKey: .text))
        case "manifest-emit": self = .manifestEmit(manifestJson: try c.decode(String.self, forKey: .manifestJson))
        case "repo-create": self = .repoCreate(repoFullName: try c.decode(String.self, forKey: .repoFullName))
        case "build-start": self = .buildStart
        case "build-log": self = .buildLog(line: try c.decode(String.self, forKey: .line))
        case "deploy":
            self = .deploy(
                serviceId: try c.decode(String.self, forKey: .serviceId),
                url: try c.decode(String.self, forKey: .url)
            )
        case "done": self = .done
        case "error": self = .error(message: try c.decode(String.self, forKey: .message))
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind: \(other)")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .token(let t): try c.encode("token", forKey: .kind); try c.encode(t, forKey: .text)
        case .manifestEmit(let m): try c.encode("manifest-emit", forKey: .kind); try c.encode(m, forKey: .manifestJson)
        case .repoCreate(let r): try c.encode("repo-create", forKey: .kind); try c.encode(r, forKey: .repoFullName)
        case .buildStart: try c.encode("build-start", forKey: .kind)
        case .buildLog(let l): try c.encode("build-log", forKey: .kind); try c.encode(l, forKey: .line)
        case .deploy(let a, let u): try c.encode("deploy", forKey: .kind); try c.encode(a, forKey: .serviceId); try c.encode(u, forKey: .url)
        case .done: try c.encode("done", forKey: .kind)
        case .error(let m): try c.encode("error", forKey: .kind); try c.encode(m, forKey: .message)
        }
    }
}

// MARK: - P1.7 vibe-code/:id status

public struct VibeCodeStatusResponse: Codable {
    public let status: String   // "streaming" | "ready-to-deploy" | "deploying" | "deployed" | "failed" | "cancelled"
    public let transcript: [TranscriptEntry]
    public let files: [String: String]
    public let deployedUrl: String?
    public let errorReason: String?

    public struct TranscriptEntry: Codable, Equatable {
        public let role: String  // "user" | "assistant"
        public let content: String
    }
}

// MARK: - P1.10 / P1.11 browser-tabs

public struct BrowserTab: Codable, Equatable, Sendable {
    public let tabId: String
    public let serviceId: String
    public let currentUrl: String?
    public let title: String?
    public let screenshotKey: String?
    public let needsField: String?  // "password" | "text" | "code"
}

public struct BrowserTabsListResponse: Codable, Equatable, Sendable {
    public let tabs: [BrowserTab]
}

// MARK: - P1.12 / P1.13 paired-sessions

public struct PairedSessionSummary: Codable, Equatable, Sendable {
    public let tokenPrefix: String
    public let label: String
    public let addedAt: Int64
    public let current: Bool
}

public struct PairedSessionsListResponse: Codable, Equatable, Sendable {
    public let sessions: [PairedSessionSummary]
}

// MARK: - P1.14 orders/send

public struct OrdersSendRequest: Codable, Equatable, Sendable {
    public let envelope: String   // base64
    public let kind: String
    public init(envelope: String, kind: String) {
        self.envelope = envelope
        self.kind = kind
    }
}

public struct OrdersSendResponse: Codable {
    public let ok: Bool
    public let response: [String: AnyCodable]?
}

// MARK: - P1.15 install-events (SSE)

public enum InstallEvent: Codable, Equatable {
    case registered(serial: String, at: Int64)
    case boot(at: Int64)
    case tunnelOnline(at: Int64)
    case certIssued(at: Int64)
    case ready(serverFqdn: String, at: Int64)
    case failed(reason: String, at: Int64)

    private enum CodingKeys: String, CodingKey { case kind, serial, at, serverFqdn, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let at = try c.decode(Int64.self, forKey: .at)
        switch try c.decode(String.self, forKey: .kind) {
        case "registered": self = .registered(serial: try c.decode(String.self, forKey: .serial), at: at)
        case "boot": self = .boot(at: at)
        case "tunnel-online": self = .tunnelOnline(at: at)
        case "cert-issued": self = .certIssued(at: at)
        case "ready": self = .ready(serverFqdn: try c.decode(String.self, forKey: .serverFqdn), at: at)
        case "failed": self = .failed(reason: try c.decode(String.self, forKey: .reason), at: at)
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind: \(other)")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .registered(let s, let at):
            try c.encode("registered", forKey: .kind); try c.encode(s, forKey: .serial); try c.encode(at, forKey: .at)
        case .boot(let at): try c.encode("boot", forKey: .kind); try c.encode(at, forKey: .at)
        case .tunnelOnline(let at): try c.encode("tunnel-online", forKey: .kind); try c.encode(at, forKey: .at)
        case .certIssued(let at): try c.encode("cert-issued", forKey: .kind); try c.encode(at, forKey: .at)
        case .ready(let f, let at):
            try c.encode("ready", forKey: .kind); try c.encode(f, forKey: .serverFqdn); try c.encode(at, forKey: .at)
        case .failed(let r, let at):
            try c.encode("failed", forKey: .kind); try c.encode(r, forKey: .reason); try c.encode(at, forKey: .at)
        }
    }

    /// Returns a copy with the timestamp replaced — used by mock
    /// streaming so emitted events carry the real wall-clock time.
    public func restamped(_ at: Int64) -> InstallEvent {
        switch self {
        case .registered(let s, _): return .registered(serial: s, at: at)
        case .boot:                  return .boot(at: at)
        case .tunnelOnline:          return .tunnelOnline(at: at)
        case .certIssued:            return .certIssued(at: at)
        case .ready(let f, _):       return .ready(serverFqdn: f, at: at)
        case .failed(let r, _):      return .failed(reason: r, at: at)
        }
    }
}

// MARK: - P1.16 tier-status

public struct TierStatusResponse: Codable, Equatable, Sendable {
    public let tier: String   // "free" | "promo" | "byok"
    public let llmCreditsRemainingDay: Int64?
    public let llmCreditsRemainingTotal: Int64?
    public let dispatcherUsageGBmonth: Double?
    public let dispatcherFreeQuotaGBmonth: Double?
    public let customDomains: [String]
    public let reservedNames: [String]

    public init(
        tier: String,
        llmCreditsRemainingDay: Int64?,
        llmCreditsRemainingTotal: Int64?,
        dispatcherUsageGBmonth: Double?,
        dispatcherFreeQuotaGBmonth: Double?,
        customDomains: [String],
        reservedNames: [String]
    ) {
        self.tier = tier
        self.llmCreditsRemainingDay = llmCreditsRemainingDay
        self.llmCreditsRemainingTotal = llmCreditsRemainingTotal
        self.dispatcherUsageGBmonth = dispatcherUsageGBmonth
        self.dispatcherFreeQuotaGBmonth = dispatcherFreeQuotaGBmonth
        self.customDomains = customDomains
        self.reservedNames = reservedNames
    }
}

// MARK: - P1.17 / P1.18 url-controller

public struct OwnedUrl: Codable, Equatable, Sendable {
    public let fqdn: String
    public let kind: String   // "canonical" | "alias" | "custom"
    public let claimedAt: Int64
}

public struct UrlControllerOwnedResponse: Codable, Equatable, Sendable {
    public let urls: [OwnedUrl]
}

public struct UrlControllerClaimRequest: Codable, Equatable, Sendable {
    public let fqdn: String
    public init(fqdn: String) { self.fqdn = fqdn }
}

public struct UrlControllerClaimResponse: Codable, Equatable, Sendable {
    public let ok: Bool
}

// MARK: - P1.22 custom-domain verify (extension)

public struct VerifyCustomDomainRequest: Codable, Equatable, Sendable {
    public let fqdn: String
    public init(fqdn: String) { self.fqdn = fqdn }
}

public struct VerifyCustomDomainResponse: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case pending, verified, failed }
    public let fqdn: String
    public let status: Status
    public let expectedTxtRecord: String   // _flagship.<fqdn> TXT value the daemon expects
    public let observedTxtRecord: String?  // what DNS actually returned, if anything
    public let reason: String?
    public init(fqdn: String, status: Status, expectedTxtRecord: String, observedTxtRecord: String?, reason: String?) {
        self.fqdn = fqdn
        self.status = status
        self.expectedTxtRecord = expectedTxtRecord
        self.observedTxtRecord = observedTxtRecord
        self.reason = reason
    }
}

// MARK: - P1.21 server-metrics (extension; not yet daemon-side)
//
// Returns the current instantaneous resource numbers plus a 60-sample
// trailing window at 1-minute granularity for the things the daemon
// can cheaply expose (CPU%, mem, disk, I/O, network). The contract
// is iOS-driven for now; daemon implementation will follow.

public struct ServerMetricsResponse: Codable, Equatable, Sendable {
    public let collectedAt: Int64
    public let cpuPercent: Double           // 0–100, instantaneous
    public let loadAvg1: Double
    public let loadAvg5: Double
    public let loadAvg15: Double
    public let memUsedBytes: Int64
    public let memTotalBytes: Int64
    public let diskUsedBytes: Int64
    public let diskTotalBytes: Int64
    public let diskIOReadBytesPerSec: Double
    public let diskIOWriteBytesPerSec: Double
    public let netRxBytesPerSec: Double
    public let netTxBytesPerSec: Double
    public let cpuHistory: [TimedSample]    // up to 60 samples, 1-min interval
    public let memHistory: [TimedSample]    // bytes used over time
    public let ioHistory: [IOSample]
    public let netHistory: [IOSample]

    public init(
        collectedAt: Int64,
        cpuPercent: Double,
        loadAvg1: Double, loadAvg5: Double, loadAvg15: Double,
        memUsedBytes: Int64, memTotalBytes: Int64,
        diskUsedBytes: Int64, diskTotalBytes: Int64,
        diskIOReadBytesPerSec: Double, diskIOWriteBytesPerSec: Double,
        netRxBytesPerSec: Double, netTxBytesPerSec: Double,
        cpuHistory: [TimedSample], memHistory: [TimedSample],
        ioHistory: [IOSample], netHistory: [IOSample]
    ) {
        self.collectedAt = collectedAt
        self.cpuPercent = cpuPercent
        self.loadAvg1 = loadAvg1; self.loadAvg5 = loadAvg5; self.loadAvg15 = loadAvg15
        self.memUsedBytes = memUsedBytes; self.memTotalBytes = memTotalBytes
        self.diskUsedBytes = diskUsedBytes; self.diskTotalBytes = diskTotalBytes
        self.diskIOReadBytesPerSec = diskIOReadBytesPerSec
        self.diskIOWriteBytesPerSec = diskIOWriteBytesPerSec
        self.netRxBytesPerSec = netRxBytesPerSec
        self.netTxBytesPerSec = netTxBytesPerSec
        self.cpuHistory = cpuHistory; self.memHistory = memHistory
        self.ioHistory = ioHistory; self.netHistory = netHistory
    }

    public struct TimedSample: Codable, Equatable, Identifiable, Sendable {
        public let at: Int64
        public let value: Double
        public var id: Int64 { at }
        public init(at: Int64, value: Double) { self.at = at; self.value = value }
    }
    public struct IOSample: Codable, Equatable, Identifiable, Sendable {
        public let at: Int64
        public let read: Double
        public let write: Double
        public var id: Int64 { at }
        public init(at: Int64, read: Double, write: Double) {
            self.at = at; self.read = read; self.write = write
        }
    }
}

// MARK: - P1.19 / P1.20 app-backup

public struct AppBackupStartRequest: Codable, Equatable, Sendable {
    public let serviceId: String
    public let password: String?
    public let includeUserData: Bool?
    public init(serviceId: String, password: String? = nil, includeUserData: Bool? = nil) {
        self.serviceId = serviceId
        self.password = password
        self.includeUserData = includeUserData
    }
}

public struct AppBackupStartResponse: Codable, Equatable, Sendable {
    public let backupId: String
    public let fetchPath: String
    public let expiresAt: Int64
    public let bytes: Int64
    public let encrypted: Bool
}

// MARK: - P14 — companion-dock (read-only desktop browser companions)
//
// "Dock a browser" mints a 60-second pairing ticket on the pod; the
// owner's phone shows it as a QR. A desktop browser scans, hits
// `POST /api/companion/redeem` against the pod, and is granted a
// 4-hour read-only companion session. The phone owns mint + list +
// revoke; the browser owns redeem (out of scope for iOS).

public struct CompanionMintTicketRequest: Codable, Equatable, Sendable {
    public let label: String?
    public init(label: String? = nil) { self.label = label }
}

public struct CompanionMintTicketResponse: Codable, Equatable, Sendable {
    public let ticketId: String
    public let ticketSecret: String
    public let expiresAt: Int64
    public init(ticketId: String, ticketSecret: String, expiresAt: Int64) {
        self.ticketId = ticketId
        self.ticketSecret = ticketSecret
        self.expiresAt = expiresAt
    }
}

public struct CompanionSummary: Codable, Equatable, Sendable, Identifiable {
    public let tokenPrefix: String
    public let label: String?
    public let redeemedAt: Int64
    public let lastSeenMs: Int64
    public let expiresAt: Int64
    public let userAgent: String?

    public var id: String { tokenPrefix }

    public init(
        tokenPrefix: String,
        label: String? = nil,
        redeemedAt: Int64,
        lastSeenMs: Int64,
        expiresAt: Int64,
        userAgent: String? = nil
    ) {
        self.tokenPrefix = tokenPrefix
        self.label = label
        self.redeemedAt = redeemedAt
        self.lastSeenMs = lastSeenMs
        self.expiresAt = expiresAt
        self.userAgent = userAgent
    }
}

public struct CompanionListResponse: Codable, Equatable, Sendable {
    public let companions: [CompanionSummary]
    public init(companions: [CompanionSummary]) { self.companions = companions }
}

public struct CompanionRevokeRequest: Codable, Equatable, Sendable {
    public let tokenPrefix: String
    public init(tokenPrefix: String) { self.tokenPrefix = tokenPrefix }
}

public struct CompanionRevokeResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
}

// MARK: - P14 Phase 2 — companion write-relay (owner-side queue)
//
// A companion may POST `/api/companion/request-write` with an unsigned
// intent; the owner's phone polls `/api/screens/companion/pending-writes`,
// signs + dispatches the destination call (releaseServerName /
// revokeServer), then POSTs `/api/screens/companion/resolve-pending` to
// record the outcome. The 403 gate on destination endpoints stays;
// this surface is the explicit opt-in path companions take to ask the
// owner to do the write.
//
// `intent` is dynamic JSON — its shape depends on `kind`. v1 kinds:
//   - "release-server":  { username, serverDomain, issuedAt }
//   - "revoke-server":   { userId, revokedServerId, reason, issuedAt }
// Other kinds render as "Unsupported request kind" without auto-action.

public struct CompanionPendingWrite: Codable, Equatable, Identifiable {
    public let requestId: String
    public let companionTokenPrefix: String
    public let companionLabel: String?
    public let kind: String
    public let intent: [String: AnyCodable]
    public let queuedAt: Int64
    public let expiresAt: Int64

    public var id: String { requestId }

    public init(
        requestId: String,
        companionTokenPrefix: String,
        companionLabel: String?,
        kind: String,
        intent: [String: AnyCodable],
        queuedAt: Int64,
        expiresAt: Int64
    ) {
        self.requestId = requestId
        self.companionTokenPrefix = companionTokenPrefix
        self.companionLabel = companionLabel
        self.kind = kind
        self.intent = intent
        self.queuedAt = queuedAt
        self.expiresAt = expiresAt
    }
}

public struct CompanionPendingWritesResponse: Codable, Equatable {
    public let pending: [CompanionPendingWrite]
    public init(pending: [CompanionPendingWrite]) { self.pending = pending }
}

public struct CompanionResolvePendingRequest: Codable, Equatable, Sendable {
    public let requestId: String
    /// "approved" | "denied"
    public let outcome: String
    public init(requestId: String, outcome: String) {
        self.requestId = requestId
        self.outcome = outcome
    }
}

public struct CompanionResolvePendingResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let alreadyResolved: Bool?
    public init(ok: Bool, alreadyResolved: Bool? = nil) {
        self.ok = ok
        self.alreadyResolved = alreadyResolved
    }
}

// MARK: - AnyCodable (used for free-form manifest fields + order responses)

public struct AnyCodable: Codable {
    public let value: Any

    public init(_ value: Any) { self.value = value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self.value = s; return }
        if let i = try? c.decode(Int64.self) { self.value = i; return }
        if let d = try? c.decode(Double.self) { self.value = d; return }
        if let b = try? c.decode(Bool.self) { self.value = b; return }
        if let a = try? c.decode([AnyCodable].self) { self.value = a.map { $0.value }; return }
        if let o = try? c.decode([String: AnyCodable].self) {
            self.value = o.mapValues { $0.value }; return
        }
        if c.decodeNil() { self.value = NSNull(); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let s as String: try c.encode(s)
        case let i as Int: try c.encode(i)
        case let i as Int64: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let b as Bool: try c.encode(b)
        case let a as [Any]: try c.encode(a.map(AnyCodable.init))
        case let o as [String: Any]: try c.encode(o.mapValues(AnyCodable.init))
        case is NSNull: try c.encodeNil()
        default: try c.encodeNil()
        }
    }
}

extension AnyCodable: Equatable {
    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Equality is structural — primitives compare directly.
        // For collections, fall back to JSON-stringified comparison.
        if let a = try? JSONEncoder().encode(lhs),
           let b = try? JSONEncoder().encode(rhs) { return a == b }
        return false
    }
}

// MARK: - GET /api/screens/post-recovery/status (J.4)
//
// After the user recovers on a new phone and a J.3 IRK swap completes,
// the daemon walks every installed app and rewrites membership rows
// from the old IRK to the new one. This endpoint surfaces what
// happened so the post-recovery confirmation screen can show a
// per-app readout + a single Undo CTA for the 7-day window.

public struct PostRecoveryStatusResponse: Codable, Equatable, Sendable {
    /// Null when no swap has completed on this daemon since boot —
    /// the iOS view treats that as "no recovery in progress."
    public let report: PostRecoverySnapshot?

    public init(report: PostRecoverySnapshot?) { self.report = report }
}

public struct PostRecoverySnapshot: Codable, Equatable, Sendable {
    /// The IRK pubkey the daemon currently honors (hex).
    public let currentIrkPubHex: String
    public let state: WatcherState
    /// Null until at least one J.3 swap has fired since daemon boot.
    public let lastReissue: ReissuanceReportPayload?

    public init(currentIrkPubHex: String, state: WatcherState, lastReissue: ReissuanceReportPayload?) {
        self.currentIrkPubHex = currentIrkPubHex
        self.state = state
        self.lastReissue = lastReissue
    }
}

public struct WatcherState: Codable, Equatable, Sendable {
    public let lastSeen: PendingRePair?
    public let lastSwapTo: String?
    public let lastSwapAt: Int64?
    public let lastPolledAt: Int64
    public let lastError: String?

    public init(
        lastSeen: PendingRePair?, lastSwapTo: String?, lastSwapAt: Int64?,
        lastPolledAt: Int64, lastError: String?
    ) {
        self.lastSeen = lastSeen; self.lastSwapTo = lastSwapTo; self.lastSwapAt = lastSwapAt
        self.lastPolledAt = lastPolledAt; self.lastError = lastError
    }
}

public struct PendingRePair: Codable, Equatable, Sendable {
    public let newIrkPub: String
    public let oldIrkPub: String
    public let initiatedAt: Int64
    public let completesAt: Int64
    public let objectedAt: Int64?

    public init(newIrkPub: String, oldIrkPub: String, initiatedAt: Int64, completesAt: Int64, objectedAt: Int64?) {
        self.newIrkPub = newIrkPub; self.oldIrkPub = oldIrkPub
        self.initiatedAt = initiatedAt; self.completesAt = completesAt
        self.objectedAt = objectedAt
    }
}

public struct ReissuanceReportPayload: Codable, Equatable, Sendable {
    public let startedAt: Int64
    public let completedAt: Int64?
    /// "pending" | "running" | "complete" | "failed" — daemon enum
    /// surfaced as a raw string so iOS adds new states forward-
    /// compatibly without a decode break.
    public let status: String
    /// 12-char SHA-256 prefix of the IRK pubkey being rotated away.
    public let oldIrkPrefix: String
    /// 12-char SHA-256 prefix of the new IRK pubkey.
    public let newIrkPrefix: String
    public let apps: [AppReissuanceSummary]
    public let totalRewritten: Int
    public let reattachedCount: Int
    public let unchangedCount: Int
    public let undoWindowExpiresAt: Int64

    public init(
        startedAt: Int64, completedAt: Int64?, status: String,
        oldIrkPrefix: String, newIrkPrefix: String,
        apps: [AppReissuanceSummary],
        totalRewritten: Int, reattachedCount: Int, unchangedCount: Int,
        undoWindowExpiresAt: Int64
    ) {
        self.startedAt = startedAt; self.completedAt = completedAt
        self.status = status
        self.oldIrkPrefix = oldIrkPrefix; self.newIrkPrefix = newIrkPrefix
        self.apps = apps
        self.totalRewritten = totalRewritten
        self.reattachedCount = reattachedCount
        self.unchangedCount = unchangedCount
        self.undoWindowExpiresAt = undoWindowExpiresAt
    }
}

public struct AppReissuanceSummary: Codable, Equatable, Sendable, Identifiable {
    public let serviceId: String
    public let slug: String
    public let rewrittenCount: Int
    public let unchangedCount: Int
    public let error: String?
    public let completedAt: Int64

    public var id: String { serviceId }

    public init(
        serviceId: String, slug: String, rewrittenCount: Int, unchangedCount: Int,
        error: String?, completedAt: Int64
    ) {
        self.serviceId = serviceId; self.slug = slug
        self.rewrittenCount = rewrittenCount; self.unchangedCount = unchangedCount
        self.error = error; self.completedAt = completedAt
    }
}

// MARK: - W10 — per-app env-var KV editor

/// /api/screens/services/:appId/env — returns env var NAMES only.
/// The daemon NEVER returns values; this struct intentionally has no
/// `values` field.
public struct ServiceEnvListResponse: Codable, Equatable, Sendable {
    public let names: [String]
    public init(names: [String]) { self.names = names }
}

/// SetServiceEnvRequest mirror — canonical bytes per
/// @flagship/protocol auth.ts signSetServiceEnv. The phone composes,
/// signs (IRK from the Keychain), and POSTs this. `value` is SECRET —
/// the phone holds it transiently, sends it once over the daemon's
/// TLS, and forgets.
public struct ServiceEnvSetEnvelope: Codable, Equatable, Sendable {
    public let serverId: String
    public let creator: String
    public let slug: String
    public let env: [String: String]
    public let issuedAt: Int64
    public init(serverId: String, creator: String, slug: String, env: [String: String], issuedAt: Int64) {
        self.serverId = serverId; self.creator = creator; self.slug = slug
        self.env = env; self.issuedAt = issuedAt
    }
}

public struct ServiceEnvSetRequest: Codable, Equatable, Sendable {
    public let name: String
    public let value: String
    public let request: ServiceEnvSetEnvelope
    /// Hex Ed25519 signature over canonicalSetServiceEnv(request).
    public let signature: String
    public init(name: String, value: String, request: ServiceEnvSetEnvelope, signature: String) {
        self.name = name; self.value = value; self.request = request; self.signature = signature
    }
}

public struct ServiceEnvUnsetRequest: Codable, Equatable, Sendable {
    public let name: String
    public let request: ServiceEnvSetEnvelope
    public let signature: String
    public init(name: String, request: ServiceEnvSetEnvelope, signature: String) {
        self.name = name; self.request = request; self.signature = signature
    }
}

public struct ServiceEnvOpResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
}

// MARK: - W10 — vibe-code session public state + reply

public struct VibeCodeSessionMessage: Codable, Equatable, Sendable {
    public let role: String          // "user" | "assistant"
    public let text: String
    public let timestamp: Int64
    public init(role: String, text: String, timestamp: Int64) {
        self.role = role; self.text = text; self.timestamp = timestamp
    }
}

public enum VibeCodePendingRequest: Codable, Equatable, Sendable {
    case talkToUser(toolUseId: String, message: String)
    case requestEnvVar(toolUseId: String, name: String, description: String, why: String, example: String?, secret: Bool?)

    private enum CodingKeys: String, CodingKey { case kind, toolUseId, payload }
    private enum PayloadKeys: String, CodingKey { case message, name, description, why, example, secret }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let toolUseId = try c.decode(String.self, forKey: .toolUseId)
        let payload = try c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
        switch kind {
        case "talkToUser":
            self = .talkToUser(
                toolUseId: toolUseId,
                message: try payload.decode(String.self, forKey: .message)
            )
        case "requestEnvVar":
            self = .requestEnvVar(
                toolUseId: toolUseId,
                name: try payload.decode(String.self, forKey: .name),
                description: try payload.decode(String.self, forKey: .description),
                why: try payload.decode(String.self, forKey: .why),
                example: try payload.decodeIfPresent(String.self, forKey: .example),
                secret: try payload.decodeIfPresent(Bool.self, forKey: .secret)
            )
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown pendingRequest kind: \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .talkToUser(let id, let message):
            try c.encode("talkToUser", forKey: .kind)
            try c.encode(id, forKey: .toolUseId)
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encode(message, forKey: .message)
        case .requestEnvVar(let id, let name, let description, let why, let example, let secret):
            try c.encode("requestEnvVar", forKey: .kind)
            try c.encode(id, forKey: .toolUseId)
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encode(name, forKey: .name)
            try p.encode(description, forKey: .description)
            try p.encode(why, forKey: .why)
            try p.encodeIfPresent(example, forKey: .example)
            try p.encodeIfPresent(secret, forKey: .secret)
        }
    }
}

public struct VibeCodeSessionPublicState: Codable, Equatable, Sendable {
    public let id: String
    public let appId: String?
    public let status: String
    public let messages: [VibeCodeSessionMessage]
    public let pendingRequest: VibeCodePendingRequest?
    public init(
        id: String,
        appId: String?,
        status: String,
        messages: [VibeCodeSessionMessage],
        pendingRequest: VibeCodePendingRequest?
    ) {
        self.id = id; self.appId = appId; self.status = status
        self.messages = messages; self.pendingRequest = pendingRequest
    }
}

public struct VibeCodeReplyRequest: Codable, Equatable, Sendable {
    public let text: String?
    public let envVarStatus: String?   // "set" | "declined" | "deferred"
    public init(text: String? = nil, envVarStatus: String? = nil) {
        self.text = text; self.envVarStatus = envVarStatus
    }
}

public struct VibeCodeReplyResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
}

// MARK: - P9 — peer-backup status + toggle

public struct PeerBackupPeerHostingYou: Codable, Equatable, Sendable, Identifiable {
    public let peerFqdn: String
    public let shardsHosted: Int
    public let lastSeenMs: Int64
    public let online: Bool

    public var id: String { peerFqdn }

    public init(peerFqdn: String, shardsHosted: Int, lastSeenMs: Int64, online: Bool) {
        self.peerFqdn = peerFqdn
        self.shardsHosted = shardsHosted
        self.lastSeenMs = lastSeenMs
        self.online = online
    }
}

public struct PeerBackupPeerYouHost: Codable, Equatable, Sendable, Identifiable {
    public let peerFqdn: String
    public let shardsHosted: Int
    public let bytesHosted: Int64
    public let lastFetchedMs: Int64

    public var id: String { peerFqdn }

    public init(peerFqdn: String, shardsHosted: Int, bytesHosted: Int64, lastFetchedMs: Int64) {
        self.peerFqdn = peerFqdn
        self.shardsHosted = shardsHosted
        self.bytesHosted = bytesHosted
        self.lastFetchedMs = lastFetchedMs
    }
}

public struct PeerBackupShardSummary: Codable, Equatable, Sendable, Identifiable {
    public let shardId: String
    public let replicas: Int
    public let minReplicas: Int
    public let bytes: Int64

    public var id: String { shardId }

    public init(shardId: String, replicas: Int, minReplicas: Int, bytes: Int64) {
        self.shardId = shardId
        self.replicas = replicas
        self.minReplicas = minReplicas
        self.bytes = bytes
    }
}

public struct PeerBackupRepairStatus: Codable, Equatable, Sendable {
    public let state: String          // "idle" | "running" | "error"
    public let lastTickMs: Int64?
    public let queued: Int
    public let completed24h: Int
    public let lastError: String?

    public init(state: String, lastTickMs: Int64?, queued: Int, completed24h: Int, lastError: String?) {
        self.state = state
        self.lastTickMs = lastTickMs
        self.queued = queued
        self.completed24h = completed24h
        self.lastError = lastError
    }
}

public struct PeerBackupStats: Codable, Equatable, Sendable {
    public let total: Int
    public let durable: Int
    public let atRisk: Int
    public let yourBytesStored: Int64
    public let peerBytesHosted: Int64

    public init(total: Int, durable: Int, atRisk: Int, yourBytesStored: Int64, peerBytesHosted: Int64) {
        self.total = total
        self.durable = durable
        self.atRisk = atRisk
        self.yourBytesStored = yourBytesStored
        self.peerBytesHosted = peerBytesHosted
    }
}

public struct PeerBackupStatusResponse: Codable, Equatable, Sendable {
    public let participating: Bool
    public let peersBackingYouUp: [PeerBackupPeerHostingYou]
    public let peersYouBackUp: [PeerBackupPeerYouHost]
    public let shards: [PeerBackupShardSummary]
    public let repair: PeerBackupRepairStatus
    public let stats: PeerBackupStats

    public init(
        participating: Bool,
        peersBackingYouUp: [PeerBackupPeerHostingYou],
        peersYouBackUp: [PeerBackupPeerYouHost],
        shards: [PeerBackupShardSummary],
        repair: PeerBackupRepairStatus,
        stats: PeerBackupStats
    ) {
        self.participating = participating
        self.peersBackingYouUp = peersBackingYouUp
        self.peersYouBackUp = peersYouBackUp
        self.shards = shards
        self.repair = repair
        self.stats = stats
    }
}

public struct PeerBackupToggleRequest: Codable, Equatable, Sendable {
    public let participate: Bool
    public init(participate: Bool) { self.participate = participate }
}

// MARK: - P6 — app-invite (collaborator invites)
//
// Wire-shape parity with `packages/server-daemon/src/screens/types.ts`
// (AppInvite*) — the daemon never sees the local label-book
// (displayName / channel / sentTo / notes). The only client-supplied
// strings that ride the wire are `opaqueTag` (16-byte hex anonymization
// handle) and the optional `contextNote` rendered to the redeemer.

public struct AppInviteIssueRequest: Codable, Equatable, Sendable {
    public let serviceId: String
    public let role: String
    public let opaqueTag: String
    public let contextNote: String?

    public init(serviceId: String, role: String, opaqueTag: String, contextNote: String?) {
        self.serviceId = serviceId
        self.role = role
        self.opaqueTag = opaqueTag
        self.contextNote = contextNote
    }
}

public struct AppInviteIssueResponse: Codable, Equatable, Sendable {
    public let secret: String
    public let expiresAt: Int64

    public init(secret: String, expiresAt: Int64) {
        self.secret = secret
        self.expiresAt = expiresAt
    }
}

public struct AppInvitePendingSummary: Codable, Equatable, Sendable, Identifiable {
    public let opaqueTag: String
    public let inviteId: String
    public let role: String
    public let expiresAt: Int64

    public var id: String { inviteId }

    public init(opaqueTag: String, inviteId: String, role: String, expiresAt: Int64) {
        self.opaqueTag = opaqueTag
        self.inviteId = inviteId
        self.role = role
        self.expiresAt = expiresAt
    }
}

public struct AppInviteListResponse: Codable, Equatable, Sendable {
    public let pending: [AppInvitePendingSummary]
    public init(pending: [AppInvitePendingSummary]) { self.pending = pending }
}

public struct AppInviteAccessSummary: Codable, Equatable, Sendable, Identifiable {
    public let opaqueTag: String
    public let irkPubHex: String
    public let role: String
    public let grantedAt: Int64

    public var id: String { irkPubHex }

    public init(opaqueTag: String, irkPubHex: String, role: String, grantedAt: Int64) {
        self.opaqueTag = opaqueTag
        self.irkPubHex = irkPubHex
        self.role = role
        self.grantedAt = grantedAt
    }
}

public struct AppInviteAccessResponse: Codable, Equatable, Sendable {
    public let access: [AppInviteAccessSummary]
    public init(access: [AppInviteAccessSummary]) { self.access = access }
}

/// Discriminated revoke request. Mirrors the daemon's union shape — the
/// `scope` field gates which optional field is required: `inviteId` for
/// `scope == "invite"`, `irkPubKey` for `scope == "access"`.
public struct AppInviteRevokeRequest: Codable, Equatable, Sendable {
    public let serviceId: String
    public let scope: String
    public let inviteId: String?
    public let irkPubKey: String?

    public init(serviceId: String, scope: String, inviteId: String? = nil, irkPubKey: String? = nil) {
        self.serviceId = serviceId
        self.scope = scope
        self.inviteId = inviteId
        self.irkPubKey = irkPubKey
    }

    public static func invite(serviceId: String, inviteId: String) -> AppInviteRevokeRequest {
        AppInviteRevokeRequest(serviceId: serviceId, scope: "invite", inviteId: inviteId, irkPubKey: nil)
    }

    public static func access(serviceId: String, irkPubKey: String) -> AppInviteRevokeRequest {
        AppInviteRevokeRequest(serviceId: serviceId, scope: "access", inviteId: nil, irkPubKey: irkPubKey)
    }
}

public struct AppInviteRevokeResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let alreadyRevoked: Bool?

    public init(ok: Bool, alreadyRevoked: Bool? = nil) {
        self.ok = ok
        self.alreadyRevoked = alreadyRevoked
    }
}
