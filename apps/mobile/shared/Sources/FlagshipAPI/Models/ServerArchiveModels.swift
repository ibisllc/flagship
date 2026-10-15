import Foundation

/// "Backup/clone server" (docs/server-backup-and-clone.md): the sealed archive
/// a box makes of all its apps, and the import of one onto a box.
public struct ServerArchiveApp: Codable, Equatable, Sendable {
    public let serviceId: String
    public let name: String
    public init(serviceId: String, name: String) {
        self.serviceId = serviceId
        self.name = name
    }
}

public struct ServerArchiveProgress: Codable, Equatable, Sendable {
    public let done: Int
    public let total: Int
    public let app: String
    public init(done: Int, total: Int, app: String) {
        self.done = done
        self.total = total
        self.app = app
    }
}

public struct ServerArchiveStatus: Codable, Equatable, Sendable {
    public let archiveId: String
    /// `building` | `ready` | `failed`
    public let state: String
    public let startedAt: Int64
    public let progress: ServerArchiveProgress?
    public let bytes: Int64?
    public let sha256: String?
    public let apps: [ServerArchiveApp]?
    public let reason: String?

    public init(archiveId: String, state: String, startedAt: Int64 = 0, progress: ServerArchiveProgress? = nil,
                bytes: Int64? = nil, sha256: String? = nil, apps: [ServerArchiveApp]? = nil, reason: String? = nil) {
        self.archiveId = archiveId
        self.state = state
        self.startedAt = startedAt
        self.progress = progress
        self.bytes = bytes
        self.sha256 = sha256
        self.apps = apps
        self.reason = reason
    }
}

public struct ServerArchiveStatusResponse: Codable, Equatable, Sendable {
    public let archive: ServerArchiveStatus?
    public init(archive: ServerArchiveStatus?) { self.archive = archive }
}

public struct ServerArchiveStartRequest: Codable, Equatable, Sendable {
    public let archiveId: String
    /// The 32-byte key the phone derived for this archive, lowercase hex.
    public let key: String
    public init(archiveId: String, key: String) {
        self.archiveId = archiveId
        self.key = key
    }
}

public struct ServerRestoreStartRequest: Codable, Equatable, Sendable {
    public let archiveId: String
    public let bytes: Int64
    public init(archiveId: String, bytes: Int64) {
        self.archiveId = archiveId
        self.bytes = bytes
    }
}

public struct ServerRestoreCommitRequest: Codable, Equatable, Sendable {
    public let key: String
    public init(key: String) { self.key = key }
}

public struct ServerRestoreApp: Codable, Equatable, Sendable {
    public let serviceId: String
    public let name: String
    /// `waiting` | `restoring` | `done` | `skipped` | `failed`
    public let state: String
    public let reason: String?
    public init(serviceId: String, name: String, state: String, reason: String? = nil) {
        self.serviceId = serviceId
        self.name = name
        self.state = state
        self.reason = reason
    }
}

public struct ServerRestoreStatus: Codable, Equatable, Sendable {
    public let archiveId: String
    /// `uploading` | `ready` | `opening` | `restoring` | `done` | `failed`
    public let state: String
    public let bytes: Int64
    public let received: Int64
    public let apps: [ServerRestoreApp]
    public let reason: String?
    public init(archiveId: String, state: String, bytes: Int64 = 0, received: Int64 = 0,
                apps: [ServerRestoreApp] = [], reason: String? = nil) {
        self.archiveId = archiveId
        self.state = state
        self.bytes = bytes
        self.received = received
        self.apps = apps
        self.reason = reason
    }
}

public struct ServerRestoreStatusResponse: Codable, Equatable, Sendable {
    public let restore: ServerRestoreStatus?
    public init(restore: ServerRestoreStatus?) { self.restore = restore }
}

/// One entry of the box's own activity log (`GET /api/screens/activity`).
public struct BoxActivityEntry: Codable, Equatable, Sendable {
    public struct Actor: Codable, Equatable, Sendable {
        public let kind: String
        public let label: String?
    }
    public let seq: Int?
    public let ts: Int64
    public let actor: Actor?
    public let action: String
    public let kind: String?
    public let detail: String?
    public let target: String?
    public let ok: Bool

    public init(seq: Int? = nil, ts: Int64, actor: Actor? = nil, action: String, kind: String? = nil,
                detail: String? = nil, target: String? = nil, ok: Bool = true) {
        self.seq = seq
        self.ts = ts
        self.actor = actor
        self.action = action
        self.kind = kind
        self.detail = detail
        self.target = target
        self.ok = ok
    }
}

public struct BoxActivityResponse: Codable, Equatable, Sendable {
    public let entries: [BoxActivityEntry]
    public init(entries: [BoxActivityEntry]) { self.entries = entries }
}
