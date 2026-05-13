import Foundation

/// Client for the *pre-pairing* endpoints on flagshipserver.com (the
/// Cloudflare Worker at `apps/com/`). These are the calls a phone
/// makes BEFORE it has a paired pod and a session token — minting a
/// build code, downloading a personalized ISO, registering a recovery
/// envelope, etc.
///
/// Distinct from `ScreensClient` which talks to `<server>.<user>.flagship.services`
/// (the user's own daemon) and is paired-session gated.
public protocol FlagshipServerClient: Sendable {
    func mintBuildCode(_ req: MintBuildCodeRequest) async throws -> MintBuildCodeResponse
    func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse
    func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse
    func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope
}

// MARK: - Wire types

public struct MintBuildCodeRequest: Codable, Equatable, Sendable {
    public let username: String
    public let podName: String
    public let podDescription: String?
    public init(username: String, podName: String, podDescription: String?) {
        self.username = username
        self.podName = podName
        self.podDescription = podDescription
    }
}

public struct MintBuildCodeResponse: Codable, Equatable, Sendable {
    public let buildCode: String
    public let serial: String
    public let isoUrl: String
    public let expiresAt: Int64
    public init(buildCode: String, serial: String, isoUrl: String, expiresAt: Int64) {
        self.buildCode = buildCode; self.serial = serial; self.isoUrl = isoUrl; self.expiresAt = expiresAt
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
    public let credentialId: String        // WebAuthn credentialID (base64url)
    public let wrappedUmkBase64: String    // UMK encrypted under the PRF-derived key
    public let nonceBase64: String         // AES-GCM nonce
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
    public var simulatedLatency: TimeInterval = 0.25
    public var shouldFail: Bool = false
    /// Reserved names. Mirrors the Worker-side reservation list.
    public var reservedUsernames: Set<String> = ["root", "admin", "flagship", "system", "support"]
    private var recoveryStore: [String: RecoveryEnvelope] = [:]

    public init() {}

    private func tick() async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        if shouldFail {
            throw ScreensClientError.http(status: 503, message: "simulated failure")
        }
    }

    public func mintBuildCode(_ req: MintBuildCodeRequest) async throws -> MintBuildCodeResponse {
        try await tick()
        let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        let code = String((0..<12).map { _ in alphabet.randomElement()! })
        let serial = String((0..<10).map { _ in alphabet.randomElement()! })
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return MintBuildCodeResponse(
            buildCode: code,
            serial: serial,
            isoUrl: "https://flagshipserver.com/build/\(code)/flagship-personalized.iso",
            expiresAt: now + 30 * 60 * 1000     // 30 min TTL
        )
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

    private func request<Req: Encodable, Resp: Decodable>(_ path: String, body: Req) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await urlSession.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    public func mintBuildCode(_ req: MintBuildCodeRequest) async throws -> MintBuildCodeResponse {
        try await request("/api/build-codes/mint", body: req)
    }

    public func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse {
        try await request("/api/users/check", body: ["username": username])
    }

    public func registerRecoveryEnvelope(_ req: RecoveryEnvelopeRequest) async throws -> RecoveryEnvelopeResponse {
        try await request("/api/recovery/register", body: req)
    }

    public func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope {
        var comps = URLComponents(url: baseUrl.appendingPathComponent("/api/recovery/fetch"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "credentialId", value: credentialId)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: status, message: text)
        }
        return try JSONDecoder().decode(RecoveryEnvelope.self, from: data)
    }
}
