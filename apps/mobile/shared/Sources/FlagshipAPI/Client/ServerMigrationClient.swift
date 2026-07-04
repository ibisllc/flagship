import Foundation

/// Server-migration client — "Migrate to new hardware" (docs/server-migration.md):
/// same owner, same `<server>.<user>` name, NEW box. Mirrors the webapp's
/// `lib/serverMigration.js` wire bodies + the control-plane handlers
/// (`packages/control-plane/src/serverMigration.ts`) exactly:
///
///   POST /api/server/:domain/migration                 phone, admin-signed initiate (IRK mailbox-auth)
///   GET  /api/server/:domain/migration                 PUBLIC phase state (404 ⇒ no session)
///   POST /api/server/:domain/migration/confirm-ready   phone, admin-signed control (409 unless pre-seeded)
///   POST /api/server/:domain/migration/freeze          phone, the EXISTING decommission deposit body,
///                                                      session-validated (409 unless ready/freezing)
///   POST /api/server/:domain/migration/abort           phone, admin-signed control (409 after take-over)
///
/// The wire types are PURE (no crypto): `FlagshipCore.ServerMigrationFlow`
/// builds the admin-signed order/control + the IRK mailbox-auth and hands the
/// finished bytes here. Field names match the Worker handlers' JSON exactly
/// (the Mock-matches-Worker-wire invariant).
public protocol ServerMigrationClient: Sendable {
    /// Phase 1 — deposit the admin-signed ServerMigrationOrder. Throws on non-2xx
    /// (409 ⇒ a different migration is already in progress).
    func startMigration(serverDomain: String, body: MigrationStartBody) async throws

    /// The public progress timeline. Returns nil when no session exists (404).
    func fetchMigration(serverDomain: String) async throws -> MigrationSession?

    /// Phase 4 — admin-signed confirm-ready (409 unless the session is pre-seeded).
    func confirmReady(serverDomain: String, body: MigrationControlBody) async throws

    /// Phase 5 — freeze: EXACTLY the graceful-decommission deposit (the eviction
    /// lane reused verbatim), posted to the session-validated freeze route.
    func freeze(serverDomain: String, body: DecommissionDepositBody) async throws

    /// Abort — allowed at every phase before take-over; 409 after (the point of
    /// no return).
    func abortMigration(serverDomain: String, body: MigrationControlBody) async throws
}

// MARK: - Wire types

/// The ServerMigrationOrder wire object (matches the Worker `order` key).
public struct MigrationOrderWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let oldStkPubHex: String     // hex (32 bytes) — the CURRENT instance's STK
    public let diskDisposition: String  // "keep" | "wipe-after-handoff" (never "wipe-now")
    public let nonce: String            // hex (32 bytes)
    public let issuedAt: Int64
    public init(serverDomain: String, oldStkPubHex: String, diskDisposition: String, nonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.oldStkPubHex = oldStkPubHex
        self.diskDisposition = diskDisposition; self.nonce = nonce; self.issuedAt = issuedAt
    }
}

/// `{ auth, authSignature, order, signature }` — the initiate deposit.
public struct MigrationStartBody: Encodable, Equatable, Sendable {
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let order: MigrationOrderWire
    public let signature: String   // hex (64 bytes) — admin root (or legacy IRK) over the order canonical bytes
    public init(auth: MailboxAuthEnvelope.Auth, authSignature: String, order: MigrationOrderWire, signature: String) {
        self.auth = auth; self.authSignature = authSignature
        self.order = order; self.signature = signature
    }
}

/// The ServerMigrationControl wire object (matches the Worker `control` key).
public struct MigrationControlWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let action: String   // "confirm-ready" | "abort"
    public let nonce: String    // hex (32 bytes)
    public let issuedAt: Int64
    public init(serverDomain: String, action: String, nonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.action = action
        self.nonce = nonce; self.issuedAt = issuedAt
    }
}

/// `{ auth, authSignature, control, signature }` — confirm-ready / abort.
public struct MigrationControlBody: Encodable, Equatable, Sendable {
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let control: MigrationControlWire
    public let signature: String
    public init(auth: MailboxAuthEnvelope.Auth, authSignature: String, control: MigrationControlWire, signature: String) {
        self.auth = auth; self.authSignature = authSignature
        self.control = control; self.signature = signature
    }
}

/// The GET body — the session's phase state + the 8-step timeline stamps.
/// `finalDeltaAt`/`oldClosedOutAt` are joined live from the eviction row by
/// the Worker. Decoded leniently (absent stamps ⇒ nil) so a newer Worker
/// field never breaks the poll.
public struct MigrationSession: Codable, Equatable, Sendable {
    public let serverDomain: String
    /// initiated | provisioned | pre-seeded | ready | freezing | taken-over | aborted
    public let phase: String
    public let disposition: String
    public let oldStkPubHex: String
    public let newServerDomain: String?
    public let newStkPubHex: String?
    public let initiatedAt: Int64?
    public let attachedAt: Int64?
    public let preSeededAt: Int64?
    public let readyAt: Int64?
    public let freezeAt: Int64?
    public let finalDeltaAt: Int64?
    public let takenOverAt: Int64?
    public let abortedAt: Int64?
    public let oldClosedOutAt: Int64?
    /// Derived by the Worker: taken over AND the old box closed out.
    public let done: Bool

    public init(
        serverDomain: String, phase: String, disposition: String, oldStkPubHex: String,
        newServerDomain: String? = nil, newStkPubHex: String? = nil,
        initiatedAt: Int64? = nil, attachedAt: Int64? = nil, preSeededAt: Int64? = nil,
        readyAt: Int64? = nil, freezeAt: Int64? = nil, finalDeltaAt: Int64? = nil,
        takenOverAt: Int64? = nil, abortedAt: Int64? = nil, oldClosedOutAt: Int64? = nil,
        done: Bool = false
    ) {
        self.serverDomain = serverDomain; self.phase = phase
        self.disposition = disposition; self.oldStkPubHex = oldStkPubHex
        self.newServerDomain = newServerDomain; self.newStkPubHex = newStkPubHex
        self.initiatedAt = initiatedAt; self.attachedAt = attachedAt
        self.preSeededAt = preSeededAt; self.readyAt = readyAt
        self.freezeAt = freezeAt; self.finalDeltaAt = finalDeltaAt
        self.takenOverAt = takenOverAt; self.abortedAt = abortedAt
        self.oldClosedOutAt = oldClosedOutAt; self.done = done
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.serverDomain = try c.decode(String.self, forKey: .serverDomain)
        self.phase = try c.decode(String.self, forKey: .phase)
        self.disposition = try c.decodeIfPresent(String.self, forKey: .disposition) ?? ""
        self.oldStkPubHex = try c.decodeIfPresent(String.self, forKey: .oldStkPubHex) ?? ""
        self.newServerDomain = try c.decodeIfPresent(String.self, forKey: .newServerDomain)
        self.newStkPubHex = try c.decodeIfPresent(String.self, forKey: .newStkPubHex)
        self.initiatedAt = try c.decodeIfPresent(Int64.self, forKey: .initiatedAt)
        self.attachedAt = try c.decodeIfPresent(Int64.self, forKey: .attachedAt)
        self.preSeededAt = try c.decodeIfPresent(Int64.self, forKey: .preSeededAt)
        self.readyAt = try c.decodeIfPresent(Int64.self, forKey: .readyAt)
        self.freezeAt = try c.decodeIfPresent(Int64.self, forKey: .freezeAt)
        self.finalDeltaAt = try c.decodeIfPresent(Int64.self, forKey: .finalDeltaAt)
        self.takenOverAt = try c.decodeIfPresent(Int64.self, forKey: .takenOverAt)
        self.abortedAt = try c.decodeIfPresent(Int64.self, forKey: .abortedAt)
        self.oldClosedOutAt = try c.decodeIfPresent(Int64.self, forKey: .oldClosedOutAt)
        self.done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case serverDomain, phase, disposition, oldStkPubHex, newServerDomain, newStkPubHex
        case initiatedAt, attachedAt, preSeededAt, readyAt, freezeAt, finalDeltaAt
        case takenOverAt, abortedAt, oldClosedOutAt, done
    }
}

// MARK: - Live

public final class LiveServerMigrationClient: ServerMigrationClient, @unchecked Sendable {
    public static var defaultBaseUrl: URL { Endpoints.controlBaseUrl }

    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func startMigration(serverDomain: String, body: MigrationStartBody) async throws {
        _ = try await post(serverDomain, "migration", body: try JSONEncoder().encode(body))
    }

    public func fetchMigration(serverDomain: String) async throws -> MigrationSession? {
        var req = URLRequest(url: try urlFor(serverDomain, "migration"))
        req.httpMethod = "GET"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return nil }
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(MigrationSession.self, from: data)
    }

    public func confirmReady(serverDomain: String, body: MigrationControlBody) async throws {
        _ = try await post(serverDomain, "migration/confirm-ready", body: try JSONEncoder().encode(body))
    }

    public func freeze(serverDomain: String, body: DecommissionDepositBody) async throws {
        _ = try await post(serverDomain, "migration/freeze", body: try JSONEncoder().encode(body))
    }

    public func abortMigration(serverDomain: String, body: MigrationControlBody) async throws {
        _ = try await post(serverDomain, "migration/abort", body: try JSONEncoder().encode(body))
    }

    private func urlFor(_ serverDomain: String, _ suffix: String) throws -> URL {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/\(suffix)") else {
            throw ScreensClientError.http(status: 0, message: "bad migration URL")
        }
        return url
    }

    private func post(_ serverDomain: String, _ suffix: String, body: Data) async throws -> Data {
        var req = URLRequest(url: try urlFor(serverDomain, suffix))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }
}

// MARK: - Mock

/// In-memory broker for previews / tests. Records the phone's deposits and
/// serves a scriptable session to the poll.
public final class MockServerMigrationClient: ServerMigrationClient, @unchecked Sendable {
    /// Scripted GET result (nil ⇒ 404 / no session).
    public var session: MigrationSession?
    /// When set, the next call of that kind throws it once.
    public var nextStartError: Error?
    public var nextFetchError: Error?
    public var nextConfirmError: Error?
    public var nextFreezeError: Error?
    public var nextAbortError: Error?
    public private(set) var starts: [(serverDomain: String, body: MigrationStartBody)] = []
    public private(set) var confirms: [(serverDomain: String, body: MigrationControlBody)] = []
    public private(set) var freezes: [(serverDomain: String, body: DecommissionDepositBody)] = []
    public private(set) var aborts: [(serverDomain: String, body: MigrationControlBody)] = []
    public private(set) var fetches: [String] = []
    public init() {}

    public func startMigration(serverDomain: String, body: MigrationStartBody) async throws {
        if let e = nextStartError { nextStartError = nil; throw e }
        starts.append((serverDomain, body))
    }
    public func fetchMigration(serverDomain: String) async throws -> MigrationSession? {
        fetches.append(serverDomain)
        if let e = nextFetchError { nextFetchError = nil; throw e }
        return session
    }
    public func confirmReady(serverDomain: String, body: MigrationControlBody) async throws {
        if let e = nextConfirmError { nextConfirmError = nil; throw e }
        confirms.append((serverDomain, body))
    }
    public func freeze(serverDomain: String, body: DecommissionDepositBody) async throws {
        if let e = nextFreezeError { nextFreezeError = nil; throw e }
        freezes.append((serverDomain, body))
    }
    public func abortMigration(serverDomain: String, body: MigrationControlBody) async throws {
        if let e = nextAbortError { nextAbortError = nil; throw e }
        aborts.append((serverDomain, body))
    }
}
