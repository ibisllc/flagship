import Foundation

// Restore a backup into a running server (docs/restore-into-server.md §6): the box's view and the
// bodies of its orders. `GET /api/screens/server-restore-merge` answers `RestoreMergeView`.

public struct RestoreMergeView: Codable, Equatable, Sendable {
    public let stage: RestoreMergeStage?
    public let preview: RestoreMergePreview?
    public let run: RestoreMergeRun?
    public let undo: [RestoreMergeUndoPoint]
    public init(stage: RestoreMergeStage?, preview: RestoreMergePreview?, run: RestoreMergeRun?, undo: [RestoreMergeUndoPoint]) {
        self.stage = stage; self.preview = preview; self.run = run; self.undo = undo
    }
}

public struct RestoreMergeStage: Codable, Equatable, Sendable {
    public let restoreId: String
    public let archiveId: String
    public let source: String
    public let bytes: Int64
    public let received: Int64
    /// receiving | ready | checking | previewed | failed | running
    public let state: String
    public let reason: String?
    public init(restoreId: String, archiveId: String, source: String, bytes: Int64, received: Int64, state: String, reason: String? = nil) {
        self.restoreId = restoreId; self.archiveId = archiveId; self.source = source; self.bytes = bytes; self.received = received; self.state = state; self.reason = reason
    }
}

public struct RestoreMergePreview: Codable, Equatable, Sendable {
    public struct Backup: Codable, Equatable, Sendable {
        public let createdAt: Int64?
        public let sourceServer: String?
        public init(createdAt: Int64?, sourceServer: String?) { self.createdAt = createdAt; self.sourceServer = sourceServer }
    }
    public let restoreId: String
    public let backup: Backup
    public let apps: [RestoreMergeApp]
    public init(restoreId: String, backup: Backup, apps: [RestoreMergeApp]) { self.restoreId = restoreId; self.backup = backup; self.apps = apps }
}

public struct RestoreMergeApp: Codable, Equatable, Sendable, Identifiable {
    public struct Side: Codable, Equatable, Sendable {
        public let version: String
        public let bytes: Int64?
        public let installedAt: Int64?
        public let hasDatabase: Bool?
        public let hasFiles: Bool?
        public init(version: String, bytes: Int64?, installedAt: Int64? = nil, hasDatabase: Bool? = nil, hasFiles: Bool? = nil) {
            self.version = version; self.bytes = bytes; self.installedAt = installedAt; self.hasDatabase = hasDatabase; self.hasFiles = hasFiles
        }
    }
    public struct Guards: Codable, Equatable, Sendable {
        public let guardCode: String
        public let guardSchema: String
        public let guardGen: Int
        public init(guardCode: String, guardSchema: String, guardGen: Int) { self.guardCode = guardCode; self.guardSchema = guardSchema; self.guardGen = guardGen }
    }
    public let archivedServiceId: String
    public let name: String
    public let targetServiceId: String
    /// new | runs-elsewhere | same | clash | clash-maybe
    public let verdict: String
    /// same | backup-older | backup-newer | diverged | unknown
    public let code: String
    public let codeByVersion: Bool
    public let schema: String?
    public let backup: Side
    public let box: Side?
    public let alsoOn: [String]
    public let addressMoves: Bool
    public let allowed: [String]
    public let disallowed: [String: String]
    public let recommended: String
    public let copyServiceId: String?
    public let guards: Guards?
    public var id: String { archivedServiceId }
    public init(archivedServiceId: String, name: String, targetServiceId: String, verdict: String, code: String, codeByVersion: Bool = false,
                schema: String?, backup: Side, box: Side?, alsoOn: [String] = [], addressMoves: Bool = false, allowed: [String],
                disallowed: [String: String] = [:], recommended: String, copyServiceId: String?, guards: Guards?) {
        self.archivedServiceId = archivedServiceId; self.name = name; self.targetServiceId = targetServiceId; self.verdict = verdict; self.code = code
        self.codeByVersion = codeByVersion; self.schema = schema; self.backup = backup; self.box = box; self.alsoOn = alsoOn; self.addressMoves = addressMoves
        self.allowed = allowed; self.disallowed = disallowed; self.recommended = recommended; self.copyServiceId = copyServiceId; self.guards = guards
    }
}

public struct RestoreMergeRun: Codable, Equatable, Sendable {
    public struct App: Codable, Equatable, Sendable, Identifiable {
        public let archivedServiceId: String
        public let action: String
        public let targetServiceId: String
        /// waiting … done | failed | kept | skipped | refused-changed
        public let step: String
        public let reason: String?
        public var id: String { archivedServiceId }
        public init(archivedServiceId: String, action: String, targetServiceId: String, step: String, reason: String? = nil) {
            self.archivedServiceId = archivedServiceId; self.action = action; self.targetServiceId = targetServiceId; self.step = step; self.reason = reason
        }
    }
    public let restoreId: String
    /// running | done
    public let state: String
    public let apps: [App]
    public init(restoreId: String, state: String, apps: [App]) { self.restoreId = restoreId; self.state = state; self.apps = apps }
}

public struct RestoreMergeUndoPoint: Codable, Equatable, Sendable, Identifiable {
    public let serviceId: String
    public let name: String
    public let restoreId: String
    public let keptAt: Int64
    public let expiresAt: Int64
    public var id: String { "\(restoreId)/\(serviceId)" }
    public init(serviceId: String, name: String, restoreId: String, keptAt: Int64, expiresAt: Int64) {
        self.serviceId = serviceId; self.name = name; self.restoreId = restoreId; self.keptAt = keptAt; self.expiresAt = expiresAt
    }
}

/// A plan line as the box reads it (absent fields left out).
public struct RestoreMergeLine: Codable, Equatable, Sendable {
    public let archivedServiceId: String
    public let action: String
    public let targetServiceId: String?
    public let sameApp: Bool
    public let guardCode: String?
    public let guardSchema: String?
    public let guardGen: Int?
    public init(archivedServiceId: String, action: String, targetServiceId: String? = nil, sameApp: Bool = false,
                guardCode: String? = nil, guardSchema: String? = nil, guardGen: Int? = nil) {
        self.archivedServiceId = archivedServiceId; self.action = action; self.targetServiceId = targetServiceId; self.sameApp = sameApp
        self.guardCode = guardCode; self.guardSchema = guardSchema; self.guardGen = guardGen
    }
}

public struct RestoreMergeStageOrder: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let archiveId: String
    public let bytes: Int64
    public let sha256: String
    public let source: String
    public let issuedAt: Int64
    public init(serverDomain: String, archiveId: String, bytes: Int64, sha256: String, source: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.archiveId = archiveId; self.bytes = bytes; self.sha256 = sha256; self.source = source; self.issuedAt = issuedAt
    }
}

public struct RestoreMergePlanOrder: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let restoreId: String
    public let archiveId: String
    public let sha256: String
    public let planSha256: String
    public let issuedAt: Int64
    public let expiresAt: Int64
    public init(serverDomain: String, restoreId: String, archiveId: String, sha256: String, planSha256: String, issuedAt: Int64, expiresAt: Int64) {
        self.serverDomain = serverDomain; self.restoreId = restoreId; self.archiveId = archiveId; self.sha256 = sha256
        self.planSha256 = planSha256; self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}

public struct RestoreMergeUndoOrder: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let restoreId: String
    public let serviceId: String
    public let action: String
    public let issuedAt: Int64
    public init(serverDomain: String, restoreId: String, serviceId: String, action: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.restoreId = restoreId; self.serviceId = serviceId; self.action = action; self.issuedAt = issuedAt
    }
}

public struct RestoreMergeSigned<Order: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let order: Order
    public let signatureHex: String
    public let lines: [RestoreMergeLine]?
    /// The signer's hybrid half over the same canonical bytes; a quantum-safe (strict) box refuses the order without it.
    public let pqSignature: PqSignatureWire?
    public init(order: Order, signatureHex: String, lines: [RestoreMergeLine]? = nil, pqSignature: PqSignatureWire? = nil) {
        self.order = order; self.signatureHex = signatureHex; self.lines = lines; self.pqSignature = pqSignature
    }
}

public struct RestoreMergeStarted: Codable, Equatable, Sendable {
    public let restoreId: String
    public let received: Int64?
    public init(restoreId: String, received: Int64? = nil) { self.restoreId = restoreId; self.received = received }
}
