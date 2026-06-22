import Foundation

/// Transfer-a-box client — the cross-account ownership handoff brokered by
/// `.com` (docs/account-deletion-and-name-reclaim.md §4). Mirrors the webapp's
/// `lib/serverTransfer.js` wire bodies exactly:
///
///   POST /api/server/:domain/transfer/offer        giver, IRK mailbox-auth + signed offer
///   POST /api/server/:domain/transfer/claim         acquirer, signed claim
///   POST /api/server/:domain/transfer/claim-poll     giver, IRK mailbox-auth → acquirer IRK
///   POST /api/server/:domain/transfer/disk-key       giver, IRK mailbox-auth + sealed disk key
///   POST /api/server/:domain/transfer/disk-key-claim  acquirer, IRK mailbox-auth → sealed disk key
///
/// The wire types are PURE (no crypto): the VM builds the IRK-signed offer/claim
/// + the mailbox-auth via `FlagshipCore` and hands the finished bytes here. Field
/// names match the Worker handlers' JSON exactly (the Mock-matches-Worker-wire
/// invariant).
public protocol ServerTransferClient: Sendable {
    /// GIVER: deposit a signed offer (IRK mailbox-auth). Returns the broker's
    /// effective `expiresAt`.
    func postOffer(serverDomain: String, body: TransferOfferBody) async throws -> TransferOfferResult

    /// ACQUIRER: submit a signed claim. Returns the new (acquirer-namespace) domain.
    func postClaim(serverDomain: String, body: TransferClaimBody) async throws -> TransferClaimResult

    /// GIVER: poll "did someone claim my offer?" (IRK mailbox-auth). Returns nil
    /// while unclaimed (404), else the acquirer IRK + the new domain.
    func pollClaim(serverDomain: String, auth: MailboxAuthEnvelope) async throws -> TransferClaimPoll?

    /// GIVER: deposit the disk key re-sealed to the acquirer IRK (IRK mailbox-auth).
    func postDiskKey(serverDomain: String, body: TransferDiskKeyBody) async throws

    /// ACQUIRER: pick up the giver's re-sealed disk key (IRK mailbox-auth).
    /// Returns nil while the giver hasn't re-sealed yet (404).
    func claimDiskKey(serverDomain: String, auth: MailboxAuthEnvelope) async throws -> TransferDiskKey?
}

// MARK: - Wire types

/// The signed `ServerTransferOffer` object (matches the Worker `offer` key).
public struct TransferOfferWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let transferNonce: String
    public let issuedAt: Int64
    public let expiresAt: Int64
    public init(serverDomain: String, transferNonce: String, issuedAt: Int64, expiresAt: Int64) {
        self.serverDomain = serverDomain; self.transferNonce = transferNonce
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}

/// `{ auth, authSignature, offer, offerSignature }`.
public struct TransferOfferBody: Encodable, Equatable, Sendable {
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let offer: TransferOfferWire
    public let offerSignature: String
    public init(auth: MailboxAuthEnvelope.Auth, authSignature: String, offer: TransferOfferWire, offerSignature: String) {
        self.auth = auth; self.authSignature = authSignature
        self.offer = offer; self.offerSignature = offerSignature
    }
}

public struct TransferOfferResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let expiresAt: Int64
    public init(ok: Bool, expiresAt: Int64) { self.ok = ok; self.expiresAt = expiresAt }
}

/// The signed `ServerTransferClaim` object (matches the Worker `claim` key).
public struct TransferClaimWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let transferNonce: String
    public let acquirerUsername: String
    public let acquirerIrkPub: String   // hex
    public let issuedAt: Int64
    public init(serverDomain: String, transferNonce: String, acquirerUsername: String, acquirerIrkPub: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.transferNonce = transferNonce
        self.acquirerUsername = acquirerUsername; self.acquirerIrkPub = acquirerIrkPub
        self.issuedAt = issuedAt
    }
}

/// `{ claim, claimSignature }`.
public struct TransferClaimBody: Encodable, Equatable, Sendable {
    public let claim: TransferClaimWire
    public let claimSignature: String
    public init(claim: TransferClaimWire, claimSignature: String) {
        self.claim = claim; self.claimSignature = claimSignature
    }
}

public struct TransferClaimResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let serverDomain: String
    public let newServerDomain: String?
    public let acquirerUsername: String?
    public init(ok: Bool, serverDomain: String, newServerDomain: String?, acquirerUsername: String?) {
        self.ok = ok; self.serverDomain = serverDomain
        self.newServerDomain = newServerDomain; self.acquirerUsername = acquirerUsername
    }
}

public struct TransferClaimPoll: Decodable, Equatable, Sendable {
    public let newServerDomain: String?
    public let acquirerUsername: String?
    public let acquirerIrkPub: String?
    public init(newServerDomain: String?, acquirerUsername: String?, acquirerIrkPub: String?) {
        self.newServerDomain = newServerDomain; self.acquirerUsername = acquirerUsername
        self.acquirerIrkPub = acquirerIrkPub
    }
}

/// `{ auth, authSignature, sealedDiskKey }` — the giver disk-key deposit.
public struct TransferDiskKeyBody: Encodable, Equatable, Sendable {
    public let auth: MailboxAuthEnvelope.Auth
    public let authSignature: String
    public let sealedDiskKey: String   // hex of the sealed-to-acquirer-IRK blob
    public init(auth: MailboxAuthEnvelope.Auth, authSignature: String, sealedDiskKey: String) {
        self.auth = auth; self.authSignature = authSignature; self.sealedDiskKey = sealedDiskKey
    }
}

public struct TransferDiskKey: Decodable, Equatable, Sendable {
    public let sealedDiskKey: String   // hex
    public init(sealedDiskKey: String) { self.sealedDiskKey = sealedDiskKey }
}

// MARK: - Live

public final class LiveServerTransferClient: ServerTransferClient, @unchecked Sendable {
    public static var defaultBaseUrl: URL { Endpoints.controlBaseUrl }

    private let urlSession: URLSession
    private let baseUrl: URL

    public init(urlSession: URLSession = .shared, baseUrl: URL = defaultBaseUrl) {
        self.urlSession = urlSession
        self.baseUrl = baseUrl
    }

    public func postOffer(serverDomain: String, body: TransferOfferBody) async throws -> TransferOfferResult {
        try await postReturning(serverDomain, "transfer/offer", body: try JSONEncoder().encode(body))
    }

    public func postClaim(serverDomain: String, body: TransferClaimBody) async throws -> TransferClaimResult {
        try await postReturning(serverDomain, "transfer/claim", body: try JSONEncoder().encode(body))
    }

    public func pollClaim(serverDomain: String, auth: MailboxAuthEnvelope) async throws -> TransferClaimPoll? {
        try await postReturningOptional(serverDomain, "transfer/claim-poll", body: try JSONEncoder().encode(auth))
    }

    public func postDiskKey(serverDomain: String, body: TransferDiskKeyBody) async throws {
        _ = try await rawPost(serverDomain, "transfer/disk-key", body: try JSONEncoder().encode(body))
    }

    public func claimDiskKey(serverDomain: String, auth: MailboxAuthEnvelope) async throws -> TransferDiskKey? {
        try await postReturningOptional(serverDomain, "transfer/disk-key-claim", body: try JSONEncoder().encode(auth))
    }

    private func urlFor(_ serverDomain: String, _ suffix: String) throws -> URL {
        let encoded = serverDomain.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverDomain
        guard let url = URL(string: baseUrl.absoluteString + "/api/server/\(encoded)/\(suffix)") else {
            throw ScreensClientError.http(status: 0, message: "bad transfer URL")
        }
        return url
    }

    private func rawPost(_ serverDomain: String, _ suffix: String, body: Data) async throws -> (Data, Int) {
        var req = URLRequest(url: try urlFor(serverDomain, suffix))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await urlSession.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return (data, status) }
        if status == 404 { return (data, 404) }
        throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
    }

    private func postReturning<Resp: Decodable>(_ serverDomain: String, _ suffix: String, body: Data) async throws -> Resp {
        let (data, status) = try await rawPost(serverDomain, suffix, body: body)
        if status == 404 { throw ScreensClientError.http(status: 404, message: "not found") }
        return try JSONDecoder().decode(Resp.self, from: data)
    }

    private func postReturningOptional<Resp: Decodable>(_ serverDomain: String, _ suffix: String, body: Data) async throws -> Resp? {
        let (data, status) = try await rawPost(serverDomain, suffix, body: body)
        if status == 404 { return nil }
        return try JSONDecoder().decode(Resp.self, from: data)
    }
}

// MARK: - Mock

/// In-memory broker for previews / tests. Records the giver's offer + disk-key
/// deposit and serves a scriptable claim/disk-key to the acquirer/giver poll.
public final class MockServerTransferClient: ServerTransferClient, @unchecked Sendable {
    public private(set) var offers: [(serverDomain: String, body: TransferOfferBody)] = []
    public private(set) var claims: [(serverDomain: String, body: TransferClaimBody)] = []
    public private(set) var diskKeyDeposits: [(serverDomain: String, body: TransferDiskKeyBody)] = []
    /// Scripted poll result (nil ⇒ "not yet claimed").
    public var scriptedPoll: TransferClaimPoll?
    /// Scripted acquirer disk-key (nil ⇒ "not yet deposited").
    public var scriptedDiskKey: TransferDiskKey?
    public var claimResult: TransferClaimResult?
    public init() {}

    public func postOffer(serverDomain: String, body: TransferOfferBody) async throws -> TransferOfferResult {
        offers.append((serverDomain, body))
        return TransferOfferResult(ok: true, expiresAt: body.offer.expiresAt)
    }
    public func postClaim(serverDomain: String, body: TransferClaimBody) async throws -> TransferClaimResult {
        claims.append((serverDomain, body))
        return claimResult ?? TransferClaimResult(
            ok: true,
            serverDomain: serverDomain,
            newServerDomain: serverDomain,
            acquirerUsername: body.claim.acquirerUsername
        )
    }
    public func pollClaim(serverDomain: String, auth: MailboxAuthEnvelope) async throws -> TransferClaimPoll? {
        scriptedPoll
    }
    public func postDiskKey(serverDomain: String, body: TransferDiskKeyBody) async throws {
        diskKeyDeposits.append((serverDomain, body))
    }
    public func claimDiskKey(serverDomain: String, auth: MailboxAuthEnvelope) async throws -> TransferDiskKey? {
        scriptedDiskKey
    }
}
