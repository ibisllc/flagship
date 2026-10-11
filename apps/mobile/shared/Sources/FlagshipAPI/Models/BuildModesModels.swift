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

/// `POST /api/build/git {gitUrl, ref?, name?}`. A taken `name` is a 409
/// shaped like `VibeCodeNameCheck`; a repo that can't be cloned is a 422.
public struct BuildGitRequest: Codable, Equatable, Sendable {
    public let gitUrl: String
    public let ref: String?
    /// The service's name. Nil: the box names it from the repo and branch.
    public let name: String?
    /// False: never share this repo's adaptation with the public store.
    public let share: Bool?
    public init(gitUrl: String, ref: String? = nil, name: String? = nil, share: Bool? = nil) {
        self.gitUrl = gitUrl
        self.ref = ref
        self.name = name
        self.share = share
    }
}

/// `→ {buildId, fit, reason, manifestName?, fileCount, name?}`
public struct BuildGitResponse: Codable, Equatable, Sendable {
    public let buildId: String
    public let fit: Bool
    public let reason: String
    public let manifestName: String?
    public let fileCount: Int
    /// The name it will be installed under (older boxes don't send one).
    public let name: String?
    public init(buildId: String, fit: Bool, reason: String, manifestName: String? = nil, fileCount: Int,
                name: String? = nil) {
        self.buildId = buildId
        self.fit = fit
        self.reason = reason
        self.manifestName = manifestName
        self.fileCount = fileCount
        self.name = name
    }
}

/// `POST /api/build/sessions/:id/adapt {instructions?, credential?}`
public struct BuildAdaptRequest: Codable, Equatable, Sendable {
    public let instructions: String?
    /// BYOK provider credential the box uses to drive the AI adapt pass.
    /// Stored keyed by buildId on the box; the adaptRunner opens it
    /// just-in-time. Box-only, never logged. Omitted ⇒ the box uses what it
    /// has and may answer 503 ("AI adapt not configured" → fall back to
    /// scratch). MIRRORS the `credential` field parsed in buildModesHttp.ts.
    public let credential: LlmProviderCredential?
    /// Answer at once and run in the background; poll `buildState` for
    /// `adapt`. Older boxes ignore it and answer when the AI is done.
    public let background: Bool?
    public init(instructions: String? = nil, credential: LlmProviderCredential? = nil, background: Bool? = nil) {
        self.instructions = instructions
        self.credential = credential
        self.background = background
    }
}

/// The adapt reply when it was asked to run in the background: `started`
/// from a current box, or the finished result from an older one.
public struct BuildAdaptReply: Codable, Equatable, Sendable {
    public let ok: Bool?
    public let started: Bool?
    public let fileCount: Int?
    public let deployed: Bool?
    public let deployedUrl: String?
    public init(ok: Bool? = true, started: Bool? = nil, fileCount: Int? = nil, deployed: Bool? = nil, deployedUrl: String? = nil) {
        self.ok = ok; self.started = started; self.fileCount = fileCount
        self.deployed = deployed; self.deployedUrl = deployedUrl
    }
}

/// How a background adapt is going. `status`: "running" | "done" | "failed".
public struct BuildAdaptStatus: Codable, Equatable, Sendable {
    public let status: String
    public let fileCount: Int?
    public let deployed: Bool?
    public let deployedUrl: String?
    public let reason: String?
    public init(status: String, fileCount: Int? = nil, deployed: Bool? = nil, deployedUrl: String? = nil, reason: String? = nil) {
        self.status = status; self.fileCount = fileCount; self.deployed = deployed
        self.deployedUrl = deployedUrl; self.reason = reason
    }
}

/// `GET /api/build/sessions/:id` → `{state, files}`
public struct BuildStateResponse: Codable, Equatable, Sendable {
    public struct State: Codable, Equatable, Sendable {
        public let buildId: String
        public let mode: String
        public let name: String?
        public let deployedUrl: String?
        public let adapt: BuildAdaptStatus?
        public init(buildId: String, mode: String, name: String? = nil, deployedUrl: String? = nil, adapt: BuildAdaptStatus? = nil) {
            self.buildId = buildId; self.mode = mode; self.name = name
            self.deployedUrl = deployedUrl; self.adapt = adapt
        }
    }
    public let state: State
    public let files: [String]
    public init(state: State, files: [String] = []) {
        self.state = state
        self.files = files
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
    /// Start the IDE build from this installed service's code; deploying
    /// replaces it in place.
    public let editServiceId: String?
    public init(label: String? = nil, editServiceId: String? = nil) {
        self.label = label
        self.editServiceId = editServiceId
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
    /// Set by a vibe-code deploy the owner asked to be invite only: whether
    /// the box put it behind its gate (false: it couldn't, so it is open).
    public let inviteOnly: Bool?
    public init(ok: Bool, serviceId: String, url: String, inviteOnly: Bool? = nil) {
        self.ok = ok
        self.serviceId = serviceId
        self.url = url
        self.inviteOnly = inviteOnly
    }
}

// MARK: - journal

/// `GET /api/build/sessions` → `{builds:[…]}`. One summary per build.
public struct BuildSummary: Codable, Equatable, Sendable, Identifiable {
    public let buildId: String
    /// "scratch" | "git" | "mcp"
    public let mode: String
    public let serviceId: String?
    /// The name it was given (owner, repo or IDE), else its service's slug.
    public let name: String?
    public let startedAt: Int64
    public let lastAt: Int64
    public let entryCount: Int
    public let lastKind: String
    /// The box still holds this git or IDE build: it holds its name until it
    /// deploys or is discarded.
    public let open: Bool?
    public var id: String { buildId }
    public init(
        buildId: String,
        mode: String,
        serviceId: String? = nil,
        name: String? = nil,
        startedAt: Int64,
        lastAt: Int64,
        entryCount: Int,
        lastKind: String,
        open: Bool? = nil
    ) {
        self.buildId = buildId
        self.mode = mode
        self.serviceId = serviceId
        self.name = name
        self.startedAt = startedAt
        self.lastAt = lastAt
        self.entryCount = entryCount
        self.lastKind = lastKind
        self.open = open
    }
}

public extension BuildSummary {
    /// The list title: the build's name, or its service, or when it started.
    var displayName: String {
        if let name, !name.isEmpty { return name }
        if let serviceId, let slug = serviceId.components(separatedBy: "--").last, !slug.isEmpty { return slug }
        return "Unnamed build"
    }
    /// How it was made, for the pill beside the name.
    var methodLabel: String { Self.methodLabel(mode) }
    static func methodLabel(_ mode: String) -> String {
        switch mode {
        case "git": return "From Git"
        case "mcp": return "From your IDE"
        default: return "AI chat"
        }
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
