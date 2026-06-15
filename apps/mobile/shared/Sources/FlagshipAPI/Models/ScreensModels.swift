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
    /// "running" | "starting" | "stopped" | "unknown". Older boxes always
    /// send "unknown" (docs/app-placement.md §6).
    public let status: String
    public let version: String?
    public let installedAt: Int64
    /// Internet hosts the app declares and the ones the owner allowed. Absent
    /// on boxes without the egress gateway (show nothing then).
    public var egress: AppEgress? = nil
    /// `{rules, pending}` of the app's access list (§3a). When present it
    /// replaces `egress` on the app page; absent on older boxes.
    public var access: AppAccessSummary? = nil
    /// Present while the box is still receiving this app from another of the
    /// owner's servers (docs/app-placement.md §5).
    public var copying: AppCopying? = nil
    /// The app's name on a row for a copy still underway (no manifest yet).
    public var name: String? = nil
    /// Something is working on the app on this box right now. Absent when
    /// idle and on older boxes.
    public var activity: AppActivity? = nil
    /// Who may open the app: "open" or "members-only". A co-manager of the
    /// server is an ordinary visitor here. Absent on older boxes.
    public var accessMode: String? = nil

    /// A members-only app: anyone not invited to it, a co-manager included,
    /// needs an invite to use it.
    public var isMembersOnly: Bool { accessMode == "members-only" }
}

/// What a box is doing to an app (docs/app-placement.md §6).
public struct AppActivity: Codable, Equatable, Sendable {
    /// "deploying" | "copying" | "editing"; a kind this build doesn't know is
    /// kept as sent and ignored by the pill.
    public let kind: String

    public init(kind: String) { self.kind = kind }

    private enum CodingKeys: String, CodingKey { case kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
    }
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
    /// The box's code-checkout HEAD (full git SHA, lowercase) — the
    /// applied-commit truth the self-update consumer enforces `fromCommit`
    /// against. Optional: an old box's daemon (or a non-git deploy) doesn't
    /// report it, and the update action is disabled without it.
    public let currentCommit: String?
    public let startedAt: Int64
    public let uptimeMs: Int64
    public let certNotAfter: Int64?
    public let certNotBefore: Int64?
    public let certSans: [String]?
    public let serviceCount: Int
    public let pairedSessionCount: Int
    public let recentInstallEvents: [RecentInstallEvent]
    /// Verdict of the most recent update order. Absent from older daemons.
    public var lastUpdate: LastUpdate? = nil
    /// The sandbox every app runs in (gVisor). Absent from older daemons.
    public var appSandbox: AppSandbox? = nil
}

/// The box's app sandbox (docs/app-runtimes.md §5.1): `off`, `starting`,
/// `ready` (with `version`) or `unavailable` (with `reason`: no app can start).
public struct AppSandbox: Codable, Equatable, Sendable {
    public let state: String
    public let version: String?
    public let reason: String?

    public init(state: String, version: String? = nil, reason: String? = nil) {
        self.state = state
        self.version = version
        self.reason = reason
    }

    public struct Notice: Equatable, Sendable {
        public let danger: Bool
        public let text: String

        public init(danger: Bool, text: String) {
            self.danger = danger
            self.text = text
        }
    }

    /// What the server page says, or nil. Matches the webapp's appSandboxNotice.
    public var notice: Notice? {
        switch state {
        case "unavailable":
            return Notice(
                danger: true,
                text: "Apps can't start on this server: the sandbox they run in isn't working (\(reason ?? "unknown reason")). The server tries again every 10 minutes."
            )
        case "starting":
            return Notice(danger: false, text: "Setting up the sandbox apps run in. They start once it's ready.")
        default:
            return nil
        }
    }
}

/// One maintainer-endorsed release, placed relative to the box's running commit.
public struct ReleaseEntry: Codable, Equatable, Sendable, Identifiable {
    public let commit: String
    public let releaseId: String
    public let tag: String
    /// ISO 8601.
    public let endorsedAt: String
    /// "current" | "newer" | "older" | "unrelated".
    public let relation: String
    public var id: String { commit }

    public init(commit: String, releaseId: String, tag: String, endorsedAt: String, relation: String) {
        self.commit = commit; self.releaseId = releaseId; self.tag = tag
        self.endorsedAt = endorsedAt; self.relation = relation
    }
}

/// GET /api/screens/updates: the releases the box verified for itself.
public struct ReleaseCatalogResponse: Codable, Equatable, Sendable {
    public let checkedAt: Int64
    public let currentCommit: String?
    /// Newest endorsed release after the running one, or nil when up to date.
    public let latest: ReleaseEntry?
    /// Newest first.
    public let releases: [ReleaseEntry]
    /// True when the box couldn't fetch and listed from its local copy.
    public let stale: Bool?

    public init(checkedAt: Int64, currentCommit: String?, latest: ReleaseEntry?, releases: [ReleaseEntry], stale: Bool?) {
        self.checkedAt = checkedAt; self.currentCommit = currentCommit; self.latest = latest
        self.releases = releases; self.stale = stale
    }
}

/// The box's record of the last update order: applied, rolled back after the
/// new code failed its boot health gate, or refused with a reason.
public struct LastUpdate: Codable, Equatable, Sendable {
    public let outcome: String
    public let at: Int64
    public let targetCommit: String?
    public let previousCommit: String?
    public let bootAttempts: Int?
    public let reason: String?

    public init(outcome: String, at: Int64, targetCommit: String? = nil, previousCommit: String? = nil, bootAttempts: Int? = nil, reason: String? = nil) {
        self.outcome = outcome
        self.at = at
        self.targetCommit = targetCommit
        self.previousCommit = previousCommit
        self.bootAttempts = bootAttempts
        self.reason = reason
    }

    /// One sentence for the update card, or nil for an outcome this build
    /// doesn't know. Matches the webapp's describeLastUpdate.
    public var summary: String? {
        func short(_ sha: String?) -> String? {
            guard let sha, sha.count == 40, sha.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
            return String(sha.prefix(8))
        }
        switch outcome {
        case "applied":
            return short(targetCommit).map { "Last update: \($0) installed and running." } ?? "Last update installed and running."
        case "rolled-back":
            let to = short(targetCommit).map { " to \($0)" } ?? ""
            let back = short(previousCommit).map { " to \($0)" } ?? ""
            return "The last update\(to) didn't start cleanly, so the server went back\(back) on its own."
        case "refused":
            guard let why = Self.refusalCopy[reason ?? ""] else { return "The server refused the last update." }
            return "The server refused the last update: \(why)"
        default:
            return nil
        }
    }

    private static let refusalCopy: [String: String] = [
        "unendorsed": "Flagship's maintainers haven't endorsed that release.",
        "from-commit-mismatch": "the server was no longer on the version the update was made for. Send it again.",
        "apply-failed": "it couldn't download or build the new version. Nothing changed.",
        "rejected": "the request wasn't signed by this account's admin key.",
        "stale": "the request was too old. Send it again.",
        "wrong-domain": "the request was for a different server.",
    ]
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
    /// The owner can change its code from the phone (built on this box, with
    /// its source there). Absent on older boxes.
    public var editable: Bool? = nil
    /// Built from a shared repo adaptation: the repo it adapts, so the page
    /// can offer to report a problem with it.
    public var adaptedFrom: AdaptedFrom? = nil

    public struct AdaptedFrom: Codable, Equatable {
        public let repo: String
        public init(repo: String) { self.repo = repo }
    }

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

// MARK: - BYOK provider credential

/// A bring-your-own-key LLM-provider credential. Travels phone → box ONLY,
/// over the paired-session-gated pinned pipe; the box terminates TLS and
/// calls the provider directly with this key. flagshipserver.com is NEVER
/// in this path. The daemon seals it for the session/build, never echoes
/// it, never logs it, and never journals the value (at most the provider
/// NAME). The raw key only ever lives in a typed input or the device-local
/// `SavedKeyStore` Keychain.
///
/// WIRE: `{ "provider": "anthropic", "apiKey": "<owner key>", "baseUrl"? }`
/// MIRRORS: `LlmProviderCredential` in
/// packages/server-daemon/src/screens/types.ts + the `parseCredential`
/// validator in buildmodes/buildModesHttp.ts + apps/web/.../providers.js.
public struct LlmProviderCredential: Codable, Equatable, Sendable {
    /// Provider name, e.g. "anthropic" | "openai" | "google".
    public let provider: String
    /// The owner's API key. SECRET — never logged.
    public let apiKey: String
    /// Optional override base URL for an OpenAI-compatible / proxy endpoint.
    public let baseUrl: String?
    /// Send this key's calls through the Flagship relay (the provider sees
    /// Flagship's address, not the box's). Absent ⇒ ON on the box; the app
    /// always sends it for a saved key.
    public let relay: Bool?
    /// Provenance: "promo" marks a Flagship free-AI token (the box pins its
    /// calls to the token's own endpoint); absent / "byok" ⇒ the owner's key.
    public let source: String?
    public init(provider: String, apiKey: String, baseUrl: String? = nil, relay: Bool? = nil,
                source: String? = nil) {
        self.provider = provider
        self.apiKey = apiKey
        self.baseUrl = baseUrl
        self.relay = relay
        self.source = source
    }

    /// A Flagship free-AI credential (minted fresh per send, never saved).
    public var isFreeAi: Bool { source == "promo" }
}

/// A box refused an AI call because the key asked for the Flagship relay and
/// the relay wasn't there (it never falls back to a direct call). MIRRORS the
/// messages in packages/server-daemon/src/tunnel/outboundStream.ts.
public enum RelayFailure {
    public static func matches(_ text: String?) -> Bool {
        guard let t = text?.lowercased() else { return false }
        if t.contains("relay-unavailable") { return true }
        guard t.contains("the flagship relay") else { return false }
        return t.contains("isn't reachable") || t.contains("didn't connect to")
    }
}

// MARK: - P1.4 marketplace-browse

public struct MarketplaceListing: Codable, Equatable, Sendable {
    public let creator: String
    public let slug: String
    public let title: String
    public let summary: String
    public let screenshots: [String]
    public let installCount: Int
    public let requiresLlmKey: Bool
    public let alreadyInstalled: Bool
}

public struct MarketplaceBrowseResponse: Codable, Equatable, Sendable {
    public let listings: [MarketplaceListing]
}

/// Single-listing fetch (`GET https://flagshipserver.com/api/marketplace/<creator>/<slug>`).
/// MIRRORS the webapp's `fetchListing` in
/// `apps/web/public/webapp/lib/installService.js` — same field is required
/// (`manifestJson` is opaque JSON the daemon verifies on install). Extra
/// fields the .com worker returns are tolerated by Codable.
public struct MarketplaceListingDetail: Codable, Equatable, Sendable {
    public let creator: String
    public let slug: String
    public let title: String
    public let summary: String
    public let manifestJson: String
    public init(
        creator: String,
        slug: String,
        title: String,
        summary: String,
        manifestJson: String
    ) {
        self.creator = creator
        self.slug = slug
        self.title = title
        self.summary = summary
        self.manifestJson = manifestJson
    }
}

/// Install-marketplace-app request. MIRRORS the webapp wire shape in
/// `apps/web/public/webapp/lib/installService.js` byte-for-byte: same field
/// names, same canonical tag (`flagship/install-service/v1`), same envelope
/// (`{ request, signature }`) — see `installServiceCanonicalBytes` for the
/// canonical-bytes implementation. The daemon endpoint is
/// `POST <pod>/api/services` (NOT under `/api/screens/*` — the install
/// pipeline lives on the service-platform handler in
/// `packages/server-daemon/src/servicePlatform.ts`).
public struct InstallServiceRequest: Codable, Equatable, Sendable {
    public let serverId: String
    public let creator: String
    public let slug: String
    public let manifestJson: String
    public let addOwnerToMembership: Bool
    public let issuedAt: Int64
    public init(
        serverId: String,
        creator: String,
        slug: String,
        manifestJson: String,
        addOwnerToMembership: Bool,
        issuedAt: Int64
    ) {
        self.serverId = serverId
        self.creator = creator
        self.slug = slug
        self.manifestJson = manifestJson
        self.addOwnerToMembership = addOwnerToMembership
        self.issuedAt = issuedAt
    }
}

/// `{request, signature}` envelope expected by `POST <pod>/api/services`.
/// `signature` is the hex-encoded Ed25519 signature of
/// `installServiceCanonicalBytes(request)` produced with the user's IRK.
public struct InstallServiceEnvelope: Codable, Equatable, Sendable {
    public let request: InstallServiceRequest
    public let signature: String
    public init(request: InstallServiceRequest, signature: String) {
        self.request = request
        self.signature = signature
    }
}

/// Daemon's success body for `POST /api/services`. Mirrors
/// `installService` in `servicePlatform.ts`.
public struct InstallServiceResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public let serviceId: String
    public let urlLabel: String
    public let port: Int?
    public init(ok: Bool, serviceId: String, urlLabel: String, port: Int? = nil) {
        self.ok = ok
        self.serviceId = serviceId
        self.urlLabel = urlLabel
        self.port = port
    }
}

/// Canonical-bytes for `InstallServiceRequest`, byte-identical with
/// `canonicalInstallService` in
/// `apps/web/public/webapp/lib/installService.js` and with the TS protocol
/// in `packages/protocol/src/auth.ts` (`canonicalInstallService`). Format:
///
///     flagship/install-service/v1 | serverId | creator | slug | manifestJson | (1|0) | issuedAt
///
/// `addOwnerToMembership` is encoded as `"1"` (true) or `"0"` (false) to
/// match the webapp; `issuedAt` is a base-10 integer (no separator inside
/// the value, no padding).
public func installServiceCanonicalBytes(_ r: InstallServiceRequest) -> Data {
    let parts: [String] = [
        "flagship/install-service/v1",
        r.serverId,
        r.creator,
        r.slug,
        r.manifestJson,
        r.addOwnerToMembership ? "1" : "0",
        String(r.issuedAt),
    ]
    return Data(parts.joined(separator: "|").utf8)
}

// MARK: - P1.5 vibe-code/start

public struct VibeCodeStartRequest: Codable, Equatable, Sendable {
    public let prompt: String
    public let model: String?
    /// BYOK provider credential the box uses to drive this session. Delivered
    /// ONCE here; the daemon seals it for the session and reuses it on every
    /// later turn. Omitted ⇒ the box falls back to whatever it has (and may
    /// answer `needsCredential: true`).
    public let credential: LlmProviderCredential?
    /// Owner-chosen service name/slug (the web address label) — decided on the
    /// Describe form, not fixed. Optional for back-compat; the daemon treats it
    /// as a hint for the deployed service's slug.
    public let name: String?
    /// Owner-chosen reach: "just-me" (gated to the owner) or "link" (anyone with
    /// the link). Optional for back-compat; the daemon applies it at install.
    public let visibility: String?
    /// Change this installed service (`<creator>--<slug>`) instead of building
    /// a new one. The box ignores `name` and `visibility` when it's set.
    public let editServiceId: String?
    /// Reasoning effort in the provider's own words; absent ⇒ its default.
    public let effort: String?
    /// Files on the opening turn (≤ 6; the AI sees them).
    public let attachments: [VibeCodeAttachment]?
    public init(prompt: String, model: String?, credential: LlmProviderCredential? = nil,
                name: String? = nil, visibility: String? = nil, editServiceId: String? = nil,
                effort: String? = nil, attachments: [VibeCodeAttachment]? = nil) {
        self.prompt = prompt
        self.model = model
        self.credential = credential
        self.name = name
        self.visibility = visibility
        self.editServiceId = editServiceId
        self.effort = effort
        self.attachments = attachments?.isEmpty == true ? nil : attachments
    }
}

public struct VibeCodeStartResponse: Codable, Equatable, Sendable {
    public let sessionId: String
    /// Graceful-absence signal: `true` when the session was created but NO
    /// model is driving it because no BYOK credential is available. The
    /// client routes back into the AI-key step to deliver one + retry.
    /// Omitted / `false` when a model IS driving the session.
    public let needsCredential: Bool?
    public init(sessionId: String, needsCredential: Bool? = nil) {
        self.sessionId = sessionId
        self.needsCredential = needsCredential
    }
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
    /// While "deploying": "staging" | "fixing" | "going-live". Older boxes omit it.
    public var deployPhase: String? = nil

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
// "Remote" mints a 60-second pairing ticket on the pod; the
// owner's phone shows it as a QR. A desktop browser scans, hits
// `POST /api/companion/redeem` against the pod, and is granted a
// 4-hour read-only companion session. The phone owns mint + list +
// revoke; the browser owns redeem (out of scope for iOS).

public struct CompanionMintTicketRequest: Codable, Equatable, Sendable {
    public init() {}
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
    public let redeemedAt: Int64
    public let lastSeenMs: Int64
    public let expiresAt: Int64
    public let userAgent: String?

    public var id: String { tokenPrefix }

    public init(
        tokenPrefix: String,
        redeemedAt: Int64,
        lastSeenMs: Int64,
        expiresAt: Int64,
        userAgent: String? = nil
    ) {
        self.tokenPrefix = tokenPrefix
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
    public let kind: String
    public let intent: [String: AnyCodable]
    public let queuedAt: Int64
    public let expiresAt: Int64

    public var id: String { requestId }

    public init(
        requestId: String,
        companionTokenPrefix: String,
        kind: String,
        intent: [String: AnyCodable],
        queuedAt: Int64,
        expiresAt: Int64
    ) {
        self.requestId = requestId
        self.companionTokenPrefix = companionTokenPrefix
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
    /// What the owner attached on this turn (user messages).
    public let attachments: [VibeCodeAttachment]?
    /// Flagship Inference: credits this reply cost (assistant messages).
    public let credits: Double?
    public init(role: String, text: String, timestamp: Int64,
                attachments: [VibeCodeAttachment]? = nil, credits: Double? = nil) {
        self.role = role; self.text = text; self.timestamp = timestamp
        self.attachments = attachments; self.credits = credits
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

/// One entry of the daemon's in-memory vibe-code registry
/// (`GET /api/llm/sessions`). A session listed here can be reopened; one
/// missing from it ended with a daemon restart and survives only as its
/// build-journal timeline.
public struct VibeCodeSessionMeta: Codable, Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let startedAt: Int64
    /// streaming | awaiting-tool-response | ready-to-deploy | deploying | deployed | failed | cancelled
    public let status: String
    public let serviceId: String?
    public let url: String?
    /// The owner's chosen name, which the session holds until it is deployed
    /// or discarded. Absent on sessions from before names were kept.
    public let name: String?
    public var id: String { sessionId }
    public init(sessionId: String, startedAt: Int64, status: String, serviceId: String? = nil, url: String? = nil,
                name: String? = nil) {
        self.sessionId = sessionId; self.startedAt = startedAt; self.status = status
        self.serviceId = serviceId; self.url = url; self.name = name
    }
    /// Discarding frees the name; a deployed session's name is its app's.
    public var canDiscard: Bool { status != "deployed" }
    /// Still working or waiting on the owner: worth resuming.
    public var isActive: Bool {
        ["streaming", "awaiting-tool-response", "ready-to-deploy", "deploying"].contains(status)
    }
}

/// `GET /api/screens/vibe-code/name-check`, and the body of a 409 from
/// `vibeCodeStart`. `kind` is "invalid", "app" (an installed service) or
/// "session" (an open build session, stopped from the build-sessions list).
public struct VibeCodeNameCheck: Codable, Equatable, Sendable {
    public let ok: Bool
    public let name: String?
    public let kind: String?
    public let serviceId: String?
    public let sessionId: String?
    public let message: String?
    public init(ok: Bool, name: String? = nil, kind: String? = nil, serviceId: String? = nil,
                sessionId: String? = nil, message: String? = nil) {
        self.ok = ok; self.name = name; self.kind = kind
        self.serviceId = serviceId; self.sessionId = sessionId; self.message = message
    }
    public static let unknown = VibeCodeNameCheck(ok: true)

    /// A refused start, if `error` is the box's 409 for a taken name.
    public static func conflict(in error: Error) -> VibeCodeNameCheck? {
        guard case let ScreensClientError.http(status, message) = error, status == 409,
              let check = try? JSONDecoder().decode(VibeCodeNameCheck.self, from: Data(message.utf8)),
              !check.ok else { return nil }
        return check
    }
}

public struct VibeCodeSessionsResponse: Codable, Equatable, Sendable {
    public let sessions: [VibeCodeSessionMeta]
    public init(sessions: [VibeCodeSessionMeta]) { self.sessions = sessions }
}

public struct VibeCodeSessionPublicState: Codable, Equatable, Sendable {
    public let id: String
    public let appId: String?
    public let status: String
    public let messages: [VibeCodeSessionMessage]
    public let pendingRequest: VibeCodePendingRequest?
    /// Why the session failed (status "failed").
    public let failureReason: String?
    /// The AI is waiting but the box has no key for this session: the reply
    /// must carry one.
    public let needsCredential: Bool?
    /// While "deploying": "staging" | "fixing" | "going-live". Older boxes omit it.
    public let deployPhase: String?
    /// The model and effort the conversation uses now.
    public let model: String?
    public let effort: String?
    /// Older turns were condensed to fit the model's context.
    public let summarised: Bool?
    public init(
        id: String,
        appId: String?,
        status: String,
        messages: [VibeCodeSessionMessage],
        pendingRequest: VibeCodePendingRequest?,
        failureReason: String? = nil,
        needsCredential: Bool? = nil,
        deployPhase: String? = nil,
        model: String? = nil,
        effort: String? = nil,
        summarised: Bool? = nil
    ) {
        self.id = id; self.appId = appId; self.status = status
        self.messages = messages; self.pendingRequest = pendingRequest
        self.failureReason = failureReason; self.needsCredential = needsCredential
        self.deployPhase = deployPhase
        self.model = model; self.effort = effort; self.summarised = summarised
    }
}

public struct VibeCodeReplyRequest: Codable, Equatable, Sendable {
    public let text: String?
    public let envVarStatus: String?   // "set" | "declined" | "deferred"
    /// BYOK provider credential. Normally `start`'s credential is reused for
    /// the whole session, so a reply need NOT carry one — it's supplied here
    /// only to seed a session that started without one (the `needsCredential`
    /// case) before resuming. Same box-only, never-logged contract.
    public let credential: LlmProviderCredential?
    /// The model for this and later turns (same values as on start).
    public let model: String?
    /// The reasoning effort. Sent whenever `model` is, as `null` for the
    /// provider's default, so turning "Think harder" off takes effect.
    public let effort: String?
    public let attachments: [VibeCodeAttachment]?
    public init(text: String? = nil, envVarStatus: String? = nil, credential: LlmProviderCredential? = nil,
                model: String? = nil, effort: String? = nil, attachments: [VibeCodeAttachment]? = nil) {
        self.text = text; self.envVarStatus = envVarStatus; self.credential = credential
        self.model = model; self.effort = effort
        self.attachments = attachments?.isEmpty == true ? nil : attachments
    }

    private enum CodingKeys: String, CodingKey {
        case text, envVarStatus, credential, model, effort, attachments
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(envVarStatus, forKey: .envVarStatus)
        try c.encodeIfPresent(credential, forKey: .credential)
        try c.encodeIfPresent(model, forKey: .model)
        if model != nil { try c.encode(effort, forKey: .effort) } else { try c.encodeIfPresent(effort, forKey: .effort) }
        try c.encodeIfPresent(attachments, forKey: .attachments)
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

