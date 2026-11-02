import Foundation
import FlagshipAPI

/// The apps' half of `.com`'s voi.ci pages and Messages API (docs/voici-and-messages.md §3, §5.2, §6.3, §8.3, and the
/// "D:" wire notes there). Every call goes through `gatedData`. Codes only come back: the apps write the sentences.
public struct VoiciComError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let retryAfterSec: Int?
    /// `first-contact-limit`: the new conversations a day the account's tier allows.
    public var limit: Int?
    /// What a 409 carries: the stored index (`seq-conflict`) or state blob (`version-conflict`).
    public let stored: JSONValue?

    public init(status: Int, code: String, retryAfterSec: Int? = nil, stored: JSONValue? = nil) {
        self.status = status; self.code = code; self.retryAfterSec = retryAfterSec; self.stored = stored
    }

    static func from(status: Int, data: Data) -> VoiciComError {
        let v = JSONValue.parse(utf8: Array(data))
        var e = VoiciComError(status: status, code: v?["code"]?.string ?? (status == 0 ? "network" : "http-\(status)"),
                              retryAfterSec: v?["retryAfterSec"]?.safeInt.map(Int.init),
                              stored: v?["index"] ?? v?["state"])
        e.limit = v?["limit"]?.safeInt.map(Int.init)
        return e
    }
}

/// One stored envelope of the owner's mailbox.
public struct VoiciInboxItem: Equatable, Sendable {
    public var envelope: JSONValue
    public var storedAt: Int64
    public var fetchedAt: Int64?
    /// Forwarded by the owner's phone after a direct delivery.
    public var direct: Bool
    public init(envelope: JSONValue, storedAt: Int64, fetchedAt: Int64? = nil, direct: Bool = false) {
        self.envelope = envelope; self.storedAt = storedAt; self.fetchedAt = fetchedAt; self.direct = direct
    }
}

/// `GET /api/voici/pages/<u>/inbox?since=`.
public struct VoiciInbox: Equatable, Sendable {
    public var items: [VoiciInboxItem]
    public var cursor: String
    public var blocks: [String]
    public var revoked: [String]
    public init(items: [VoiciInboxItem], cursor: String, blocks: [String] = [], revoked: [String] = []) {
        self.items = items; self.cursor = cursor; self.blocks = blocks; self.revoked = revoked
    }
}

/// The account's verification keys from `GET /api/username/<u>`.
public struct VoiciAccountKeys: Equatable, Sendable {
    public var irkPub: String
    public var adminRootPub: String?
    public init(irkPub: String, adminRootPub: String?) { self.irkPub = irkPub; self.adminRootPub = adminRootPub }
    /// The sensitive key a page index must be signed with.
    public var sensitive: (kind: String, pub: String) { adminRootPub.map { ("admin-root", $0) } ?? ("irk", irkPub) }
}

/// Device headers for one request (the `/profile` scheme): the caller signs `method` + `path`.
public typealias VoiciDeviceSigner = @Sendable (_ method: String, _ path: String) async -> AccountDirectoryAuthorization?

public protocol VoiciComClient: Sendable {
    func accountKeys(username: String) async throws -> VoiciAccountKeys
    /// The current signed index, nil when the account has no page.
    func page(username: String) async throws -> JSONValue?
    /// One piece, from `files.voi.ci` (the caller checks the hash).
    func piece(pageId: String, sha256: String) async throws -> [UInt8]
    func uploadPiece(username: String, upload: VoiciPieceUpload, signerPub: String, signature: String, bytes: [UInt8]) async throws
    func publish(username: String, index: JSONValue) async throws
    func depositDraft(username: String, envelope: JSONValue, device: VoiciDeviceSigner) async throws
    func drafts(username: String) async throws -> [JSONValue]
    func consumeDrafts(username: String, opIds: [String], issuedAt: Int64, signerPub: String, signature: String) async throws
    func inbox(username: String, since: String) async throws -> VoiciInbox
    func send(envelope: JSONValue, direct: Bool) async throws
    func block(username: String, block: VoiciBlock, signature: String) async throws
    func report(report: JSONValue, signature: String) async throws
    /// Sign one browser out: the revoke by P and the delegation it ends (`.com` keeps no P ↔ browser mapping).
    func revoke(_ r: WebDelegationRevoke, signature: String, delegation: JSONValue, delegationSig: String) async throws
    func messagesState(username: String) async throws -> JSONValue?
    func putMessagesState(username: String, blob: SealedMessagesState, device: VoiciDeviceSigner) async throws
    /// `integrity` nil for `deviceCheckRef` "none"; `previous` is the attestation a renewal names.
    func attest(username: String, request: MessagesKeyAttestationRequest, signature: String, integrity: JSONValue?,
                previous: JSONValue?, device: VoiciDeviceSigner) async throws -> JSONValue
    /// The visitor's own conversation with a page (§8.3 thread fetch): `{fetch:{conv, since, issuedAt}, signature, cred}`,
    /// signed by a delegated P-256 key. Answers `(items, next, more)`.
    func thread(fetch: VoiciThreadFetch, signature: String, cred: JSONValue) async throws -> (items: [VoiciInboxItem], next: String, more: Bool)
    /// The account's device grants (`GET /api/users/<u>/device-grants`, read token): `{grantId, username, deviceId,
    /// devicePubHex, scopes, issuedAt, expiresAt, signatureHex, signerRoot}` each.
    func deviceGrants(username: String) async throws -> [JSONValue]
    /// The CA keys attestations may be signed by now (the maintainer chain, checked by the app).
    func caKeys() async -> [String]
}

public enum VoiciComPaths {
    public static func seg(_ s: String) -> String { s.lowercased().addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-"])) ?? s }
    public static func page(_ u: String) -> String { "/api/voici/pages/\(seg(u))" }
    public static func pieces(_ u: String) -> String { page(u) + "/pieces" }
    public static func publish(_ u: String) -> String { page(u) + "/publish" }
    public static func inbox(_ u: String) -> String { page(u) + "/inbox" }
    public static func block(_ u: String) -> String { page(u) + "/block" }
    public static func drafts(_ u: String) -> String { "/api/accounts/\(seg(u))/voici-drafts" }
    public static func consume(_ u: String) -> String { drafts(u) + "/consume" }
    public static func state(_ u: String) -> String { "/api/accounts/\(seg(u))/messages-state" }
    public static func attest(_ u: String) -> String { "/api/accounts/\(seg(u))/messages-attestation" }
    public static let send = "/api/voici/web/send"
    public static let revoke = "/api/voici/web/revoke"
    public static let reports = "/api/voici/reports"
    public static let tagDraftsConsume = "flagship/voici-drafts-consume/v1"
    public static let thread = "/api/voici/web/thread"

    /// `flagship/voici-drafts-consume/v1|<u>|<opIds sorted, joined by ,>|<issuedAt>`, signed by the sensitive key.
    public static func canonicalDraftsConsume(username: String, opIds: [String], issuedAt: Int64) -> [UInt8] {
        CanonicalJson.join([tagDraftsConsume, username.lowercased(), opIds.sorted { CanonicalJson.utf16Less($0, $1) }.joined(separator: ","), String(issuedAt)])
    }
}

public final class LiveVoiciComClient: VoiciComClient, @unchecked Sendable {
    private let session: URLSession
    private let base: URL
    private let readTokens: (any AccountReadTokenSource)?
    private let trust: @Sendable () async -> [String]

    public init(session: URLSession = .shared, base: URL = Endpoints.controlBaseUrl, readTokens: (any AccountReadTokenSource)?,
                caKeys: @escaping @Sendable () async -> [String]) {
        self.session = session
        self.base = base
        self.readTokens = readTokens
        self.trust = caKeys
    }

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)!
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    private func json(_ method: String, _ path: String, _ body: JSONValue?, headers: [String: String] = [:]) throws -> URLRequest {
        var r = URLRequest(url: url(path), timeoutInterval: 20)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = Data(try CanonicalJson.canonicalJson(body).utf8)
        }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    private static func deviceHeaders(_ a: AccountDirectoryAuthorization) -> [String: String] {
        ["x-flagship-device-id": a.deviceId, "x-flagship-device-pub": a.signerPubHex, "x-flagship-request-id": a.requestId,
         "x-flagship-issued-at": String(a.issuedAt), "x-flagship-signature": a.signatureHex]
    }

    @discardableResult
    private func call(_ r: URLRequest) async throws -> JSONValue? {
        let (data, res) = try await session.gatedData(for: r)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw VoiciComError.from(status: status, data: data) }
        return data.isEmpty ? nil : JSONValue.parse(utf8: Array(data))
    }

    private func read(_ r: URLRequest, username: String) async throws -> JSONValue? {
        let (data, status) = try await sendAccountRead(r, username: username, tokens: readTokens) { try await self.session.gatedData(for: $0) }
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw VoiciComError.from(status: status, data: data) }
        return JSONValue.parse(utf8: Array(data))
    }

    public func accountKeys(username: String) async throws -> VoiciAccountKeys {
        let v = try await call(try json("GET", "/api/username/\(VoiciComPaths.seg(username))", nil))
        guard let irk = v?["irkPub"]?.string, CanonicalJson.isLowerHex(irk, bytes: 32) else { throw VoiciComError(status: 200, code: "malformed") }
        let admin = v?["adminRootPub"]?.string.flatMap { CanonicalJson.isLowerHex($0, bytes: 32) ? $0 : nil }
        return VoiciAccountKeys(irkPub: irk, adminRootPub: admin)
    }

    public func page(username: String) async throws -> JSONValue? {
        let (data, res) = try await session.gatedData(for: try json("GET", VoiciComPaths.page(username), nil))
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw VoiciComError.from(status: status, data: data) }
        return JSONValue.parse(utf8: Array(data))?["index"]
    }

    public func piece(pageId: String, sha256: String) async throws -> [UInt8] {
        var r = URLRequest(url: Endpoints.voiciFilesBaseUrl.appendingPathComponent("v1/p/\(pageId)/\(sha256)"), timeoutInterval: 20)
        r.httpMethod = "GET"
        let (data, res) = try await session.gatedData(for: r)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw VoiciComError.from(status: status, data: data) }
        return Array(data)
    }

    public func uploadPiece(username: String, upload: VoiciPieceUpload, signerPub: String, signature: String, bytes: [UInt8]) async throws {
        var r = URLRequest(url: url(VoiciComPaths.pieces(username)), timeoutInterval: 60)
        r.httpMethod = "POST"
        r.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        for (k, v) in ["x-flagship-page-id": upload.pageId, "x-flagship-sha256": upload.sha256, "x-flagship-size": String(upload.size),
                       "x-flagship-issued-at": String(upload.issuedAt), "x-flagship-signer-pub": signerPub, "x-flagship-signature": signature] {
            r.setValue(v, forHTTPHeaderField: k)
        }
        r.httpBody = Data(bytes)
        try await call(r)
    }

    public func publish(username: String, index: JSONValue) async throws {
        try await call(try json("POST", VoiciComPaths.publish(username), ["index": index]))
    }

    public func depositDraft(username: String, envelope: JSONValue, device: VoiciDeviceSigner) async throws {
        let path = VoiciComPaths.drafts(username)
        guard let a = await device("POST", path) else { throw VoiciComError(status: 0, code: "no-device-key") }
        try await call(try json("POST", path, envelope, headers: Self.deviceHeaders(a)))
    }

    public func drafts(username: String) async throws -> [JSONValue] {
        (try await read(try json("GET", VoiciComPaths.drafts(username), nil), username: username)?["drafts"]?.array ?? []).compactMap { $0["envelope"] }
    }

    public func consumeDrafts(username: String, opIds: [String], issuedAt: Int64, signerPub: String, signature: String) async throws {
        try await call(try json("POST", VoiciComPaths.consume(username), [
            "consume": ["username": .string(username.lowercased()), "opIds": .array(opIds.map { .string($0) }), "issuedAt": .int(issuedAt)],
            "signature": .string(signature),
        ]))
    }

    /// Every page of `{messages:[{id, envelope, storedAt, direct}], cursor, more, blocks, revoked}` since `since`.
    public func inbox(username: String, since: String) async throws -> VoiciInbox {
        var out = VoiciInbox(items: [], cursor: since)
        for _ in 0..<20 {
            var r = try json("GET", VoiciComPaths.inbox(username), nil)
            r.url = url(VoiciComPaths.inbox(username), query: [URLQueryItem(name: "since", value: out.cursor)])
            guard let v = try await read(r, username: username) else { return out }
            out.items += (v["messages"]?.array ?? v["items"]?.array ?? []).compactMap { i -> VoiciInboxItem? in
                guard let e = i["envelope"], let at = i["storedAt"]?.time else { return nil }
                return VoiciInboxItem(envelope: e, storedAt: at, fetchedAt: i["fetchedAt"]?.time, direct: i["direct"] == .bool(true))
            }
            out.cursor = v["cursor"]?.string ?? out.cursor
            out.blocks = (v["blocks"]?.array ?? []).compactMap(\.string)
            out.revoked = (v["revoked"]?.array ?? []).compactMap(\.string)
            if v["more"] != .bool(true) { break }
        }
        return out
    }

    public func send(envelope: JSONValue, direct: Bool) async throws {
        try await call(try json("POST", VoiciComPaths.send, ["envelope": envelope, "direct": .bool(direct)]))
    }

    public func block(username: String, block: VoiciBlock, signature: String) async throws {
        try await call(try json("POST", VoiciComPaths.block(username), ["block": block.json, "signature": .string(signature)]))
    }

    public func report(report: JSONValue, signature: String) async throws {
        try await call(try json("POST", VoiciComPaths.reports, ["report": report, "signature": .string(signature)]))
    }

    public func revoke(_ r: WebDelegationRevoke, signature: String, delegation: JSONValue, delegationSig: String) async throws {
        try await call(try json("POST", VoiciComPaths.revoke, ["revoke": r.json, "signature": .string(signature),
                                                               "delegation": delegation, "delegationSig": .string(delegationSig)]))
    }

    /// `{state: {version, nonce, ct} | null}`.
    public func messagesState(username: String) async throws -> JSONValue? {
        guard let s = try await read(try json("GET", VoiciComPaths.state(username), nil), username: username)?["state"], !s.isNull else { return nil }
        return s
    }

    public func putMessagesState(username: String, blob: SealedMessagesState, device: VoiciDeviceSigner) async throws {
        let path = VoiciComPaths.state(username)
        guard let a = await device("PUT", path) else { throw VoiciComError(status: 0, code: "no-device-key") }
        try await call(try json("PUT", path, ["state": blob.json], headers: Self.deviceHeaders(a)))
    }

    public func attest(username: String, request: MessagesKeyAttestationRequest, signature: String, integrity: JSONValue?,
                       previous: JSONValue?, device: VoiciDeviceSigner) async throws -> JSONValue {
        let path = VoiciComPaths.attest(username)
        guard let a = await device("POST", path) else { throw VoiciComError(status: 0, code: "no-device-key") }
        let req: JSONValue = ["username": .string(request.username), "pseudonymPub": .string(request.pseudonymPub),
                              "renewOfHash": .string(request.renewOfHash), "deviceCheckRef": .string(request.deviceCheckRef),
                              "issuedAt": .int(request.issuedAt)]
        var body: [String: JSONValue] = ["request": req, "signature": .string(signature)]
        if let integrity { body["integrity"] = integrity }
        if let previous { body["previous"] = previous }
        let v = try await call(try json("POST", path, .object(body), headers: Self.deviceHeaders(a)))
        guard let att = v?["attestation"] else { throw VoiciComError(status: 200, code: "malformed") }
        return att
    }

    public func thread(fetch: VoiciThreadFetch, signature: String, cred: JSONValue) async throws -> (items: [VoiciInboxItem], next: String, more: Bool) {
        let v = try await call(try json("POST", VoiciComPaths.thread, ["fetch": fetch.json, "signature": .string(signature), "cred": cred]))
        let items = (v?["items"]?.array ?? []).compactMap { i -> VoiciInboxItem? in
            guard let e = i["envelope"], let at = i["storedAt"]?.time else { return nil }
            return VoiciInboxItem(envelope: e, storedAt: at, fetchedAt: i["fetchedAt"]?.time, direct: i["direct"] == .bool(true))
        }
        return (items, v?["next"]?.string ?? fetch.since, v?["more"] == .bool(true))
    }

    public func deviceGrants(username: String) async throws -> [JSONValue] {
        try await read(try json("GET", "/api/users/\(VoiciComPaths.seg(username))/device-grants", nil), username: username)?["grants"]?.array ?? []
    }

    public func caKeys() async -> [String] { await trust() }
}

/// `flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt>`, signed by a delegated P-256 key (IEEE P1363). The
/// visitor's app uses it only to learn whether a page owner replied (docs/voici-and-messages.md, the "D:" reply note).
public struct VoiciThreadFetch: Equatable, Sendable {
    public static let tag = "flagship/voici-thread-fetch/v1"
    public var conv: String
    public var since: String
    public var issuedAt: Int64
    public init(conv: String, since: String, issuedAt: Int64) { self.conv = conv; self.since = since; self.issuedAt = issuedAt }
    public var json: JSONValue { ["conv": .string(conv), "since": .string(since), "issuedAt": .int(issuedAt)] }

    public func canonicalBytes() throws -> [UInt8] {
        guard CanonicalJson.isLowerHex(conv, bytes: 32), since.utf8.count <= 64,
              since.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x41...0x5a).contains($0) || (0x61...0x7a).contains($0) || $0 == 0x5f || $0 == 0x2d }),
              issuedAt >= 0 else { throw CanonicalJsonError("\(Self.tag): bad field") }
        return CanonicalJson.join([Self.tag, conv, since, String(issuedAt)])
    }
}
