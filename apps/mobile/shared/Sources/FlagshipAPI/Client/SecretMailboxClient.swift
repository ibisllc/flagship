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

    /// POST {boot}/api/boot/response — owner-IRK (the `bootAuth` header).
    /// Posts the sealed reply to the dedicated boot worker, where the box
    /// polls for it. Write-once.
    func postResponse(response: SecretResponseBody, bootAuth: String) async throws

    /// GET /api/server/:domain/sealed-luks-key — returns the LUKS key
    /// sealed FOR the phone (the phone unseals it with its delegated /
    /// BAK / IRK Ed25519 key). 404 → no sealed key on file. Stays on the
    /// identity plane (owner identity-state, set at install).
    func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse

    /// GET /api/users/:u/pods — the directory. The phone resolves the
    /// box's STK INDEPENDENTLY of the mailbox echo from here, so a lying
    /// relay can't get the phone to seal for a box it controls. Identity
    /// plane (canonical id-cert source).
    func fetchPods(username: String) async throws -> PodsDirectoryResponse

    /// PUT {boot}/api/boot/lease — deposit a box-sealed auto-unlock lease on
    /// the boot worker (owner-IRK via the `bootAuth` header). The `lease`
    /// body keeps its own IRK signature so the box re-verifies it. Enables
    /// "auto"-mode self-unlock; the worker stores ciphertext only (I1).
    func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws

    /// DELETE {boot}/api/boot/lease/:domain/:id — the kill switch (owner-IRK
    /// via `bootAuth`). Drops the lease so the box can no longer self-unlock
    /// — it falls back to phone-gated approval (downgrade, not brick).
    func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws
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

/// #56 — an active outstanding install order, surfaced in the SAME
/// unauthenticated `/pods` response as registered servers. A just-created,
/// not-yet-registered server now rides this list instead of the fragile
/// biometric-IRK `outstanding-orders` path, so a list refresh triggers NO
/// Face ID prompt. Mirrors control-plane `PendingPodEntry`.
///
/// `orderRef` — NOT the raw auth-code serial — identifies the order:
/// `hex(sha256("flagship/order-ref/v1|" + serial))` (FlagshipCore.OrderRef).
/// The serial is a provision-status write capability, so it never rides
/// this unauthenticated response; a device that minted the order computes
/// the same ref locally to reconcile, and keeps polling deep install
/// progress with its locally-stored serial.
public struct PendingPodEntry: Codable, Equatable, Sendable {
    /// Opaque sha256 order ref (64 hex chars). Empty if a pre-cutover
    /// Worker response omitted it (mixed-deploy tolerance).
    public let orderRef: String
    public let serverName: String
    /// `<serverName>.<username>.flagship.services` — the reserved FQDN.
    public let fqdn: String
    /// Latest reported provisioning phase, or nil.
    public let phase: String?
    public let createdAt: Int64
    public init(orderRef: String, serverName: String, fqdn: String, phase: String?, createdAt: Int64) {
        self.orderRef = orderRef; self.serverName = serverName
        self.fqdn = fqdn; self.phase = phase; self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.orderRef = try c.decodeIfPresent(String.self, forKey: .orderRef) ?? ""
        self.serverName = try c.decode(String.self, forKey: .serverName)
        self.fqdn = try c.decode(String.self, forKey: .fqdn)
        self.phase = try c.decodeIfPresent(String.self, forKey: .phase)
        self.createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case orderRef, serverName, fqdn, phase, createdAt
    }
}

public struct PodsDirectoryResponse: Codable, Equatable, Sendable {
    public let username: String
    public let pods: [PodDirectoryEntry]
    /// #56 — active outstanding orders, merged into the same fetch. Optional on
    /// the wire so a pre-#56 Worker response (no `pending` key) still decodes.
    public let pending: [PendingPodEntry]
    public init(username: String, pods: [PodDirectoryEntry], pending: [PendingPodEntry] = []) {
        self.username = username; self.pods = pods; self.pending = pending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.username = try c.decode(String.self, forKey: .username)
        self.pods = try c.decode([PodDirectoryEntry].self, forKey: .pods)
        self.pending = try c.decodeIfPresent([PendingPodEntry].self, forKey: .pending) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case username, pods, pending
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
    /// The dedicated boot worker — lease deposit/revoke + sealed-response
    /// post land here (identity-gated by the `bootAuth` header). Separate
    /// host so an enterprise clone can self-host boot operations.
    public static let defaultBootBaseUrl = URL(string: "https://boot.flagshipserver.com")!

    private let urlSession: URLSession
    private let baseUrl: URL
    private let bootBaseUrl: URL

    public init(
        urlSession: URLSession = .shared,
        baseUrl: URL = defaultBaseUrl,
        bootBaseUrl: URL = defaultBootBaseUrl
    ) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
        self.bootBaseUrl = bootBaseUrl
    }

    public func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
        // The list is IRK-signed in the body; the Worker exposes it as
        // POST as well as GET (a GET with a body is awkward for URLSession).
        let body = try JSONEncoder().encode(auth)
        return try await postReturning("/api/secret-requests", body: body)
    }

    public func postResponse(response: SecretResponseBody, bootAuth: String) async throws {
        // The boot worker expects `{ response: {...} }` + the owner-IRK
        // Flagship-Boot-v1 Authorization header (the gate authenticates it).
        let body = try JSONEncoder().encode(BootResponsePost(response: response))
        try await sendBoot("POST", "/api/boot/response", body: body, bootAuth: bootAuth, acceptStatuses: [200, 201, 204])
    }

    public func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        return try await getReturning("/api/server/\(encoded)/sealed-luks-key")
    }

    public func fetchPods(username: String) async throws -> PodsDirectoryResponse {
        let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        return try await getReturning("/api/users/\(encoded)/pods")
    }

    public func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws {
        let body = try JSONEncoder().encode(LeaseDepositPost(lease: lease, signature: signatureHex))
        try await sendBoot("PUT", "/api/boot/lease", body: body, bootAuth: bootAuth, acceptStatuses: [200, 201])
    }

    public func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws {
        // FQDN + hex leaseId are URL-safe, so the literal path matches the
        // path the `bootAuth` signature commits to (the gate binds it exactly).
        let path = "/api/boot/lease/\(request.serverDomain)/\(request.leaseId)"
        try await sendBoot("DELETE", path, body: Data(), bootAuth: bootAuth, acceptStatuses: [200, 204])
    }

    private struct BootResponsePost: Encodable { let response: SecretResponseBody }
    private struct LeaseDepositPost: Encodable { let lease: BoxSealedLeaseWire; let signature: String }

    /// A boot-worker request (POST/PUT/DELETE) with the owner-IRK
    /// `Authorization: Flagship-Boot-v1 …` header. The URL is built by
    /// string concat (not appendingPathComponent) so the path matches the
    /// one the header signature commits to, byte-for-byte.
    private func sendBoot(_ method: String, _ path: String, body: Data, bootAuth: String, acceptStatuses: Set<Int>) async throws {
        guard let url = URL(string: bootBaseUrl.absoluteString + path) else {
            throw ScreensClientError.http(status: 0, message: "bad boot URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(bootAuth, forHTTPHeaderField: "Authorization")
        if !body.isEmpty { req.httpBody = body }
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if acceptStatuses.contains(status) { return }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

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
    /// #56 — active outstanding orders the merged `/pods` fetch returns.
    public var directoryPending: [PendingPodEntry] = []
    public var sealedLuksKeyHex: String?
    public private(set) var deposited: [(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String)] = []
    public private(set) var revoked: [(request: LeaseRevokeWire, bootAuth: String)] = []
    public private(set) var postedResponses: [(response: SecretResponseBody, bootAuth: String)] = []
    public init() {}

    public func fetchPendingRequests(auth: MailboxAuthEnvelope) async throws -> SecretRequestsResponse {
        SecretRequestsResponse(username: auth.auth.username, requests: pending)
    }
    public func postResponse(response: SecretResponseBody, bootAuth: String) async throws {
        postedResponses.append((response, bootAuth))
    }
    public func fetchSealedLuksKey(serverDomain: String) async throws -> SealedLuksKeyResponse {
        guard let hex = sealedLuksKeyHex else {
            throw ScreensClientError.http(status: 404, message: "no sealed key on file")
        }
        return SealedLuksKeyResponse(serverDomain: serverDomain, sealedKey: hex, sealedAt: 1)
    }
    public func fetchPods(username: String) async throws -> PodsDirectoryResponse {
        PodsDirectoryResponse(username: username, pods: directory, pending: directoryPending)
    }
    public func depositBoxSealedLease(lease: BoxSealedLeaseWire, signatureHex: String, bootAuth: String) async throws {
        deposited.append((lease, signatureHex, bootAuth))
    }
    public func revokeBoxSealedLease(request: LeaseRevokeWire, bootAuth: String) async throws {
        revoked.append((request, bootAuth))
    }
}
