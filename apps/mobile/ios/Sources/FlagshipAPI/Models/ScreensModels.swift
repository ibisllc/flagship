// Flagship `/api/screens/*` BFF contract — Swift mirror.
//
// MIRRORS: packages/server-daemon/src/screens/types.ts
// When the daemon's BFF contract changes, update this file in lockstep.
// Keep field names + JSON keys identical; native callers depend on
// `Codable` round-tripping with the daemon's `JSON.stringify(...)` output.

import Foundation

// MARK: - Shared

public struct AppSummary: Codable, Equatable {
    public let appId: String
    public let creator: String
    public let slug: String
    public let urlLabel: String
    public let summary: String?
    public let url: String
    public let status: String   // "running" | "stopped" | "unknown"
    public let version: String?
    public let installedAt: Int64
}

public struct RecentInstallEvent: Codable, Equatable {
    public let at: Int64
    public let kind: String     // "installed" | "uninstalled" | "deploy" | "update-pulled"
    public let appId: String
    public let detail: String?
}

// MARK: - P1.1 server-detail

public struct ServerDetailResponse: Codable, Equatable {
    public let serverFqdn: String
    public let username: String
    public let daemonVersion: String
    public let startedAt: Int64
    public let uptimeMs: Int64
    public let certNotAfter: Int64?
    public let certNotBefore: Int64?
    public let certSans: [String]?
    public let appCount: Int
    public let pairedSessionCount: Int
    public let recentInstallEvents: [RecentInstallEvent]
}

// MARK: - P1.2 apps-list

public struct AppsListResponse: Codable, Equatable {
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

// MARK: - P1.4 marketplace-browse

public struct MarketplaceListing: Codable, Equatable {
    public let creator: String
    public let slug: String
    public let title: String
    public let summary: String
    public let screenshots: [String]
    public let installCount: Int
    public let requiresLlmKey: Bool
    public let alreadyInstalled: Bool
}

public struct MarketplaceBrowseResponse: Codable, Equatable {
    public let listings: [MarketplaceListing]
}

// MARK: - P1.5 vibe-code/start

public struct VibeCodeStartRequest: Codable, Equatable {
    public let prompt: String
    public let model: String?
    public init(prompt: String, model: String?) {
        self.prompt = prompt
        self.model = model
    }
}

public struct VibeCodeStartResponse: Codable, Equatable {
    public let sessionId: String
}

// MARK: - P1.6 vibe-code/:id/stream (WS frames)

public enum VibeCodeFrame: Codable, Equatable {
    case token(text: String)
    case manifestEmit(manifestJson: String)
    case repoCreate(repoFullName: String)
    case buildStart
    case buildLog(line: String)
    case deploy(appId: String, url: String)
    case done
    case error(message: String)

    private enum CodingKeys: String, CodingKey { case kind, text, manifestJson, repoFullName, line, appId, url, message }

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
                appId: try c.decode(String.self, forKey: .appId),
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
        case .deploy(let a, let u): try c.encode("deploy", forKey: .kind); try c.encode(a, forKey: .appId); try c.encode(u, forKey: .url)
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

// MARK: - P1.8 / P1.9 unlock-approvals

public struct PendingUnlockApproval: Codable, Equatable {
    public let serverFqdn: String
    public let requestId: String
    public let requestedAt: Int64
    public let ip: String?
    public let userAgent: String?
}

public struct UnlockApprovalsPendingResponse: Codable, Equatable {
    public let pending: [PendingUnlockApproval]
}

public struct UnlockApprovalApproveRequest: Codable, Equatable {
    public let signature: String  // hex
    public let envelope: String   // base64
    public init(signature: String, envelope: String) {
        self.signature = signature
        self.envelope = envelope
    }
}

// MARK: - P1.10 / P1.11 browser-tabs

public struct BrowserTab: Codable, Equatable {
    public let tabId: String
    public let appId: String
    public let currentUrl: String?
    public let title: String?
    public let screenshotKey: String?
    public let needsField: String?  // "password" | "text" | "code"
}

public struct BrowserTabsListResponse: Codable, Equatable {
    public let tabs: [BrowserTab]
}

// MARK: - P1.12 / P1.13 paired-sessions

public struct PairedSessionSummary: Codable, Equatable {
    public let tokenPrefix: String
    public let label: String
    public let addedAt: Int64
    public let current: Bool
}

public struct PairedSessionsListResponse: Codable, Equatable {
    public let sessions: [PairedSessionSummary]
}

// MARK: - P1.14 orders/send

public struct OrdersSendRequest: Codable, Equatable {
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

public struct TierStatusResponse: Codable, Equatable {
    public let tier: String   // "free" | "promo" | "byok"
    public let llmCreditsRemainingDay: Int64?
    public let llmCreditsRemainingTotal: Int64?
    public let dispatcherUsageGBmonth: Double?
    public let dispatcherFreeQuotaGBmonth: Double?
    public let customDomains: [String]
    public let reservedNames: [String]
}

// MARK: - P1.17 / P1.18 url-controller

public struct OwnedUrl: Codable, Equatable {
    public let fqdn: String
    public let kind: String   // "canonical" | "alias" | "custom"
    public let claimedAt: Int64
}

public struct UrlControllerOwnedResponse: Codable, Equatable {
    public let urls: [OwnedUrl]
}

public struct UrlControllerClaimRequest: Codable, Equatable {
    public let fqdn: String
    public init(fqdn: String) { self.fqdn = fqdn }
}

public struct UrlControllerClaimResponse: Codable, Equatable {
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

public struct ServerMetricsResponse: Codable, Equatable {
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

public struct AppBackupStartRequest: Codable, Equatable {
    public let appId: String
    public let password: String?
    public let includeUserData: Bool?
    public init(appId: String, password: String? = nil, includeUserData: Bool? = nil) {
        self.appId = appId
        self.password = password
        self.includeUserData = includeUserData
    }
}

public struct AppBackupStartResponse: Codable, Equatable {
    public let backupId: String
    public let fetchPath: String
    public let expiresAt: Int64
    public let bytes: Int64
    public let encrypted: Bool
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
