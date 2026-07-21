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
///   POST /api/server/:domain/transfer/admin-handoff   giver, admin-root-signed hand-off proof (§9.8)
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

    /// GIVER: deposit the admin-root hand-off proof (spec §9.8) — signed by the
    /// giver's admin master root so the box can verify against its pinned
    /// anchor before re-pinning to the acquirer's root. Domain in the path is
    /// the box's OLD canonical.
    func postAdminHandoff(serverDomain: String, body: TransferAdminHandoffBody) async throws

    /// GIVER: deposit the LEGACY (no-admin-root) re-home authorization
    /// (v1-sec GAP 3) — signed by the giver's owner IRK so a box with no pinned
    /// admin root can verify it against its pinned owner IRK before re-homing.
    /// Domain in the path is the box's OLD canonical.
    func postRehomeAuth(serverDomain: String, body: TransferRehomeAuthBody) async throws
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
    /// §9.8 — the acquirer's admin master root pub, hex; "" ⇒ no admin root.
    /// Inside the v2 signed canonical, so `.com` can't substitute an anchor.
    public let acquirerAdminRootPub: String
    public let issuedAt: Int64
    public init(serverDomain: String, transferNonce: String, acquirerUsername: String, acquirerIrkPub: String, acquirerAdminRootPub: String = "", issuedAt: Int64) {
        self.serverDomain = serverDomain; self.transferNonce = transferNonce
        self.acquirerUsername = acquirerUsername; self.acquirerIrkPub = acquirerIrkPub
        self.acquirerAdminRootPub = acquirerAdminRootPub
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
    /// §9.8 — the admin root pub the acquirer committed to in its claim; ""
    /// when the acquirer has none, nil from a pre-§9.8 broker.
    public let acquirerAdminRootPub: String?
    public init(newServerDomain: String?, acquirerUsername: String?, acquirerIrkPub: String?, acquirerAdminRootPub: String? = nil) {
        self.newServerDomain = newServerDomain; self.acquirerUsername = acquirerUsername
        self.acquirerIrkPub = acquirerIrkPub
        self.acquirerAdminRootPub = acquirerAdminRootPub
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

/// The `flagship/admin-root-transfer/v1` hand-off object (matches the Worker
/// `handoff` key). `serverDomain` = the box's OLD canonical.
public struct TransferAdminHandoffWire: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let giverUsername: String
    public let acquirerUsername: String
    public let oldAdminRootPub: String   // hex — the box's pinned anchor
    public let newAdminRootPub: String   // hex; "" ⇒ unpin (acquirer has none)
    public let transferNonce: String
    public let issuedAt: Int64
    public init(serverDomain: String, giverUsername: String, acquirerUsername: String, oldAdminRootPub: String, newAdminRootPub: String, transferNonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.giverUsername = giverUsername
        self.acquirerUsername = acquirerUsername; self.oldAdminRootPub = oldAdminRootPub
        self.newAdminRootPub = newAdminRootPub; self.transferNonce = transferNonce
        self.issuedAt = issuedAt
    }
}

/// `{ handoff, signatureHex }` — `signatureHex` is the GIVER admin root's
/// Ed25519 signature over the hand-off canonical bytes.
public struct TransferAdminHandoffBody: Encodable, Equatable, Sendable {
    public let handoff: TransferAdminHandoffWire
    public let signatureHex: String
    public init(handoff: TransferAdminHandoffWire, signatureHex: String) {
        self.handoff = handoff; self.signatureHex = signatureHex
    }
}

/// `{ issuedAt, signatureHex }` — the legacy re-home authorization deposit
/// (v1-sec GAP 3). `signatureHex` is the GIVER owner IRK's Ed25519 signature
/// over the `flagship/server-rehome-auth/v1` canonical bytes. `.com`
/// reconstructs the signed (old/new domain, acquirer IRK) fields from the
/// claimed row — the body carries only `issuedAt` + the signature.
public struct TransferRehomeAuthBody: Encodable, Equatable, Sendable {
    public let issuedAt: Int64
    public let signatureHex: String
    public init(issuedAt: Int64, signatureHex: String) {
        self.issuedAt = issuedAt; self.signatureHex = signatureHex
    }
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

    public func postAdminHandoff(serverDomain: String, body: TransferAdminHandoffBody) async throws {
        _ = try await rawPost(serverDomain, "transfer/admin-handoff", body: try JSONEncoder().encode(body))
    }

    public func postRehomeAuth(serverDomain: String, body: TransferRehomeAuthBody) async throws {
        _ = try await rawPost(serverDomain, "transfer/rehome-auth", body: try JSONEncoder().encode(body))
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
    public private(set) var adminHandoffs: [(serverDomain: String, body: TransferAdminHandoffBody)] = []
    public private(set) var rehomeAuths: [(serverDomain: String, body: TransferRehomeAuthBody)] = []
    /// Scripted poll result (nil ⇒ "not yet claimed").
    public var scriptedPoll: TransferClaimPoll?
    /// Scripted admin-handoff deposit failure.
    public var adminHandoffError: Error?
    /// Scripted rehome-auth deposit failure.
    public var rehomeAuthError: Error?
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
    public func postAdminHandoff(serverDomain: String, body: TransferAdminHandoffBody) async throws {
        if let e = adminHandoffError { throw e }
        adminHandoffs.append((serverDomain, body))
    }
    public func postRehomeAuth(serverDomain: String, body: TransferRehomeAuthBody) async throws {
        if let e = rehomeAuthError { throw e }
        rehomeAuths.append((serverDomain, body))
    }
}
