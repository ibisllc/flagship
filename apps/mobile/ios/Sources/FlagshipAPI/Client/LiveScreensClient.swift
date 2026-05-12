import Foundation

/// URLSession-backed ScreensClient. Talks to a paired pod at
/// `<server>.<user>.flagship.services` and signs every request with the
/// 32-byte hex session token in the `x-flagship-session` header.
///
/// Not yet exercised end-to-end — most methods throw .notImplemented for
/// now. The wire format mirrors `apps/web/public/webapp/lib/api.js` and
/// the daemon contract in `packages/server-daemon/src/screens/types.ts`.
public final class LiveScreensClient: ScreensClient, @unchecked Sendable {
    private let urlSession: URLSession
    private let store: SessionStore

    public init(urlSession: URLSession = .shared, store: SessionStore) {
        self.urlSession = urlSession
        self.store = store
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        guard let base = await store.podBaseUrl else { throw ScreensClientError.notPaired }
        guard let token = await store.sessionToken else { throw ScreensClientError.noSessionToken }
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(token, forHTTPHeaderField: "x-flagship-session")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }

        let (data, resp) = try await urlSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ScreensClientError.http(status: 0, message: "no response")
        }
        if !(200..<300).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: http.statusCode, message: text)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ScreensClientError.decoding(String(describing: error))
        }
    }

    public func serverDetail() async throws -> ServerDetailResponse {
        try await request("/api/screens/server-detail")
    }
    public func appsList() async throws -> AppsListResponse {
        try await request("/api/screens/apps-list")
    }
    public func appDetail(appId: String) async throws -> AppDetailResponse {
        try await request("/api/screens/app-detail/\(appId)")
    }
    public func marketplaceBrowse() async throws -> MarketplaceBrowseResponse {
        try await request("/api/screens/marketplace-browse")
    }
    public func vibeCodeStart(_ req: VibeCodeStartRequest) async throws -> VibeCodeStartResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/vibe-code/start", method: "POST", body: body)
    }
    public func vibeCodeStatus(sessionId: String) async throws -> VibeCodeStatusResponse {
        try await request("/api/screens/vibe-code/\(sessionId)")
    }
    public func unlockApprovalsPending() async throws -> UnlockApprovalsPendingResponse {
        try await request("/api/screens/unlock-approvals/pending")
    }
    public func approveUnlock(requestId: String, body: UnlockApprovalApproveRequest) async throws {
        let payload = try JSONEncoder().encode(body)
        let _: EmptyResponse = try await request(
            "/api/screens/unlock-approvals/\(requestId)/approve",
            method: "POST",
            body: payload
        )
    }
    public func browserTabsList(appId: String) async throws -> BrowserTabsListResponse {
        try await request("/api/screens/browser-tabs/list/\(appId)")
    }
    public func pairedSessionsList() async throws -> PairedSessionsListResponse {
        try await request("/api/screens/paired-sessions/list")
    }
    public func revokePairedSession(tokenPrefix: String) async throws {
        let _: EmptyResponse = try await request(
            "/api/screens/paired-sessions/\(tokenPrefix)",
            method: "DELETE"
        )
    }
    public func ordersSend(_ req: OrdersSendRequest) async throws -> OrdersSendResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/orders/send", method: "POST", body: body)
    }
    public func tierStatus() async throws -> TierStatusResponse {
        try await request("/api/screens/tier-status")
    }
    public func urlControllerOwned() async throws -> UrlControllerOwnedResponse {
        try await request("/api/screens/url-controller/owned")
    }
    public func urlControllerClaim(_ req: UrlControllerClaimRequest) async throws -> UrlControllerClaimResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/url-controller/claim", method: "POST", body: body)
    }
    public func appBackupStart(_ req: AppBackupStartRequest) async throws -> AppBackupStartResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/app-backup/start", method: "POST", body: body)
    }
    public func serverMetrics(podId: String) async throws -> ServerMetricsResponse {
        try await request("/api/screens/server-metrics/\(podId)")
    }
}

private struct EmptyResponse: Decodable {}
