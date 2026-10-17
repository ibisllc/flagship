import Foundation

/// A server's saved (scheduled) backups and its backup policy
/// (docs/server-backup-and-clone.md, "Backup policy" and "Scheduled
/// backups"). Shapes mirror the box's `serverArchive/service.ts` and
/// `backupPolicy/http.ts`.

// MARK: - Scheduled backups

public struct BackupSchedule: Codable, Equatable, Sendable {
    /// `daily` | `weekly` | `off`
    public var frequency: String
    /// Minutes after 00:00 UTC, 0...1439.
    public var minuteOfDayUtc: Int
    /// 0 = Sunday ... 6 = Saturday (UTC); used when weekly.
    public var weekdayUtc: Int
    public var keepDaily: Int
    public var keepWeekly: Int

    public init(frequency: String, minuteOfDayUtc: Int, weekdayUtc: Int, keepDaily: Int, keepWeekly: Int) {
        self.frequency = frequency
        self.minuteOfDayUtc = minuteOfDayUtc
        self.weekdayUtc = weekdayUtc
        self.keepDaily = keepDaily
        self.keepWeekly = keepWeekly
    }

    /// The box's default: daily at 03:00 UTC, keep 7 daily and 4 weekly.
    public static let boxDefault = BackupSchedule(frequency: "daily", minuteOfDayUtc: 180, weekdayUtc: 0, keepDaily: 7, keepWeekly: 4)
}

public struct SavedBackupLastRun: Codable, Equatable, Sendable {
    public let at: Int64
    public let ok: Bool
    /// `schedule` | `now`
    public let trigger: String
    public let archiveId: String?
    /// The box's sentence when it failed.
    public let reason: String?

    public init(at: Int64, ok: Bool, trigger: String, archiveId: String? = nil, reason: String? = nil) {
        self.at = at
        self.ok = ok
        self.trigger = trigger
        self.archiveId = archiveId
        self.reason = reason
    }
}

public struct SavedBackupRunning: Codable, Equatable, Sendable {
    public let archiveId: String
    public let trigger: String
    public let startedAt: Int64
    public let progress: ServerArchiveProgress
    public let estimatedBytes: Int64?

    public init(archiveId: String, trigger: String, startedAt: Int64, progress: ServerArchiveProgress, estimatedBytes: Int64? = nil) {
        self.archiveId = archiveId
        self.trigger = trigger
        self.startedAt = startedAt
        self.progress = progress
        self.estimatedBytes = estimatedBytes
    }
}

/// One backup the server keeps on its own disk.
public struct SavedBackup: Codable, Equatable, Sendable, Identifiable {
    public let archiveId: String
    public let createdAt: Int64
    /// `schedule` | `now`
    public let trigger: String
    /// The data file's size and SHA-256.
    public let bytes: Int64
    public let sha256: String
    /// The backup file's size.
    public let backupBytes: Int64
    public let backupFileName: String
    public let dataFileName: String
    public let apps: [ServerArchiveApp]
    public let left: [ServerArchiveLeftApp]
    /// The one `.flagship` file people keep: its name, size and SHA-256.
    public let bundleFileName: String?
    public let bundleBytes: Int64?
    public let bundleSha256: String?

    public var id: String { archiveId }
    /// The one file's size (header + both parts when the box doesn't say).
    public var fileBytes: Int64 { bundleBytes ?? (16 + bytes + backupBytes) }
    public var fileName: String { bundleFileName ?? ServerArchiveRoute.bundleName(forPart: dataFileName) }

    public init(archiveId: String, createdAt: Int64, trigger: String, bytes: Int64, sha256: String, backupBytes: Int64,
                backupFileName: String, dataFileName: String, apps: [ServerArchiveApp] = [], left: [ServerArchiveLeftApp] = [],
                bundleFileName: String? = nil, bundleBytes: Int64? = nil, bundleSha256: String? = nil) {
        self.archiveId = archiveId
        self.createdAt = createdAt
        self.trigger = trigger
        self.bytes = bytes
        self.sha256 = sha256
        self.backupBytes = backupBytes
        self.backupFileName = backupFileName
        self.dataFileName = dataFileName
        self.apps = apps
        self.left = left
        self.bundleFileName = bundleFileName
        self.bundleBytes = bundleBytes
        self.bundleSha256 = bundleSha256
    }
}

/// `GET /api/screens/server-archive/backups` (and the answer of every change to it).
public struct SavedBackupsView: Codable, Equatable, Sendable {
    public let schedule: BackupSchedule
    /// False while the backup policy is "none": the schedule doesn't run (Back up now still does).
    public let scheduleActive: Bool
    public let nextRunAt: Int64?
    public let lastRun: SavedBackupLastRun?
    public let running: SavedBackupRunning?
    public let keysLeft: Int
    /// How many keys an admin device should send (one approval); 0 while the pool is full enough.
    public let keysWanted: Int
    /// The box's sentence while it can't make a backup (no keys yet).
    public let waitingReason: String?
    public let usedBytes: Int64
    /// Newest first.
    public let backups: [SavedBackup]

    public init(schedule: BackupSchedule, scheduleActive: Bool = true, nextRunAt: Int64? = nil, lastRun: SavedBackupLastRun? = nil,
                running: SavedBackupRunning? = nil, keysLeft: Int = 0, keysWanted: Int = 0, waitingReason: String? = nil,
                usedBytes: Int64 = 0, backups: [SavedBackup] = []) {
        self.schedule = schedule
        self.scheduleActive = scheduleActive
        self.nextRunAt = nextRunAt
        self.lastRun = lastRun
        self.running = running
        self.keysLeft = keysLeft
        self.keysWanted = keysWanted
        self.waitingReason = waitingReason
        self.usedBytes = usedBytes
        self.backups = backups
    }

    enum CodingKeys: String, CodingKey {
        case schedule, scheduleActive, nextRunAt, lastRun, running, keysLeft, keysWanted, waitingReason, usedBytes, backups
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedule = try c.decode(BackupSchedule.self, forKey: .schedule)
        // An older box has no policy, so its schedule always runs.
        scheduleActive = try c.decodeIfPresent(Bool.self, forKey: .scheduleActive) ?? true
        nextRunAt = try c.decodeIfPresent(Int64.self, forKey: .nextRunAt)
        lastRun = try c.decodeIfPresent(SavedBackupLastRun.self, forKey: .lastRun)
        running = try c.decodeIfPresent(SavedBackupRunning.self, forKey: .running)
        keysLeft = try c.decode(Int.self, forKey: .keysLeft)
        keysWanted = try c.decode(Int.self, forKey: .keysWanted)
        waitingReason = try c.decodeIfPresent(String.self, forKey: .waitingReason)
        usedBytes = try c.decodeIfPresent(Int64.self, forKey: .usedBytes) ?? 0
        backups = try c.decodeIfPresent([SavedBackup].self, forKey: .backups) ?? []
    }
}

/// `POST .../backups/run` → 202.
public struct SavedBackupRunResponse: Codable, Equatable, Sendable {
    public let archiveId: String
    public init(archiveId: String) { self.archiveId = archiveId }
}

/// One account-slot key for a future scheduled backup:
/// `kekHex = deriveServerArchiveKey(UMK, archiveId)`.
public struct ArchiveKey: Codable, Equatable, Sendable {
    /// 16 bytes, lowercase hex.
    public let archiveId: String
    /// 32 bytes, lowercase hex.
    public let kekHex: String
    public init(archiveId: String, kekHex: String) {
        self.archiveId = archiveId
        self.kekHex = kekHex
    }
}

/// `flagship/server-archive-keys/v1` (canonical bytes in FlagshipCore, `ArchiveKeys`).
public struct ArchiveKeysDeposit: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/server-archive-keys/v1"
    public let serverDomain: String
    public let count: Int
    /// SHA-256 hex of the lines `<archiveId>:<kekHex>` joined with "\n".
    public let digest: String
    public let issuedAt: Int64
    public init(serverDomain: String, count: Int, digest: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.count = count
        self.digest = digest
        self.issuedAt = issuedAt
    }
}

/// `POST /api/screens/server-archive/backups/keys` body.
public struct ArchiveKeysDepositRequest: Codable, Equatable, Sendable {
    public let deposit: ArchiveKeysDeposit
    public let signature: String
    public let keys: [ArchiveKey]
    public init(deposit: ArchiveKeysDeposit, signature: String, keys: [ArchiveKey]) {
        self.deposit = deposit
        self.signature = signature
        self.keys = keys
    }
}

/// Where a backup's files are fetched from: Back up now's one-off backup, or
/// one of the server's saved backups.
public enum ServerArchiveRoute: Equatable, Sendable {
    case current
    case saved(archiveId: String)

    public var base: String {
        switch self {
        case .current: return "/api/screens/server-archive"
        case .saved(let id): return "/api/screens/server-archive/backups/\(id)"
        }
    }

    /// `<stem>.flagship` for a part named `<stem>.flagship-backup` / `.flagship-data`.
    public static func bundleName(forPart name: String) -> String {
        for ext in [".flagship-backup", ".flagship-data"] where name.hasSuffix(ext) {
            return String(name.dropLast(ext.count)) + ".flagship"
        }
        return name + ".flagship"
    }
}

// MARK: - Backup policy

/// `flagship/backup-policy/v1` (canonical bytes in FlagshipCore, `BackupPolicyOrder.canonicalBytes`).
public struct BackupPolicyOrder: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/backup-policy/v1"
    public let serverDomain: String
    /// `phone` | `peer` | `none`
    public let policy: String
    /// > 0 exactly when the policy is `phone`.
    public let phoneReserveBytes: Int64
    public let issuedAt: Int64
    public init(serverDomain: String, policy: String, phoneReserveBytes: Int64, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.policy = policy
        self.phoneReserveBytes = phoneReserveBytes
        self.issuedAt = issuedAt
    }
}

/// `POST /api/screens/backup-policy` body, and the create-time sibling of the pairing order.
public struct BackupPolicyRequest: Codable, Equatable, Sendable {
    public let order: BackupPolicyOrder
    public let signatureHex: String
    public init(order: BackupPolicyOrder, signatureHex: String) {
        self.order = order
        self.signatureHex = signatureHex
    }
}

public struct BackupPolicyCurrent: Codable, Equatable, Sendable {
    /// `unset` | `phone` | `peer` | `none`
    public let policy: String
    public let phoneReserveBytes: Int64
    public let issuedAt: Int64?
    public init(policy: String, phoneReserveBytes: Int64 = 0, issuedAt: Int64? = nil) {
        self.policy = policy
        self.phoneReserveBytes = phoneReserveBytes
        self.issuedAt = issuedAt
    }
}

public struct BackupCapApp: Codable, Equatable, Sendable {
    public let serviceId: String
    public let bytes: Int64
    public init(serviceId: String, bytes: Int64) {
        self.serviceId = serviceId
        self.bytes = bytes
    }
}

/// The size limit the policy puts on the server's app data.
public struct BackupCapView: Codable, Equatable, Sendable {
    public let limitBytes: Int64?
    public let usedBytes: Int64?
    public let measuredAt: Int64?
    public let overLimit: Bool
    public let diskBytes: Int64
    public let reservedForPeersBytes: Int64?
    public let apps: [BackupCapApp]
    /// The box's sentence while the server is over its limit.
    public let overReason: String?

    public init(limitBytes: Int64? = nil, usedBytes: Int64? = nil, measuredAt: Int64? = nil, overLimit: Bool = false,
                diskBytes: Int64 = 0, reservedForPeersBytes: Int64? = nil, apps: [BackupCapApp] = [], overReason: String? = nil) {
        self.limitBytes = limitBytes
        self.usedBytes = usedBytes
        self.measuredAt = measuredAt
        self.overLimit = overLimit
        self.diskBytes = diskBytes
        self.reservedForPeersBytes = reservedForPeersBytes
        self.apps = apps
        self.overReason = overReason
    }
}

/// What the peer engine reports while the policy is "peer" (all optional: the engine is filled in separately).
public struct PeerBackupEngineStatus: Codable, Equatable, Sendable {
    /// `waiting-for-peers` | `filling` | `placing` | `protected` | `at-risk` | `leaving` | `off`
    public let state: String
    public let lastPlacedAt: Int64?
    public let healthyBricks: Int?
    public let totalBricks: Int?
    public let hostingBytes: Int64?
    public let provenBytes: Int64?
    public let poolBytes: Int64?
    /// How many servers hold this one's pieces.
    public let holders: Int?
    public let archiveId: String?
    public let reason: String?

    public init(state: String, lastPlacedAt: Int64? = nil, healthyBricks: Int? = nil, totalBricks: Int? = nil,
                hostingBytes: Int64? = nil, provenBytes: Int64? = nil, poolBytes: Int64? = nil, holders: Int? = nil,
                archiveId: String? = nil, reason: String? = nil) {
        self.state = state
        self.lastPlacedAt = lastPlacedAt
        self.healthyBricks = healthyBricks
        self.totalBricks = totalBricks
        self.hostingBytes = hostingBytes
        self.provenBytes = provenBytes
        self.poolBytes = poolBytes
        self.holders = holders
        self.archiveId = archiveId
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case state, lastPlacedAt, healthyBricks, totalBricks, hostingBytes, provenBytes, poolBytes, holders, archiveId, reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "off"
        lastPlacedAt = try? c.decodeIfPresent(Int64.self, forKey: .lastPlacedAt)
        healthyBricks = try? c.decodeIfPresent(Int.self, forKey: .healthyBricks)
        totalBricks = try? c.decodeIfPresent(Int.self, forKey: .totalBricks)
        hostingBytes = try? c.decodeIfPresent(Int64.self, forKey: .hostingBytes)
        provenBytes = try? c.decodeIfPresent(Int64.self, forKey: .provenBytes)
        poolBytes = try? c.decodeIfPresent(Int64.self, forKey: .poolBytes)
        // A count, or the list of holders.
        if let n = try? c.decodeIfPresent(Int.self, forKey: .holders) {
            holders = n
        } else if let list = try? c.decodeIfPresent([AnyDecodable].self, forKey: .holders) {
            holders = list.count
        } else {
            holders = nil
        }
        archiveId = try? c.decodeIfPresent(String.self, forKey: .archiveId)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }

    private struct AnyDecodable: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

/// `GET /api/screens/backup-policy` (and the answer of a POST).
public struct BackupPolicyView: Codable, Equatable, Sendable {
    public let policy: BackupPolicyCurrent
    public let cap: BackupCapView
    public let peer: PeerBackupEngineStatus?
    public init(policy: BackupPolicyCurrent, cap: BackupCapView, peer: PeerBackupEngineStatus? = nil) {
        self.policy = policy
        self.cap = cap
        self.peer = peer
    }
}
