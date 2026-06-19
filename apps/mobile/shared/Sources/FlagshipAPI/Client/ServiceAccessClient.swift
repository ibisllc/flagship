import Foundation

/// Box- AND `.com`-direct delivery for per-service access gating
/// (docs/service-access-gating.md).
///
/// BOX (pinned canonical pipe, owner-IRK or friend-AID signed):
///   GET  https://<serverDomain>/api/service-access/<serviceRef>   → { mode, allowCount }
///   POST https://<serverDomain>/api/service-access                (set-service-access-mode envelope)
///   POST https://<serverDomain>/api/service-invites/redeem        ({ secret, visitorAID, aidSig, redeemedAt })
///
/// `.com` (public CA — no pinning), author IRK-signed create/revoke + a
/// metadata list:
///   POST https://<control>/api/users/<u>/service-invites          (create envelope)
///   GET  https://<control>/api/users/<u>/service-invites?authorAID=…
///   POST https://<control>/api/users/<u>/service-invites/revoke    (revoke envelope)
///
/// Like FrontPageClient, the transport takes already-built `request`
/// dictionaries + hex signatures so this layer stays free of the FlagshipCore
/// envelope types (FlagshipCore depends on FlagshipAPI, not the reverse).
public protocol ServiceAccessClient: Sendable {
    // box
    func getAccessState(serverDomain: String, serviceRef: String) async throws -> ServiceAccessState
    func setAccessMode(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> String
    /// Owner-IRK prune of one friend's AID from a service allow-list (the box
    /// half of "remove person"). The `request` dict is already built
    /// (serverId/serviceRef/aid/issuedAt); `signatureHex` is the owner-IRK
    /// Ed25519 sig over the canonical remove-allow bytes. POSTs to the box's
    /// pinned pipe; returns whether an entry was actually removed (idempotent —
    /// a no-op prune still returns 200). 403 on a bad/stale/mismatch sig.
    func removeServiceAllow(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> RemoveAllowResult
    func redeemInvite(serverDomain: String, secretHex: String, visitorAidHex: String, aidSigHex: String, redeemedAt: Int64) async throws -> RedeemResult
    // .com
    func createInvite(controlBase: URL, username: String, request: [String: Any], signatureHex: String) async throws
    func listInvites(controlBase: URL, username: String, authorAidHex: String) async throws -> [ServiceInviteRow]
    func revokeInvite(controlBase: URL, username: String, inviteId: String, request: [String: Any], signatureHex: String) async throws
    // box — web-experience gating (docs/service-access-gating.md, "Web-experience gating")
    /// AID-signed authorize of a browser's knock page. The `authorization`
    /// dict is already built (serverId/serviceRef/pageId/visitorAID/issuedAt);
    /// `signatureHex` is the Ed25519 sig over the canonical knock bytes. On
    /// success the box returns the phone-held secretId + the started session.
    func authorizeKnock(serverDomain: String, authorization: [String: Any], signatureHex: String) async throws -> AuthorizeKnockResult
    /// Poll a held session's `online`/`offline` (the secretId rides the BODY,
    /// never the URL — so it can't land in access logs). Rate-limited ~1/min;
    /// a 429 surfaces as `ServiceAccessError.statusRateLimited`.
    func sessionStatus(serverDomain: String, secretId: String) async throws -> SecuredSessionStatus
    /// Close a held session (kills the browser cookie). Idempotent + oracle-free.
    func closeSession(serverDomain: String, secretId: String) async throws
}

/// Result of a successful knock authorize — the phone keeps the secretId to
/// later poll/close the browser session it just authorized.
public struct AuthorizeKnockResult: Equatable, Sendable {
    public let secretId: String
    public let serviceRef: String
    public let browserAgent: String
    public let startedAt: Int64
    public let expiresAt: Int64
    public init(secretId: String, serviceRef: String, browserAgent: String, startedAt: Int64, expiresAt: Int64) {
        self.secretId = secretId
        self.serviceRef = serviceRef
        self.browserAgent = browserAgent
        self.startedAt = startedAt
        self.expiresAt = expiresAt
    }
}

/// A held browser session's liveness as the box reports it. Unknown / closed /
/// expired all collapse to `.offline` (the box gives no enumeration oracle).
public enum SecuredSessionStatus: String, Equatable, Sendable {
    case online
    case offline
}

public struct ServiceAccessState: Equatable, Sendable {
    /// "open" | "restricted".
    public let mode: String
    /// Count of allow-listed AIDs (never the AIDs themselves).
    public let allowCount: Int
    public init(mode: String, allowCount: Int) {
        self.mode = mode
        self.allowCount = allowCount
    }
    public var isRestricted: Bool { mode == "restricted" }
}

/// Result of an owner-IRK allow-list prune. `removed` is false when the AID was
/// already absent (the box treats the prune as idempotent + still returns 200).
public struct RemoveAllowResult: Equatable, Sendable {
    public let ok: Bool
    public let removed: Bool
    public init(ok: Bool, removed: Bool) {
        self.ok = ok
        self.removed = removed
    }
}

public struct RedeemResult: Equatable, Sendable {
    public let serviceRef: String
    public let boundAidHex: String
    public let firstBind: Bool
    public init(serviceRef: String, boundAidHex: String, firstBind: Bool) {
        self.serviceRef = serviceRef
        self.boundAidHex = boundAidHex
        self.firstBind = firstBind
    }
}

/// A `.com` invite row (metadata only — `.com` never stores the secret). The
/// bundle is ciphertext; the caller decrypts it locally with the household key.
public struct ServiceInviteRow: Equatable, Sendable, Identifiable {
    public let inviteId: String
    public let serviceRef: String
    public let encryptedBundleHex: String
    public let boundAidHex: String?
    public let boundAt: Int64?
    public let createdAt: Int64?
    public let revokedAt: Int64?
    public var id: String { inviteId }
    public init(inviteId: String, serviceRef: String, encryptedBundleHex: String, boundAidHex: String?, boundAt: Int64?, createdAt: Int64?, revokedAt: Int64?) {
        self.inviteId = inviteId
        self.serviceRef = serviceRef
        self.encryptedBundleHex = encryptedBundleHex
        self.boundAidHex = boundAidHex
        self.boundAt = boundAt
        self.createdAt = createdAt
        self.revokedAt = revokedAt
    }
}

/// Distinct errors the redeem surfaces so the UI can speak plainly.
public enum ServiceAccessError: Error, Equatable {
    case inviteUnknown      // 404
    case inviteAlreadyBound // 409
    case inviteRevoked      // 403
    // Web-experience-gating knock authorize.
    case knockNotAllowed    // 401 — this AID isn't allow-listed for the service
    case knockBadRequest    // 403 — bad/stale/sig-mismatch (refresh the page)
    case knockPageExpired   // 404 — the knock page expired (refresh + retry)
    /// 429 from the session-status poll — checked too recently (debounce ≥60s).
    case statusRateLimited
}

/// URLSession-backed implementation. The BOX session must be the box-pinned
/// session (hard-fail cert-fingerprint pinning) like the screens / front-page
/// clients; the `.com` calls go over a separate public-CA session.
public final class LiveServiceAccessClient: ServiceAccessClient, @unchecked Sendable {
    private let boxSession: URLSession
    private let comSession: URLSession

    public init(boxSession: URLSession, comSession: URLSession = .shared) {
        self.boxSession = boxSession
        self.comSession = comSession
    }

    private static func boxBase(_ serverDomain: String) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return "https://\(host)"
    }

    private func send(_ req: URLRequest, on session: URLSession) async throws -> (Data, Int) {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            if let host = req.url?.host, CertPinMismatchSink.shared.consumeRecentMismatch(host: host) {
                throw ScreensClientError.certPinMismatch(host: host)
            }
            throw error
        }
        guard let http = resp as? HTTPURLResponse else {
            throw ScreensClientError.http(status: 0, message: "no response")
        }
        return (data, http.statusCode)
    }

    private func ok(_ data: Data, _ status: Int) throws -> Data {
        if !(200..<300).contains(status) {
            throw ScreensClientError.http(status: status, message: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    // ── box ───────────────────────────────────────────────────────────────

    public func getAccessState(serverDomain: String, serviceRef: String) async throws -> ServiceAccessState {
        let enc = serviceRef.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceRef
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-access/" + enc) else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        let (data, status) = try await send(URLRequest(url: url), on: boxSession)
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let mode = (obj?["mode"] as? String) ?? "open"
        let count = (obj?["allowCount"] as? Int) ?? ((obj?["allowCount"] as? NSNumber)?.intValue ?? 0)
        return ServiceAccessState(mode: mode, allowCount: count)
    }

    public func setAccessMode(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> String {
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-access") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["request": request, "signature": signatureHex], options: [])
        let (data, status) = try await send(req, on: boxSession)
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        return (obj?["mode"] as? String) ?? ((request["mode"] as? String) ?? "open")
    }

    public func removeServiceAllow(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> RemoveAllowResult {
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-access/allow-remove") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["request": request, "signature": signatureHex], options: [])
        let (data, status) = try await send(req, on: boxSession)
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        return RemoveAllowResult(
            ok: (obj?["ok"] as? Bool) ?? false,
            removed: (obj?["removed"] as? Bool) ?? false
        )
    }

    public func redeemInvite(serverDomain: String, secretHex: String, visitorAidHex: String, aidSigHex: String, redeemedAt: Int64) async throws -> RedeemResult {
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-invites/redeem") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "secret": secretHex.lowercased(),
            "visitorAID": visitorAidHex.lowercased(),
            "aidSig": aidSigHex.lowercased(),
            "redeemedAt": redeemedAt,
        ], options: [])
        let (data, status) = try await send(req, on: boxSession)
        if status == 404 { throw ServiceAccessError.inviteUnknown }
        if status == 409 { throw ServiceAccessError.inviteAlreadyBound }
        if status == 403 { throw ServiceAccessError.inviteRevoked }
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        return RedeemResult(
            serviceRef: (obj?["serviceRef"] as? String) ?? "",
            boundAidHex: (obj?["boundAID"] as? String) ?? "",
            firstBind: (obj?["firstBind"] as? Bool) ?? false
        )
    }

    public func authorizeKnock(serverDomain: String, authorization: [String: Any], signatureHex: String) async throws -> AuthorizeKnockResult {
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-access/knock/authorize") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["authorization": authorization, "sig": signatureHex.lowercased()], options: [])
        let (data, status) = try await send(req, on: boxSession)
        if status == 401 { throw ServiceAccessError.knockNotAllowed }
        if status == 403 { throw ServiceAccessError.knockBadRequest }
        if status == 404 { throw ServiceAccessError.knockPageExpired }
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        func i64(_ k: String) -> Int64 { (obj?[k] as? NSNumber)?.int64Value ?? 0 }
        return AuthorizeKnockResult(
            secretId: (obj?["secretId"] as? String) ?? "",
            serviceRef: (obj?["serviceRef"] as? String) ?? "",
            browserAgent: (obj?["browserAgent"] as? String) ?? "",
            startedAt: i64("startedAt"),
            expiresAt: i64("expiresAt")
        )
    }

    public func sessionStatus(serverDomain: String, secretId: String) async throws -> SecuredSessionStatus {
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-access/session/status") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["secretId": secretId.lowercased()], options: [])
        let (data, status) = try await send(req, on: boxSession)
        if status == 429 { throw ServiceAccessError.statusRateLimited }
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        return (obj?["status"] as? String) == "online" ? .online : .offline
    }

    public func closeSession(serverDomain: String, secretId: String) async throws {
        guard let url = URL(string: Self.boxBase(serverDomain) + "/api/service-access/session/close") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["secretId": secretId.lowercased()], options: [])
        let (data, status) = try await send(req, on: boxSession)
        _ = try ok(data, status)
    }

    // ── .com ────────────────────────────────────────────────────────────────

    private static func comUrl(_ base: URL, _ username: String, _ suffix: String, query: String? = nil) -> URL? {
        let u = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username
        var s = base.absoluteString
        if s.hasSuffix("/") { s.removeLast() }
        s += "/api/users/\(u)/service-invites" + suffix
        if let query { s += "?" + query }
        return URL(string: s)
    }

    public func createInvite(controlBase: URL, username: String, request: [String: Any], signatureHex: String) async throws {
        guard let url = Self.comUrl(controlBase, username, "") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["request": request, "signature": signatureHex], options: [])
        let (data, status) = try await send(req, on: comSession)
        _ = try ok(data, status)
    }

    public func listInvites(controlBase: URL, username: String, authorAidHex: String) async throws -> [ServiceInviteRow] {
        guard let url = Self.comUrl(controlBase, username, "", query: "authorAID=\(authorAidHex.lowercased())") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, status) = try await send(req, on: comSession)
        let body = try ok(data, status)
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let rows = (obj?["invites"] as? [[String: Any]]) ?? []
        return rows.compactMap { r in
            guard let inviteId = r["inviteId"] as? String,
                  let serviceRef = r["serviceRef"] as? String,
                  let bundle = r["encryptedBundle"] as? String else { return nil }
            func i64(_ k: String) -> Int64? { (r[k] as? NSNumber)?.int64Value }
            return ServiceInviteRow(
                inviteId: inviteId,
                serviceRef: serviceRef,
                encryptedBundleHex: bundle,
                boundAidHex: r["boundAID"] as? String,
                boundAt: i64("boundAt"),
                createdAt: i64("createdAt"),
                revokedAt: i64("revokedAt")
            )
        }
    }

    public func revokeInvite(controlBase: URL, username: String, inviteId: String, request: [String: Any], signatureHex: String) async throws {
        guard let url = Self.comUrl(controlBase, username, "/revoke") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["request": request, "signature": signatureHex], options: [])
        let (data, status) = try await send(req, on: comSession)
        _ = try ok(data, status)
    }
}

/// In-memory mock for tests + previews: records writes, returns configurable
/// state / invite rows, and mock-binds on redeem.
public final class MockServiceAccessClient: ServiceAccessClient, @unchecked Sendable {
    public struct SetModeCall: Sendable { public let serverDomain: String; public let request: [String: String]; public let signatureHex: String }
    public struct RemoveAllowCall: Sendable { public let serverDomain: String; public let request: [String: String]; public let signatureHex: String }
    public struct CreateCall: Sendable { public let username: String; public let request: [String: String]; public let signatureHex: String }
    public struct RevokeCall: Sendable { public let username: String; public let inviteId: String }
    public struct RedeemCall: Sendable { public let serverDomain: String; public let secretHex: String; public let visitorAidHex: String }
    public struct AuthorizeKnockCall: Sendable { public let serverDomain: String; public let authorization: [String: String]; public let signatureHex: String }
    public struct SessionStatusCall: Sendable { public let serverDomain: String; public let secretId: String }
    public struct CloseSessionCall: Sendable { public let serverDomain: String; public let secretId: String }

    private let lock = NSLock()
    private var _setMode: [SetModeCall] = []
    private var _removeAllow: [RemoveAllowCall] = []
    private var _create: [CreateCall] = []
    private var _revoke: [RevokeCall] = []
    private var _redeem: [RedeemCall] = []
    private var _authorizeKnock: [AuthorizeKnockCall] = []
    private var _sessionStatus: [SessionStatusCall] = []
    private var _closeSession: [CloseSessionCall] = []
    public var setModeCalls: [SetModeCall] { lock.withLock { _setMode } }
    public var removeAllowCalls: [RemoveAllowCall] { lock.withLock { _removeAllow } }
    public var createCalls: [CreateCall] { lock.withLock { _create } }
    public var revokeCalls: [RevokeCall] { lock.withLock { _revoke } }
    public var redeemCalls: [RedeemCall] { lock.withLock { _redeem } }
    public var authorizeKnockCalls: [AuthorizeKnockCall] { lock.withLock { _authorizeKnock } }
    public var sessionStatusCalls: [SessionStatusCall] { lock.withLock { _sessionStatus } }
    public var closeSessionCalls: [CloseSessionCall] { lock.withLock { _closeSession } }

    public var state = ServiceAccessState(mode: "open", allowCount: 0)
    public var removeAllowResult = RemoveAllowResult(ok: true, removed: true)
    public var rows: [ServiceInviteRow] = []
    public var redeemResult = RedeemResult(serviceRef: "alice-notes", boundAidHex: "00", firstBind: true)
    public var authorizeKnockResult = AuthorizeKnockResult(
        secretId: String(repeating: "ab", count: 32),
        serviceRef: "alice-notes",
        browserAgent: "Mozilla/5.0 (Macintosh)",
        startedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_000_000 + 12 * 60 * 60_000
    )
    public var sessionStatusResult: SecuredSessionStatus = .online
    public var nextError: Error?

    public init() {}
    private func maybeThrow() throws { if let e = nextError { nextError = nil; throw e } }
    private func flatten(_ r: [String: Any]) -> [String: String] { var f: [String: String] = [:]; for (k, v) in r { f[k] = String(describing: v) }; return f }

    public func getAccessState(serverDomain: String, serviceRef: String) async throws -> ServiceAccessState { try maybeThrow(); return state }

    public func setAccessMode(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> String {
        try maybeThrow()
        lock.withLock { _setMode.append(SetModeCall(serverDomain: serverDomain, request: flatten(request), signatureHex: signatureHex)) }
        let mode = (request["mode"] as? String) ?? "open"
        state = ServiceAccessState(mode: mode, allowCount: state.allowCount)
        return mode
    }

    public func removeServiceAllow(serverDomain: String, request: [String: Any], signatureHex: String) async throws -> RemoveAllowResult {
        try maybeThrow()
        lock.withLock { _removeAllow.append(RemoveAllowCall(serverDomain: serverDomain, request: flatten(request), signatureHex: signatureHex)) }
        return removeAllowResult
    }

    public func redeemInvite(serverDomain: String, secretHex: String, visitorAidHex: String, aidSigHex: String, redeemedAt: Int64) async throws -> RedeemResult {
        try maybeThrow()
        lock.withLock { _redeem.append(RedeemCall(serverDomain: serverDomain, secretHex: secretHex, visitorAidHex: visitorAidHex)) }
        return redeemResult
    }

    public func createInvite(controlBase: URL, username: String, request: [String: Any], signatureHex: String) async throws {
        try maybeThrow()
        lock.withLock { _create.append(CreateCall(username: username, request: flatten(request), signatureHex: signatureHex)) }
    }

    public func listInvites(controlBase: URL, username: String, authorAidHex: String) async throws -> [ServiceInviteRow] { try maybeThrow(); return rows }

    public func revokeInvite(controlBase: URL, username: String, inviteId: String, request: [String: Any], signatureHex: String) async throws {
        try maybeThrow()
        lock.withLock { _revoke.append(RevokeCall(username: username, inviteId: inviteId)) }
        rows = rows.map { $0.inviteId == inviteId ? ServiceInviteRow(inviteId: $0.inviteId, serviceRef: $0.serviceRef, encryptedBundleHex: $0.encryptedBundleHex, boundAidHex: $0.boundAidHex, boundAt: $0.boundAt, createdAt: $0.createdAt, revokedAt: 1) : $0 }
    }

    public func authorizeKnock(serverDomain: String, authorization: [String: Any], signatureHex: String) async throws -> AuthorizeKnockResult {
        lock.withLock { _authorizeKnock.append(AuthorizeKnockCall(serverDomain: serverDomain, authorization: flatten(authorization), signatureHex: signatureHex)) }
        try maybeThrow()
        return authorizeKnockResult
    }

    public func sessionStatus(serverDomain: String, secretId: String) async throws -> SecuredSessionStatus {
        lock.withLock { _sessionStatus.append(SessionStatusCall(serverDomain: serverDomain, secretId: secretId)) }
        try maybeThrow()
        return sessionStatusResult
    }

    public func closeSession(serverDomain: String, secretId: String) async throws {
        lock.withLock { _closeSession.append(CloseSessionCall(serverDomain: serverDomain, secretId: secretId)) }
        try maybeThrow()
    }
}
