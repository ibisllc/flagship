import Foundation
import FlagshipAPI

/// The HTTP surface of "Share this server" (docs/share-a-server.md §6, §9):
/// `.com` (the offer relay and B's inbox), the boot gate (B's start-up
/// approvals) and the box (owner share routes, B's sign-in and leave).
///
/// `.com` and boot ride `com`; the box rides `box`, which the app builds over
/// the box-pinned session so a share token is never sent to a box whose
/// certificate doesn't match its pin.
public protocol ServerShareTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

public struct URLSessionShareTransport: ServerShareTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let (data, resp) = try await session.data(for: request)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

/// A non-2xx answer. `error` and `code` are the JSON body's fields when present.
public struct ServerShareHTTPError: Error, Equatable, Sendable {
    public let status: Int
    public let error: String?
    public let code: String?

    public init(status: Int, error: String?, code: String?) {
        self.status = status
        self.error = error
        self.code = code
    }

    /// The box refused a share sign-in because the share ended (revoked or left).
    public var isShareEnded: Bool { code == "share-ended" || error == "share-ended" }
    /// The box doesn't hold a grant for this key yet (the owner hasn't confirmed).
    public var isNotShared: Bool { code == "not-shared" || error == "not-shared" }
    /// The box refused a first grant's acceptance (docs/share-a-server.md §5.1);
    /// `error` is the sentence the owner sees.
    public var acceptRefusal: String? {
        guard let code, ["accept-not-admin", "accept-signature", "accept-stale", "accept-unverifiable"].contains(code),
              let error, !error.isEmpty
        else { return nil }
        return error
    }
}

// MARK: - Wire types

public struct ComShareRow: Decodable, Equatable, Sendable {
    public let shareId: String
    public let serverDomain: String
    /// `offered`, `accepted` or `ended`.
    public let state: String
    public let owner: String?
    public let acceptance: String?
    public let acceptedAt: Int64?
    public let endKind: String?
    public let endedAt: Int64?
    public let createdAt: Int64?
    public let expiresAt: Int64
    public let unlock: Bool

    public init(shareId: String, serverDomain: String, state: String, owner: String?, acceptance: String?,
                acceptedAt: Int64? = nil, endKind: String? = nil, endedAt: Int64? = nil, createdAt: Int64? = nil,
                expiresAt: Int64, unlock: Bool = false) {
        self.shareId = shareId
        self.serverDomain = serverDomain
        self.state = state
        self.owner = owner
        self.acceptance = acceptance
        self.acceptedAt = acceptedAt
        self.endKind = endKind
        self.endedAt = endedAt
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.unlock = unlock
    }
}

public struct ComShareView: Decodable, Equatable, Sendable {
    public let shareId: String
    public let serverDomain: String
    public let state: String
    public let offer: String
    public let acceptance: String?
    public let endKind: String?
    public let expiresAt: Int64
    public let unlock: Bool
}

public struct BoxShareSummary: Codable, Equatable, Sendable {
    public let shareId: String
    public let label: String
    public let level: ServerShareLevel
    public let unlockAtBoot: Bool
    public let seeAppData: Bool
    public let memberPubHex: String?
    public let issuedAt: Int64
    public let sharedAt: Int64?
    public let lastSeenAt: Int64?

    public init(shareId: String, label: String, level: ServerShareLevel, unlockAtBoot: Bool, seeAppData: Bool,
                memberPubHex: String?, issuedAt: Int64, sharedAt: Int64? = nil, lastSeenAt: Int64? = nil) {
        self.shareId = shareId
        self.label = label
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
        self.memberPubHex = memberPubHex
        self.issuedAt = issuedAt
        self.sharedAt = sharedAt
        self.lastSeenAt = lastSeenAt
    }
}

public struct BoxEndedShare: Codable, Equatable, Sendable {
    public let shareId: String
    public let label: String?
    public let endedAt: Int64?
    public let reason: String?
}

public struct BoxSharesResponse: Codable, Equatable, Sendable {
    public let shares: [BoxShareSummary]
    public let ended: [BoxEndedShare]

    public init(shares: [BoxShareSummary], ended: [BoxEndedShare] = []) {
        self.shares = shares
        self.ended = ended
    }
}

public struct ShareActivityEntry: Codable, Equatable, Sendable, Identifiable {
    public struct Actor: Codable, Equatable, Sendable {
        public let kind: String
        public let shareId: String?
        public let label: String?

        public init(kind: String, shareId: String? = nil, label: String? = nil) {
            self.kind = kind
            self.shareId = shareId
            self.label = label
        }
    }

    public let ts: Int64
    public let actor: Actor
    public let action: String
    public let target: String?
    public let ok: Bool

    public init(ts: Int64, actor: Actor, action: String, target: String? = nil, ok: Bool = true) {
        self.ts = ts
        self.actor = actor
        self.action = action
        self.target = target
        self.ok = ok
    }

    public var id: String { "\(ts)|\(actor.shareId ?? actor.kind)|\(action)|\(target ?? "")" }
}

public struct ShareSessionResponse: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: Int64
    public let level: ServerShareLevel
    public let unlockAtBoot: Bool
    public let seeAppData: Bool

    public init(token: String, expiresAt: Int64, level: ServerShareLevel, unlockAtBoot: Bool, seeAppData: Bool) {
        self.token = token
        self.expiresAt = expiresAt
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
    }
}

public struct ShareMeResponse: Codable, Equatable, Sendable {
    public let shareId: String
    public let level: ServerShareLevel
    public let unlockAtBoot: Bool
    public let seeAppData: Bool
    public let serverDomain: String
    /// Manage level on a box that can update itself. Older boxes omit it.
    public var canUpdate: Bool? = nil

    public init(shareId: String, level: ServerShareLevel, unlockAtBoot: Bool, seeAppData: Bool,
                serverDomain: String, canUpdate: Bool? = nil) {
        self.shareId = shareId
        self.level = level
        self.unlockAtBoot = unlockAtBoot
        self.seeAppData = seeAppData
        self.serverDomain = serverDomain
        self.canUpdate = canUpdate
    }
}

/// `POST /api/shares/update` accepted the order; the box applies it next.
public struct ShareUpdateAccepted: Codable, Equatable, Sendable {
    public let ok: Bool
    public let accepted: Bool
    public let targetCommit: String
}

public struct ShareInboxListEntry: Codable, Equatable, Sendable {
    public let entryId: String
    public let ct: String
    public let createdAt: Int64?
}

public struct ShareBootPending: Codable, Equatable, Sendable {
    public struct Request: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let stkPub: String
        public let purpose: String
        public let nonce: String
        public let issuedAt: Int64
    }
    public let request: Request
    public let signature: String
    public let postedAt: Int64?
    public let expiresAt: Int64?
}

// MARK: - Bodies

struct ShareOfferCreateBody: Encodable {
    let offer: ServerShareOffer
    let signature: String
    let offerHex: String
    let ownerHex: String
}

struct ShareSignedBody<E: ServerShareEnvelope>: Encodable {
    let key: String
    let envelope: E
    let signature: String

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DynamicKey.self)
        try c.encode(envelope, forKey: DynamicKey(key))
        try c.encode(signature, forKey: DynamicKey("signature"))
    }
}

struct ShareUnlockBody: Encodable {
    let unlock: ServerShareUnlock
    let signature: String
    let sealedKey: String?
}

struct ShareGrantBody: Encodable {
    let grant: ServerShareGrant
    let signature: String
    let accept: ServerShareAccept?
    let acceptSignature: String?
    /// The joining account's admin proof, on the first grant (docs/share-a-server.md §5.1).
    var acceptAdmin: ShareAcceptAdminProof? = nil
}

struct SharePushBody: Encodable {
    let push: ServerSharePush
    let signature: String
    let providerToken: String?
}

struct ShareInboxBody: Encodable {
    let request: ShareInboxRequest
    let signature: String
    let ct: String?
}

struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

// MARK: - Client

public final class ServerShareClient: Sendable {
    public static let shareTokenHeader = "x-flagship-share-token"
    public static let sessionHeader = "x-flagship-session"

    private let com: any ServerShareTransport
    private let box: any ServerShareTransport
    private let apex: @Sendable () -> URL
    private let boot: @Sendable () -> URL
    private let boxBase: @Sendable (String) -> URL?

    public init(
        com: any ServerShareTransport,
        box: any ServerShareTransport,
        apex: @escaping @Sendable () -> URL = { Endpoints.controlBaseUrl },
        boot: @escaping @Sendable () -> URL = { Endpoints.bootBaseUrl },
        boxBase: @escaping @Sendable (String) -> URL? = { URL(string: CompanionTicketURL.podBaseUrl(forFqdn: $0)) }
    ) {
        self.com = com
        self.box = box
        self.apex = apex
        self.boot = boot
        self.boxBase = boxBase
    }

    // MARK: .com, owner

    public func createOffer(username: String, offer: ServerShareOffer, signature: String,
                            offerHex: String, ownerHex: String) async throws {
        try await sendVoid(com, apex(), "POST", "/api/users/\(seg(username))/server-shares",
                           body: ShareOfferCreateBody(offer: offer, signature: signature, offerHex: offerHex, ownerHex: ownerHex))
    }

    public func listOffers(username: String, list: ServerShareList, signature: String) async throws -> [ComShareRow] {
        struct R: Decodable { let shares: [ComShareRow] }
        let r: R = try await send(com, apex(), "POST", "/api/users/\(seg(username))/server-shares/list",
                                  body: ShareSignedBody(key: "list", envelope: list, signature: signature))
        return r.shares
    }

    public func revokeOnCom(username: String, revoke: ServerShareRevoke, signature: String) async throws {
        try await sendVoid(com, apex(), "POST", "/api/users/\(seg(username))/server-shares/\(revoke.shareId)/revoke",
                           body: ShareSignedBody(key: "revoke", envelope: revoke, signature: signature))
    }

    public func putUnlock(username: String, unlock: ServerShareUnlock, signature: String, sealedKey: String?) async throws {
        try await sendVoid(com, apex(), "POST", "/api/users/\(seg(username))/server-shares/\(unlock.shareId)/unlock",
                           body: ShareUnlockBody(unlock: unlock, signature: signature, sealedKey: sealedKey))
    }

    /// The disk key sealed to the owner's phone keys (as boot approval reads it).
    public func sealedDiskKey(serverDomain: String) async throws -> String {
        struct R: Decodable { let sealedKey: String }
        let r: R = try await send(com, apex(), "GET", "/api/server/\(seg(serverDomain))/sealed-luks-key", body: nil as String?)
        return r.sealedKey
    }

    // MARK: .com, the second account

    public func getShare(shareId: String, token: String) async throws -> ComShareView {
        try await send(com, apex(), "GET", "/api/server-shares/\(shareId)", body: nil as String?,
                       headers: [Self.shareTokenHeader: token])
    }

    /// `.com`'s CA attestation of this account's sensitive key (§5.1). The
    /// device asks about its own account; the attestation names none.
    public func accountKeyAttestation(username: String) async throws -> AccountKeyAttestation {
        struct R: Decodable { let attestation: AccountKeyAttestation }
        let r: R = try await send(com, apex(), "GET", "/api/users/\(seg(username))/account-key-attestation", body: nil as String?)
        return r.attestation
    }

    /// A demo account's devices hold no admin root: `.com` signs its #12.
    public func demoShareAccept(username: String, admit: ServerShareAcceptAdmin) async throws -> String {
        struct B: Encodable { let admit: ServerShareAcceptAdmin }
        struct R: Decodable { let signature: String }
        let r: R = try await send(com, apex(), "POST", "/api/dev/sample-user/\(seg(username))/share-accept", body: B(admit: admit))
        return r.signature
    }

    public func accept(shareId: String, token: String, acceptanceHex: String) async throws {
        struct B: Encodable { let acceptance: String }
        try await sendVoid(com, apex(), "POST", "/api/server-shares/\(shareId)/accept",
                           body: B(acceptance: acceptanceHex), headers: [Self.shareTokenHeader: token])
    }

    public func leaveOnCom(token: String, leave: ServerShareLeave, signature: String) async throws {
        try await sendVoid(com, apex(), "POST", "/api/server-shares/\(leave.shareId)/leave",
                           body: ShareSignedBody(key: "leave", envelope: leave, signature: signature),
                           headers: [Self.shareTokenHeader: token])
    }

    /// Registers (`put`, with the token) or drops (`delete`) this device's
    /// start-up push for one share.
    public func sharePush(token: String, push: ServerSharePush, signature: String, providerToken: String?) async throws {
        try await sendVoid(com, apex(), "POST", "/api/server-shares/\(push.shareId)/push",
                           body: SharePushBody(push: push, signature: signature, providerToken: providerToken),
                           headers: [Self.shareTokenHeader: token])
    }

    public func inboxPut(request: ShareInboxRequest, signature: String, ct: String) async throws {
        try await sendVoid(com, apex(), "POST", "/api/share-inbox",
                           body: ShareInboxBody(request: request, signature: signature, ct: ct))
    }

    public func inboxList(request: ShareInboxRequest, signature: String) async throws -> [ShareInboxListEntry] {
        struct R: Decodable { let entries: [ShareInboxListEntry] }
        let r: R = try await send(com, apex(), "POST", "/api/share-inbox",
                                  body: ShareInboxBody(request: request, signature: signature, ct: nil))
        return r.entries
    }

    public func inboxDelete(request: ShareInboxRequest, signature: String) async throws {
        try await sendVoid(com, apex(), "POST", "/api/share-inbox",
                           body: ShareInboxBody(request: request, signature: signature, ct: nil))
    }

    // MARK: Boot gate (role "share")

    public func bootPending(serverDomain: String, auth: String) async throws -> [ShareBootPending] {
        struct R: Decodable { let requests: [ShareBootPending] }
        let r: R = try await send(com, boot(), "GET", Self.bootPendingPath(serverDomain), body: nil as String?,
                                  headers: ["authorization": auth])
        return r.requests
    }

    public func bootKey(serverDomain: String, auth: String) async throws -> String {
        struct R: Decodable { let sealedKey: String }
        let r: R = try await send(com, boot(), "GET", Self.bootKeyPath(serverDomain), body: nil as String?,
                                  headers: ["authorization": auth])
        return r.sealedKey
    }

    public func bootRespond(_ response: SecretResponseBody, auth: String) async throws {
        struct B: Encodable { let response: SecretResponseBody }
        try await sendVoid(com, boot(), "POST", Self.bootResponsePath, body: B(response: response),
                           headers: ["authorization": auth])
    }

    public static func bootPendingPath(_ serverDomain: String) -> String { "/api/boot/share/pending/\(serverDomain)" }
    public static func bootKeyPath(_ serverDomain: String) -> String { "/api/boot/share/key/\(serverDomain)" }
    public static let bootResponsePath = "/api/boot/response"

    // MARK: Box, owner session

    public func boxShares(serverDomain: String, ownerToken: String) async throws -> BoxSharesResponse {
        try await send(box, try boxURL(serverDomain), "GET", "/api/screens/shares", body: nil as String?,
                       headers: [Self.sessionHeader: ownerToken])
    }

    public func boxGrant(serverDomain: String, ownerToken: String, grant: ServerShareGrant, signature: String,
                         accept: ServerShareAccept?, acceptSignature: String?,
                         acceptAdmin: ShareAcceptAdminProof? = nil) async throws {
        try await sendVoid(box, try boxURL(serverDomain), "POST", "/api/screens/shares",
                           body: ShareGrantBody(grant: grant, signature: signature, accept: accept,
                                                acceptSignature: acceptSignature, acceptAdmin: acceptAdmin),
                           headers: [Self.sessionHeader: ownerToken])
    }

    public func boxRevoke(serverDomain: String, ownerToken: String, revoke: ServerShareRevoke, signature: String) async throws {
        try await sendVoid(box, try boxURL(serverDomain), "POST", "/api/screens/shares/revoke",
                           body: ShareSignedBody(key: "revoke", envelope: revoke, signature: signature),
                           headers: [Self.sessionHeader: ownerToken])
    }

    public func boxActivity(serverDomain: String, ownerToken: String, limit: Int = 50) async throws -> [ShareActivityEntry] {
        struct R: Decodable { let entries: [ShareActivityEntry] }
        let r: R = try await send(box, try boxURL(serverDomain), "GET", "/api/screens/activity?limit=\(limit)",
                                  body: nil as String?, headers: [Self.sessionHeader: ownerToken])
        return r.entries
    }

    // MARK: Box, the second account

    public func boxNonce(serverDomain: String) async throws -> String {
        struct R: Decodable { let nonce: String }
        let r: R = try await send(box, try boxURL(serverDomain), "GET", "/api/shares/nonce", body: nil as String?)
        return r.nonce
    }

    public func boxSession(serverDomain: String, session: ServerShareSession, signature: String) async throws -> ShareSessionResponse {
        try await send(box, try boxURL(serverDomain), "POST", "/api/shares/session",
                       body: ShareSignedBody(key: "session", envelope: session, signature: signature))
    }

    public func boxMe(serverDomain: String, shareToken: String) async throws -> ShareMeResponse {
        try await send(box, try boxURL(serverDomain), "GET", "/api/shares/me", body: nil as String?,
                       headers: [Self.sessionHeader: shareToken])
    }

    public func boxUpdate(serverDomain: String, shareToken: String, update: ServerShareUpdate,
                          signature: String) async throws -> ShareUpdateAccepted {
        try await send(box, try boxURL(serverDomain), "POST", "/api/shares/update",
                       body: ShareSignedBody(key: "update", envelope: update, signature: signature),
                       headers: [Self.sessionHeader: shareToken])
    }

    public func boxLeave(serverDomain: String, leave: ServerShareLeave, signature: String) async throws {
        try await sendVoid(box, try boxURL(serverDomain), "POST", "/api/shares/leave",
                           body: ShareSignedBody(key: "leave", envelope: leave, signature: signature))
    }

    // MARK: Box, co-manager invites (docs/service-access-gating.md "Co-manager invites")

    public func boxInvites(serverDomain: String, shareToken: String, serviceRef: String) async throws -> ShareInvitesResponse {
        let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        let q = serviceRef.addingPercentEncoding(withAllowedCharacters: unreserved) ?? serviceRef
        return try await send(box, try boxURL(serverDomain), "GET", "/api/shares/invites?service=\(q)", body: nil as String?,
                              headers: [Self.sessionHeader: shareToken])
    }

    public func boxCreateInvite(serverDomain: String, shareToken: String, request: ShareInviteCreateRequest,
                                signature: String) async throws {
        try await sendVoid(box, try boxURL(serverDomain), "POST", "/api/shares/invites",
                           body: ShareInviteCreateBody(request: request, signature: signature),
                           headers: [Self.sessionHeader: shareToken])
    }

    public func boxWithdrawInvite(serverDomain: String, shareToken: String, revoke: ShareInviteRevoke,
                                  signature: String) async throws {
        try await sendVoid(box, try boxURL(serverDomain), "POST", "/api/shares/invites/withdraw",
                           body: ShareInviteWithdrawBody(revoke: revoke, signature: signature),
                           headers: [Self.sessionHeader: shareToken])
    }

    // MARK: Plumbing

    private func seg(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private func boxURL(_ serverDomain: String) throws -> URL {
        guard let u = boxBase(serverDomain) else { throw ServerShareHTTPError(status: 0, error: "bad server address", code: nil) }
        return u
    }

    private func request<B: Encodable>(_ base: URL, _ method: String, _ path: String, body: B?,
                                       headers: [String: String]) throws -> URLRequest {
        var origin = base.absoluteString
        while origin.hasSuffix("/") { origin.removeLast() }
        guard let url = URL(string: origin + path) else {
            throw ServerShareHTTPError(status: 0, error: "bad URL", code: nil)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body {
            let enc = JSONEncoder()
            enc.outputFormatting = [.withoutEscapingSlashes]
            req.httpBody = try enc.encode(body)
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        return req
    }

    private func raw<B: Encodable>(_ t: any ServerShareTransport, _ base: URL, _ method: String, _ path: String,
                                   body: B?, headers: [String: String]) async throws -> Data {
        let (status, data) = try await t.send(try request(base, method, path, body: body, headers: headers))
        guard (200..<300).contains(status) else {
            let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw ServerShareHTTPError(status: status, error: o?["error"] as? String, code: o?["code"] as? String)
        }
        return data
    }

    private func send<T: Decodable, B: Encodable>(_ t: any ServerShareTransport, _ base: URL, _ method: String,
                                                  _ path: String, body: B?, headers: [String: String] = [:]) async throws -> T {
        let data = try await raw(t, base, method, path, body: body, headers: headers)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ScreensClientError.decoding(String(describing: error))
        }
    }

    private func sendVoid<B: Encodable>(_ t: any ServerShareTransport, _ base: URL, _ method: String,
                                        _ path: String, body: B?, headers: [String: String] = [:]) async throws {
        _ = try await raw(t, base, method, path, body: body, headers: headers)
    }
}
