import Foundation

/// Client for the phone-as-unlock-endpoint RELAY mailbox on
/// flagshipserver.com (the Wave-2 endpoints in
/// `packages/control-plane/src/secretMailbox.ts`). `.com` is a blind
/// store-and-forward relay; this client is the phone's push-woken HTTPS
/// half.
///
/// The wire types here are PURE (no crypto) — the FlagshipCore
/// `SecretRequestCoordinator` builds the IRK-signed mailbox auth + the
/// sealed/signed reply (via the `Flagship` crypto layer) and hands the
/// finished bytes to this client. Field names match the Worker handlers'
/// JSON exactly (the iOS-Mock-matches-Worker-wire invariant).
public protocol SecretMailboxClient: Sendable {
    /// POST /api/secret-requests — phone, IRK mailbox-auth. Returns the
    /// account's un-answered pending requests, newest first.
    func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse

    /// POST /api/secret-response — phone, IRK mailbox-auth. Write-once.
    func postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody) async throws

    /// GET /api/server/:domain/sealed-luks-key — returns the LUKS key
    /// sealed FOR the phone (the phone unseals it with its delegated /
    /// BAK / IRK Ed25519 key). 404 → no sealed key on file.
    func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse

    /// GET /api/users/:u/pods — the directory. The phone resolves the
    /// box's STK INDEPENDENTLY of the mailbox echo from here, so a lying
    /// relay can't get the phone to seal for a box it controls.
    func fetchPods(username: String) async throws -> PodsDirectoryResponse

    /// POST /api/server/:domain/unlock-key/lease-v2 — deposit a box-sealed
    /// auto-unlock lease (IRK-signed). Enables "auto"-mode self-unlock on
    /// future reboots. `.com` stores ciphertext only (I1).
    func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String) async throws

    /// DELETE /api/server/:domain/unlock-key/lease-v2/:id — the kill switch
    /// (IRK-signed). Drops the lease so the box can no longer self-unlock —
    /// it falls back to phone-gated approval (downgrade, not brick).
    func revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String) async throws
}

// MARK: - Wire types

/// The IRK-signed `DeviceEndpointClaim` mailbox-auth credential + its
/// signature. Mirrors the Worker's `{ auth, authSignature }` body.
public struct MailboxAuthEnvelope: Codable, Equatable, Sendable {
    public struct Auth: Codable, Equatable, Sendable {
        public let username: String
        public let endpointLabel: String
        public let phoneIrkPub: String   // hex (32 bytes) — the account IRK
        public let issuedAt: Int64
        public let expiresAt: Int64
        public let nonce: String         // hex (32 bytes, 64 hex chars)
        public init(
            username: String, endpointLabel: String, phoneIrkPub: String,
            issuedAt: Int64, expiresAt: Int64, nonce: String
        ) {
            self.username = username; self.endpointLabel = endpointLabel
            self.phoneIrkPub = phoneIrkPub; self.issuedAt = issuedAt
            self.expiresAt = expiresAt; self.nonce = nonce
        }
    }
    public let auth: Auth
    public let authSignature: String     // hex (64 bytes) — Ed25519 by the IRK
    public init(auth: Auth, authSignature: String) {
        self.auth = auth; self.authSignature = authSignature
    }
}

/// One pending request as the mailbox returns it. `deviceInfo` is the
/// box's UNSIGNED display hint (ip/region/os) for the "is this my box?"
/// confirm — NOT the boundary. `stkPub` here is the mailbox's ECHO; the
/// phone re-resolves the STK from the directory before trusting it.
public struct PendingSecretRequest: Codable, Equatable, Sendable, Identifiable {
    public let serverDomain: String
    public let requestNonceHex: String
    public let stkPub: String            // hex echo (re-verified vs directory)
    public let purpose: String           // "unlock-key" | "entitlement"
    public let issuedAt: Int64
    public let requestSignature: String  // hex (64 bytes) — STK signature
    public let deviceInfo: DeviceInfoHint?
    public let postedAt: Int64
    public let expiresAt: Int64

    /// Stable id for SwiftUI lists — (domain, nonce) is unique per request.
    public var id: String { "\(serverDomain)#\(requestNonceHex)" }

    public init(
        serverDomain: String, requestNonceHex: String, stkPub: String,
        purpose: String, issuedAt: Int64, requestSignature: String,
        deviceInfo: DeviceInfoHint?, postedAt: Int64, expiresAt: Int64
    ) {
        self.serverDomain = serverDomain; self.requestNonceHex = requestNonceHex
        self.stkPub = stkPub; self.purpose = purpose; self.issuedAt = issuedAt
        self.requestSignature = requestSignature; self.deviceInfo = deviceInfo
        self.postedAt = postedAt; self.expiresAt = expiresAt
    }
}

/// The box's self-reported device-info display hint (the burner / boot
/// stage posts it alongside the SecretRequest). All fields optional — a
/// missing field renders as "—" in the confirm sheet.
public struct DeviceInfoHint: Codable, Equatable, Sendable {
    public let ip: String?
    public let region: String?
    public let os: String?
    public let hostname: String?
    public init(ip: String? = nil, region: String? = nil, os: String? = nil, hostname: String? = nil) {
        self.ip = ip; self.region = region; self.os = os; self.hostname = hostname
    }
}

public struct SecretRequestsResponse: Codable, Equatable, Sendable {
    public let username: String
    public let requests: [PendingSecretRequest]
    public init(username: String, requests: [PendingSecretRequest]) {
        self.username = username; self.requests = requests
    }
}

/// The phone's reply body. `sealed` is the hex of either the
/// SealedSecretResponse's sealed bytes (unlock-key) or the hex-encoded
/// EntitlementBundle JSON carrier (entitlement).
public struct SecretResponseBody: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let requestNonceHex: String
    public let purpose: String
    public let sealed: String   // hex
    public let issuedAt: Int64
    public init(serverDomain: String, requestNonceHex: String, purpose: String, sealed: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.requestNonceHex = requestNonceHex
        self.purpose = purpose; self.sealed = sealed; self.issuedAt = issuedAt
    }
}

public struct SealedLuksKeyResponse: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let sealedKey: String   // hex — sealed FOR the phone
    public let sealedAt: Int64
    public init(serverDomain: String, sealedKey: String, sealedAt: Int64) {
        self.serverDomain = serverDomain; self.sealedKey = sealedKey; self.sealedAt = sealedAt
    }
}

/// A directory entry from GET /api/users/:u/pods. `identityPubKey` is the
/// box's registered STK — the trust anchor the phone re-verifies against.
public struct PodDirectoryEntry: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let identityPubKey: String   // hex (32 bytes) — the STK
    public let revokedAt: Int64?
    public init(serverDomain: String, identityPubKey: String, revokedAt: Int64? = nil) {
        self.serverDomain = serverDomain; self.identityPubKey = identityPubKey; self.revokedAt = revokedAt
    }
}

public struct PodsDirectoryResponse: Codable, Equatable, Sendable {
    public let username: String
    public let pods: [PodDirectoryEntry]
    public init(username: String, pods: [PodDirectoryEntry]) {
        self.username = username; self.pods = pods
    }

    /// The STK registered for `serverDomain`, lowercased-domain match.
    /// Returns nil when the directory has no (non-revoked) entry for it —
    /// the coordinator MUST refuse to seal in that case.
    public func identityPubKey(forServerDomain domain: String) -> String? {
        let target = domain.lowercased()
        return pods.first(where: {
            $0.serverDomain.lowercased() == target && $0.revokedAt == nil
        })?.identityPubKey
    }
}

/// The wire shape of a box-sealed lease deposit body's `lease` object.
/// Field names match the Worker handler (handlePostBoxSealedLease).
public struct BoxSealedLeaseWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let stkPub: String       // hex
    public let leaseId: String
    public let sealedKey: String    // hex
    public let issuedAt: Int64
    public let expiresAt: Int64
    public let maxUses: Int?
    public init(
        serverDomain: String, stkPub: String, leaseId: String, sealedKey: String,
        issuedAt: Int64, expiresAt: Int64, maxUses: Int? = nil
    ) {
        self.serverDomain = serverDomain; self.stkPub = stkPub; self.leaseId = leaseId
        self.sealedKey = sealedKey; self.issuedAt = issuedAt; self.expiresAt = expiresAt
        self.maxUses = maxUses
    }
}

/// The wire shape of a lease-revoke body's `request` object.
public struct LeaseRevokeWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let leaseId: String
    public let issuedAt: Int64
    public init(serverDomain: String, leaseId: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.leaseId = leaseId; self.issuedAt = issuedAt
    }
}

// MARK: - Live

public final class LiveSecretMailboxClient: SecretMailboxClient, @unchecked Sendable {
    public static let defaultBaseUrl = URL(string: "https://flagshipserver.com")!

    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
        // The list is IRK-signed in the body; the Worker exposes it as
        // POST as well as GET (a GET with a body is awkward for URLSession).
        let body = try JSONEncoder().encode(auth)
        return try await postReturning("/api/secret-requests", body: body)
    }

    public func postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody) async throws {
        // Merge the auth fields + the response into one body matching the
        // Worker's `{ auth, authSignature, response }` shape.
        let payload = SecretResponsePost(auth: auth.auth, authSignature: auth.authSignature, response: response)
        let body = try JSONEncoder().encode(payload)
        try await post("/api/secret-response", body: body, acceptStatuses: [200, 201, 204])
    }

    public func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        return try await getReturning("/api/server/\(encoded)/sealed-luks-key")
    }

    public func fetchPods(username: String) async throws -> PodsDirectoryResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        return try await getReturning("/api/users/\(encoded)/pods")
    }

    public func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String) async throws {
        let body = try JSONEncoder().encode(LeaseDepositPost(lease: lease, signature: signatureHex))
        let enc = lease.serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? lease.serverDomain
        try await send("POST", "/api/server/\(enc)/unlock-key/lease-v2", body: body, acceptStatuses: [200, 201])
    }

    public func revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String) async throws {
        let body = try JSONEncoder().encode(LeaseRevokePost(request: request, signature: signatureHex))
        let encD = request.serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? request.serverDomain
        let encL = request.leaseId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? request.leaseId
        try await send("DELETE", "/api/server/\(encD)/unlock-key/lease-v2/\(encL)", body: body, acceptStatuses: [200, 204])
    }

    // The on-wire POST shape for /api/secret-response.
    private struct SecretResponsePost: Encodable {
        let auth: MailboxAuthEnvelope.Auth
        let authSignature: String
        let response: SecretResponseBody
    }
    private struct LeaseDepositPost: Encodable { let lease: BoxSealedLeaseWire; let signature: String }
    private struct LeaseRevokePost: Encodable { let request: LeaseRevokeWire; let signature: String }

    /// A POST/DELETE with a JSON body, accepting a set of success statuses.
    private func send(_ method: String, _ path: String, body: Data, acceptStatuses: Set<Int>) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    private func post(_ path: String, body: Data, acceptStatuses: Set<Int>) async throws {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    private func postReturning<Resp: Decodable>(_ path: String, body: Data) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    private func getReturning<Resp: Decodable>(_ path: String) async throws -> Resp {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = "GET"
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(Resp.self, from: data)
    }
}

// MARK: - Mock

/// In-memory mailbox for previews / the unconfigured default. Returns an
/// empty inbox so the approval surface renders the empty state without a
/// network call.
public final class MockSecretMailboxClient: SecretMailboxClient, @unchecked Sendable {
    public var pending: [PendingSecretRequest] = []
    public var directory: [PodDirectoryEntry] = []
    public var sealedLuksKeyHex: String?
    public private(set) var deposited: [(lease: BoxSealedLeaseWire, signatureHex: String)] = []
    public private(set) var revoked: [(request: LeaseRevokeWire, signatureHex: String)] = []
    public init() {}

    public func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
        SecretRequestsResponse(username: auth.auth.username, requests: pending)
    }
    public func postResponse(auth: MailboxAuthEnvelope, response: SecretResponseBody) async throws {}
    public func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
        guard let hex = sealedLuksKeyHex else {
            throw ScreensClientError.http(status: 404, message: "no sealed key on file")
        }
        return SealedLuksKeyResponse(serverDomain: serverDomain, sealedKey: hex, sealedAt: 1)
    }
    public func fetchPods(username: String) async throws -> PodsDirectoryResponse {
        PodsDirectoryResponse(username: username, pods: directory)
    }
    public func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String) async throws {
        deposited.append((lease, signatureHex))
    }
    public func revokeBoxSealedLease(request: LeaseRevokeWire, signatureHex: String) async throws {
        revoked.append((request, signatureHex))
    }
}
