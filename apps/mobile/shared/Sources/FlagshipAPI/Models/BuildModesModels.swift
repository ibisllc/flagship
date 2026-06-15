import Foundation

// Build-a-service multi-mode wire shapes.
//
// MIRRORS: packages/server-daemon/src/buildmodes/buildModesHttp.ts
//          packages/server-daemon/src/buildmodes/buildOrchestrator.ts
//          packages/server-daemon/src/buildmodes/buildJournal.ts
//          apps/web/public/webapp/views/build-*.js
//
// All paired-session gated (`x-flagship-session`), same client as the
// rest of the screens surface. The MCP per-build bearer key surfaced in
// `BuildMcpConnection` is a SEPARATE auth that the user pastes into their
// IDE; the phone never uses it.

// MARK: - git

/// `POST /api/build/git {gitUrl, ref?}`
public struct BuildGitRequest: Codable, Equatable, Sendable {
    public let gitUrl: String
    public let ref: String?
    public init(gitUrl: String, ref: String? = nil) {
        self.gitUrl = gitUrl
        self.ref = ref
    }
}

/// `→ {buildId, fit, reason, manifestName?, fileCount}`
public struct BuildGitResponse: Codable, Equatable, Sendable {
    public let buildId: String
    public let fit: Bool
    public let reason: String
    public let manifestName: String?
    public let fileCount: Int
    public init(buildId: String, fit: Bool, reason: String, manifestName: String? = nil, fileCount: Int) {
        self.buildId = buildId
        self.fit = fit
        self.reason = reason
        self.manifestName = manifestName
        self.fileCount = fileCount
    }
}

/// `POST /api/build/sessions/:id/adapt {instructions?}`
public struct BuildAdaptRequest: Codable, Equatable, Sendable {
    public let instructions: String?
    public init(instructions: String? = nil) {
        self.instructions = instructions
    }
}

/// `→ {ok, fileCount}` (503 = "AI adapt not configured" → fall back to scratch)
public struct BuildAdaptResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let fileCount: Int
    public init(ok: Bool, fileCount: Int) {
        self.ok = ok
        self.fileCount = fileCount
    }
}

// MARK: - mcp

/// `POST /api/build/mcp {label?}` / `POST /api/build/sessions/:id/mcp/rotate {label?}`
public struct BuildMcpRequest: Codable, Equatable, Sendable {
    public let label: String?
    public init(label: String? = nil) {
        self.label = label
    }
}

/// The connection an external IDE (Cursor/Cline) pastes in: the MCP URL,
/// the per-build bearer key, and a ready-to-paste IDE config blob. The
/// key binds the IDE to exactly this one build session.
public struct BuildMcpConnection: Codable, Equatable {
    public let url: String
    public let key: String
    /// Free-form IDE config object (e.g. `{ "mcpServers": { … } }`). Kept
    /// as `AnyCodable` so the daemon owns the exact shape; the client only
    /// pretty-prints it for copy. (`AnyCodable` is not `Sendable`, so neither
    /// is this — matches `OrdersSendResponse`/`AppDetailResponse`.)
    public let ideConfig: [String: AnyCodable]
    public init(url: String, key: String, ideConfig: [String: AnyCodable]) {
        self.url = url
        self.key = key
        self.ideConfig = ideConfig
    }
}

/// `POST /api/build/mcp` → `{buildId, connection}`
public struct BuildMcpResponse: Codable, Equatable {
    public let buildId: String
    public let connection: BuildMcpConnection
    public init(buildId: String, connection: BuildMcpConnection) {
        self.buildId = buildId
        self.connection = connection
    }
}

// MARK: - env-requests (value-free)

/// One value-free env var an authoring agent (IDE or AI) asked the owner
/// to set on the box. NEVER carries a value. `requestedBy` is "ide" | "ai".
public struct BuildEnvRequest: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let why: String?
    public let secret: Bool?
    public let requestedAt: Int64
    public let requestedBy: String
    public let currentlySet: Bool
    public var id: String { name }
    public init(
        name: String,
        why: String? = nil,
        secret: Bool? = nil,
        requestedAt: Int64,
        requestedBy: String,
        currentlySet: Bool
    ) {
        self.name = name
        self.why = why
        self.secret = secret
        self.requestedAt = requestedAt
        self.requestedBy = requestedBy
        self.currentlySet = currentlySet
    }
}

/// `GET /api/build/sessions/:id/env-requests` → `{requests:[…]}`
public struct BuildEnvRequestsResponse: Codable, Equatable, Sendable {
    public let requests: [BuildEnvRequest]
    public init(requests: [BuildEnvRequest]) {
        self.requests = requests
    }
}

// MARK: - deploy

/// `POST /api/build/sessions/:id/deploy` → `{ok, serviceId, url}`
public struct BuildDeployResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let serviceId: String
    public let url: String
    public init(ok: Bool, serviceId: String, url: String) {
        self.ok = ok
        self.serviceId = serviceId
        self.url = url
    }
}

// MARK: - journal

/// `GET /api/build/sessions` → `{builds:[…]}`. One summary per build.
public struct BuildSummary: Codable, Equatable, Sendable, Identifiable {
    public let buildId: String
    /// "scratch" | "git" | "mcp"
    public let mode: String
    public let serviceId: String?
    public let startedAt: Int64
    public let lastAt: Int64
    public let entryCount: Int
    public let lastKind: String
    public var id: String { buildId }
    public init(
        buildId: String,
        mode: String,
        serviceId: String? = nil,
        startedAt: Int64,
        lastAt: Int64,
        entryCount: Int,
        lastKind: String
    ) {
        self.buildId = buildId
        self.mode = mode
        self.serviceId = serviceId
        self.startedAt = startedAt
        self.lastAt = lastAt
        self.entryCount = entryCount
        self.lastKind = lastKind
    }
}

public struct BuildSessionsResponse: Codable, Equatable, Sendable {
    public let builds: [BuildSummary]
    public init(builds: [BuildSummary]) {
        self.builds = builds
    }
}

/// One append-only journal line. Value-free by contract (secret-shaped
/// tokens redacted on the box before they ever reach here).
public struct BuildJournalEntry: Codable, Equatable, Sendable, Identifiable {
    public let seq: Int
    public let ts: Int64
    public let buildId: String
    /// "scratch" | "git" | "mcp"
    public let mode: String
    /// e.g. "session-started" | "git-clone" | "fitness-check" | "deployed" …
    public let kind: String
    /// "owner" | "ai" | "ide" | "system"
    public let actor: String
    public let summary: String
    public let detail: String?
    public let serviceId: String?
    public var id: Int { seq }
    public init(
        seq: Int,
        ts: Int64,
        buildId: String,
        mode: String,
        kind: String,
        actor: String,
        summary: String,
        detail: String? = nil,
        serviceId: String? = nil
    ) {
        self.seq = seq
        self.ts = ts
        self.buildId = buildId
        self.mode = mode
        self.kind = kind
        self.actor = actor
        self.summary = summary
        self.detail = detail
        self.serviceId = serviceId
    }
}

/// `GET /api/build/sessions/:id/journal` → `{entries:[…]}`
public struct BuildJournalResponse: Codable, Equatable, Sendable {
    public let entries: [BuildJournalEntry]
    public init(entries: [BuildJournalEntry]) {
        self.entries = entries
    }
}
