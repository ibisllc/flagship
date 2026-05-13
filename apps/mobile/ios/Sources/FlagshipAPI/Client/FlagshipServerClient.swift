import Foundation

/// Client for the pre-pairing endpoints on flagshipserver.com (the
/// Cloudflare Worker at `apps/com/`). The phone hits these BEFORE it has
/// a paired pod and a session token.
///
/// As of relay-v2 (apps/com `41a126e`), the mint-build-code flow is
/// retired. The phone instead drives a three-step control-plane sequence
/// to mint an InstallBlob, then delivers the blob to a desktop browser
/// over the QR-relay WebSocket (see QrRelayClient + create-server.js).
///
///   1. POST /api/username/claim       (idempotent; 409 on collision OK)
///   2. POST /api/auth-code/issue      (issues a signed AuthCode)
///   3. POST /api/routing/register-rck (registers the routing-control key)
///
/// Each request body is a signed canonical-bytes envelope using the
/// device's IRK (derived via Flagship/Keystore.deriveIRK).
public protocol FlagshipServerClient: Sendable {
    func claimUsername(_ req: UsernameClaimRequest) async throws
    func issueAuthCode(_ req: AuthCodeIssueRequest) async throws
    func registerRck(_ req: RckRegisterRequest) async throws
    /// Cancel an outstanding auth-code so a server that hasn't phoned
    /// home yet can't register with this serial. 404 is treated as
    /// success by both Mock + Live impls.
    func cancelAuthCode(_ req: AuthCodeCancelRequest) async throws
    func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse
    func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse
    func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope
}

/// POST /api/auth-code/cancel — IRK-signed cancellation. The phone
/// fires this when the user taps Cancel order on a pending pod.
public struct AuthCodeCancelRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let serial: String
        public let username: String
        public let issuedAt: Int64
        public init(serial: String, username: String, issuedAt: Int64) {
            self.serial = serial; self.username = username; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

// MARK: - Wire types

/// POST /api/username/claim — idempotent. The Worker checks the IRK
/// signature and persists the binding {username → irkPub}. A 409 means
/// the same IRK already owns this username (still success on retry).
public struct UsernameClaimRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let irkPub: String       // hex
        public let issuedAt: Int64
        public init(username: String, irkPub: String, issuedAt: Int64) {
            self.username = username; self.irkPub = irkPub; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String        // hex, IRK over canonical bytes
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

/// POST /api/auth-code/issue — registers a serial-keyed AuthCode that
/// authorizes the freshly-booted server to register itself.
public struct AuthCodeIssueRequest: Codable, Equatable, Sendable {
    public let code: AuthCodeWire
    public let signature: String        // hex, IRK over canonical bytes
    public init(code: AuthCodeWire, signature: String) {
        self.code = code; self.signature = signature
    }
}

public struct AuthCodeWire: Codable, Equatable, Sendable {
    public let version: Int
    public let serial: String
    public let username: String
    public let serverName: String
    public let serverDomain: String
    public let delegatedPubKey: String   // hex
    public let userPubKey: String        // hex (the IRK's public key)
    public let issuedAt: Int64
    public let expiresAt: Int64
    public init(
        version: Int, serial: String, username: String, serverName: String,
        serverDomain: String, delegatedPubKey: String, userPubKey: String,
        issuedAt: Int64, expiresAt: Int64
    ) {
        self.version = version; self.serial = serial; self.username = username
        self.serverName = serverName; self.serverDomain = serverDomain
        self.delegatedPubKey = delegatedPubKey; self.userPubKey = userPubKey
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}

/// POST /api/routing/register-rck — binds an Ed25519 routing-control
/// key to the server's subdomain.
public struct RckRegisterRequest: Codable, Equatable, Sendable {
    public struct Inner: Codable, Equatable, Sendable {
        public let username: String
        public let subdomain: String
        public let rckPubKey: String     // hex
        public let issuedAt: Int64
        public init(username: String, subdomain: String, rckPubKey: String, issuedAt: Int64) {
            self.username = username; self.subdomain = subdomain
            self.rckPubKey = rckPubKey; self.issuedAt = issuedAt
        }
    }
    public let request: Inner
    public let signature: String         // hex, IRK
    public init(request: Inner, signature: String) {
        self.request = request; self.signature = signature
    }
}

public struct UsernameAvailabilityResponse: Codable, Equatable, Sendable {
    public let username: String
    public let available: Bool
    public let reason: String?
    public init(username: String, available: Bool, reason: String?) {
        self.username = username; self.available = available; self.reason = reason
    }
}

public struct RecoveryEnvelopeRequest: Codable, Equatable, Sendable {
    public let credentialId: String
    public let wrappedUmkBase64: String
    public let nonceBase64: String
    public init(credentialId: String, wrappedUmkBase64: String, nonceBase64: String) {
        self.credentialId = credentialId
        self.wrappedUmkBase64 = wrappedUmkBase64
        self.nonceBase64 = nonceBase64
    }
}

public struct RecoveryEnvelopeResponse: Codable, Equatable, Sendable {
    public let ok: Bool
    public init(ok: Bool) { self.ok = ok }
}

public struct RecoveryEnvelope: Codable, Equatable, Sendable {
    public let credentialId: String
    public let wrappedUmkBase64: String
    public let nonceBase64: String
    public init(credentialId: String, wrappedUmkBase64: String, nonceBase64: String) {
        self.credentialId = credentialId
        self.wrappedUmkBase64 = wrappedUmkBase64
        self.nonceBase64 = nonceBase64
    }
}

// MARK: - Mock

public final class MockFlagshipServerClient: FlagshipServerClient, @unchecked Sendable {
    public var simulatedLatency: TimeInterval = 0.2
    public var shouldFail: Bool = false
    public var reservedUsernames: Set<String> = ["root", "admin", "flagship", "system", "support"]
    private var recoveryStore: [String: RecoveryEnvelope] = [:]

    /// Tracks usernames that have been claimed so the mock can return
    /// 409 on a second different-IRK claim (idempotent under same IRK).
    public private(set) var claimedUsernames: [String: String] = [:]   // username → irkPub
    public private(set) var issuedAuthCodes: [String: AuthCodeWire] = [:]   // serial → wire
    public private(set) var cancelledAuthCodes: Set<String> = []       // serial set
    public private(set) var registeredRcks: [String: String] = [:]    // serverDomain → rckPubKey

    public init() {}

    private func tick() async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        if shouldFail {
            throw ScreensClientError.http(status: 503, message: "simulated failure")
        }
    }

    public func claimUsername(_ req: UsernameClaimRequest) async throws {
        try await tick()
        let u = req.request.username.lowercased()
        if let prior = claimedUsernames[u], prior != req.request.irkPub {
            throw ScreensClientError.http(status: 409, message: "username taken")
        }
        claimedUsernames[u] = req.request.irkPub
    }

    public func issueAuthCode(_ req: AuthCodeIssueRequest) async throws {
        try await tick()
        issuedAuthCodes[req.code.serial] = req.code
    }

    public func registerRck(_ req: RckRegisterRequest) async throws {
        try await tick()
        registeredRcks[req.request.subdomain] = req.request.rckPubKey
    }

    public func cancelAuthCode(_ req: AuthCodeCancelRequest) async throws {
        try await tick()
        cancelledAuthCodes.insert(req.request.serial)
    }

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        try await tick()
        let lower = username.lowercased()
        if lower.count < 2 || lower.count > 32 {
            return .init(username: lower, available: false, reason: "Must be 2–32 chars.")
        }
        if reservedUsernames.contains(lower) {
            return .init(username: lower, available: false, reason: "Reserved.")
        }
        if lower.range(of: "^[a-z0-9]+$", options: .regularExpression) == nil {
            return .init(username: lower, available: false, reason: "Letters and digits only.")
        }
        if let prior = claimedUsernames[lower], prior != "_self" {
            return .init(username: lower, available: false, reason: "Already claimed.")
        }
        return .init(username: lower, available: true, reason: nil)
    }

    public func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse {
        try await tick()
        recoveryStore[req.credentialId] = RecoveryEnvelope(
            credentialId: req.credentialId,
            wrappedUmkBase64: req.wrappedUmkBase64,
            nonceBase64: req.nonceBase64
        )
        return RecoveryEnvelopeResponse(ok: true)
    }

    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        try await tick()
        if let env = recoveryStore[credentialId] { return env }
        throw ScreensClientError.http(status: 404, message: "no envelope")
    }
}

// MARK: - Live

public final class LiveFlagshipServerClient: FlagshipServerClient, @unchecked Sendable {
    public static let defaultBaseUrl = URL(string: "https://flagshipserver.com")!

    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    private func postJson(_ path: String, body: Data, acceptStatuses: Set<Int> = [200, 201, 204]) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        let text = String(data: data, encoding: .utf8) ?? ""
        throw ScreensClientError.http(status: status, message: text)
    }

    private func postJsonReturning<Resp: Decodable>(_ path: String, body: Data) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    public func claimUsername(_ req: UsernameClaimRequest) async throws {
        let body = try JSONEncoder().encode(req)
        // 409 = idempotent retake under same IRK; treat as success.
        try await postJson("/api/username/claim", body: body, acceptStatuses: [200, 201, 204, 409])
    }

    public func issueAuthCode(_ req: AuthCodeIssueRequest) async throws {
        let body = try JSONEncoder().encode(req)
        try await postJson("/api/auth-code/issue", body: body)
    }

    public func registerRck(_ req: RckRegisterRequest) async throws {
        let body = try JSONEncoder().encode(req)
        try await postJson("/api/routing/register-rck", body: body)
    }

    public func cancelAuthCode(_ req: AuthCodeCancelRequest) async throws {
        let body = try JSONEncoder().encode(req)
        // 404 = already cancelled / never issued; treat as success so
        // retries are safe.
        try await postJson("/api/auth-code/cancel", body: body, acceptStatuses: [200, 201, 204, 404])
    }

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        let body = try JSONEncoder().encode(["username": username])
        return try await postJsonReturning("/api/users/check", body: body)
    }

    public func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse {
        let body = try JSONEncoder().encode(req)
        return try await postJsonReturning("/api/recovery/register", body: body)
    }

    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/recovery/fetch"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "credentialId", value: credentialId)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RecoveryEnvelope.self, from: data)
    }
}
