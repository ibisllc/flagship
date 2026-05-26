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
    private let store: any SessionStoring

    public init(urlSession: URLSession = .shared, store: any SessionStoring) {
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
    public func appDetail(serviceId: String) async throws -> AppDetailResponse {
        try await request("/api/screens/app-detail/\(serviceId)")
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
    public func browserTabsList(serviceId: String) async throws -> BrowserTabsListResponse {
        try await request("/api/screens/browser-tabs/list/\(serviceId)")
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

    /// SSE stream of `InstallEvent`s. Each `data:` frame is a JSON
    /// `InstallEvent`; the stream finishes on the daemon's
    /// `event: end` line or when the underlying URLSession bytes
    /// stream closes.
    public func installEvents(serial: String) -> AsyncStream<InstallEvent> {
        AsyncStream { continuation in
            let task = Task { [self] in
                guard let base = await store.podBaseUrl,
                      let token = await store.sessionToken,
                      let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/screens/install-events/\(serial)")
                else {
                    continuation.finish()
                    return
                }
                var req = URLRequest(url: url)
                req.setValue(token, forHTTPHeaderField: "x-flagship-session")
                req.setValue("text/event-stream", forHTTPHeaderField: "accept")
                do {
                    let (bytes, _) = try await urlSession.bytes(for: req)
                    var buffer = ""
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            buffer = ""
                            continue
                        }
                        guard line.hasPrefix("data:") else { continue }
                        buffer = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        if let data = buffer.data(using: .utf8),
                           let event = try? JSONDecoder().decode(InstallEvent.self, from: data) {
                            continuation.yield(event)
                            if case .ready = event { break }
                            if case .failed = event { break }
                        }
                    }
                } catch {
                    // network error → end the stream
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func verifyCustomDomain(_ req: VerifyCustomDomainRequest) async throws -> VerifyCustomDomainResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/url-controller/verify", method: "POST", body: body)
    }

    public func postRecoveryStatus() async throws -> PostRecoveryStatusResponse {
        try await request("/api/screens/post-recovery/status")
    }

    public func serviceEnvList(appId: String) async throws -> ServiceEnvListResponse {
        try await request("/api/screens/services/\(appId)/env")
    }
    public func serviceEnvSet(appId: String, _ req: ServiceEnvSetRequest) async throws -> ServiceEnvOpResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/\(appId)/env/set", method: "POST", body: body)
    }
    public func serviceEnvUnset(appId: String, _ req: ServiceEnvUnsetRequest) async throws -> ServiceEnvOpResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/\(appId)/env/unset", method: "POST", body: body)
    }
    public func vibeCodeSessionState(sessionId: String) async throws -> VibeCodeSessionPublicState {
        try await request("/api/screens/llm/sessions/\(sessionId)")
    }
    public func vibeCodeSessionReply(sessionId: String, _ req: VibeCodeReplyRequest) async throws -> VibeCodeReplyResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/llm/sessions/\(sessionId)/reply", method: "POST", body: body)
    }

    public func peerBackupStatus() async throws -> PeerBackupStatusResponse {
        try await request("/api/screens/peer-backup/status")
    }
    public func peerBackupToggle(participate: Bool) async throws -> PeerBackupStatusResponse {
        let body = try JSONEncoder().encode(PeerBackupToggleRequest(participate: participate))
        return try await request("/api/screens/peer-backup/toggle", method: "POST", body: body)
    }

    public func appInviteIssue(_ req: AppInviteIssueRequest) async throws -> AppInviteIssueResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/app-invite/issue", method: "POST", body: body)
    }
    public func appInviteList(serviceId: String) async throws -> AppInviteListResponse {
        let escaped = serviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceId
        return try await request("/api/screens/app-invite/list/\(escaped)")
    }
    public func appInviteAccess(serviceId: String) async throws -> AppInviteAccessResponse {
        let escaped = serviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serviceId
        return try await request("/api/screens/app-invite/access/\(escaped)")
    }
    public func appInviteRevoke(_ req: AppInviteRevokeRequest) async throws -> AppInviteRevokeResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/app-invite/revoke", method: "POST", body: body)
    }

    /// WebSocket stream of vibe-code frames. The daemon currently
    /// stubs this to a poll-driven proxy; we model the SDK-level
    /// API as a true AsyncStream so the UI doesn't care.
    public func vibeCodeStream(sessionId: String) -> AsyncStream<VibeCodeFrame> {
        AsyncStream { continuation in
            let task = Task { [self] in
                guard let base = await store.podBaseUrl,
                      let token = await store.sessionToken,
                      var comps = URLComponents(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/screens/vibe-code/\(sessionId)/stream")
                else {
                    continuation.finish()
                    return
                }
                comps.scheme = comps.scheme?.hasSuffix("s") == true ? "wss" : "ws"
                guard let url = comps.url else {
                    continuation.finish()
                    return
                }
                var req = URLRequest(url: url)
                req.setValue(token, forHTTPHeaderField: "x-flagship-session")
                let ws = urlSession.webSocketTask(with: req)
                ws.resume()
                while !Task.isCancelled {
                    do {
                        let msg = try await ws.receive()
                        let data: Data
                        switch msg {
                        case .data(let d): data = d
                        case .string(let s): data = Data(s.utf8)
                        @unknown default: continue
                        }
                        if let frame = try? JSONDecoder().decode(VibeCodeFrame.self, from: data) {
                            continuation.yield(frame)
                            if case .done = frame { break }
                            if case .error = frame { break }
                        }
                    } catch {
                        break
                    }
                }
                ws.cancel(with: .normalClosure, reason: nil)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - P14 companion-dock

    public func companionMintTicket(_ req: CompanionMintTicketRequest) async throws -> CompanionMintTicketResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/companion/mint-ticket", method: "POST", body: body)
    }
    public func companionList() async throws -> CompanionListResponse {
        try await request("/api/screens/companion/list")
    }
    public func companionRevoke(_ req: CompanionRevokeRequest) async throws -> CompanionRevokeResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/companion/revoke", method: "POST", body: body)
    }

    // MARK: - P8 browser-tab framebuffer stream

    public func browserTabStream(tabId: String) -> any BrowserStream {
        let stream = LiveBrowserStream(
            urlSession: urlSession,
            store: store,
            tabId: tabId
        )
        stream.start()
        return stream
    }
}

/// URLSessionWebSocketTask-backed implementation. Reconnects up to
/// `maxReconnects` times with exponential backoff on transient close.
/// Phase 1: backoff tuning + finer error surfaces are TODO.
public final class LiveBrowserStream: BrowserStream, @unchecked Sendable {
    public let incoming: AsyncStream<BrowserFrame>
    private let continuation: AsyncStream<BrowserFrame>.Continuation
    private let urlSession: URLSession
    private let store: any SessionStoring
    private let tabId: String
    private var task: URLSessionWebSocketTask?
    private var driver: Task<Void, Never>?
    private var closed = false
    private let lock = NSLock()
    private let maxReconnects = 3

    public init(urlSession: URLSession, store: any SessionStoring, tabId: String) {
        self.urlSession = urlSession
        self.store = store
        self.tabId = tabId
        var c: AsyncStream<BrowserFrame>.Continuation!
        self.incoming = AsyncStream { c = $0 }
        self.continuation = c
    }

    public func start() {
        driver = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled, !self.isClosed(), attempt <= self.maxReconnects {
                let ok = await self.runOnce()
                if ok { break }
                attempt += 1
                if attempt > self.maxReconnects { break }
                let backoffMs: UInt64 = UInt64(min(8000, 250 * (1 << attempt)))
                try? await Task.sleep(nanoseconds: backoffMs * 1_000_000)
            }
            self.continuation.finish()
        }
    }

    private func isClosed() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return closed
    }

    private func runOnce() async -> Bool {
        guard let base = await store.podBaseUrl,
              let token = await store.sessionToken else { return true }
        let wsBase = base
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let encodedToken = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        let encodedTabId = tabId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tabId
        let urlStr = "\(wsBase)/api/screens/browser-tabs/\(encodedTabId)/stream?sessionToken=\(encodedToken)"
        guard let url = URL(string: urlStr) else { return true }
        let ws = urlSession.webSocketTask(with: url)
        lock.lock(); self.task = ws; lock.unlock()
        ws.resume()
        var sawAnyFrame = false
        while !Task.isCancelled, !self.isClosed() {
            do {
                let msg = try await ws.receive()
                let data: Data
                switch msg {
                case .data(let d): data = d
                case .string(let s): data = Data(s.utf8)
                @unknown default: continue
                }
                if let frame = BrowserFrame.decode(data) {
                    continuation.yield(frame)
                    sawAnyFrame = true
                }
            } catch {
                ws.cancel(with: .abnormalClosure, reason: nil)
                // Either way we want to retry — keep reconnecting on
                // transient drops. The driver caps the attempts.
                _ = sawAnyFrame
                return false
            }
        }
        ws.cancel(with: .normalClosure, reason: nil)
        return true
    }

    public func send(_ input: BrowserInput) async {
        lock.lock(); let ws = task; let isClosed = closed; lock.unlock()
        guard !isClosed, let ws else { return }
        do {
            // Webapp dispatches text frames (JSON.stringify(...) →
            // WebSocket.send(text)); daemon's `ws.on('message')` receives
            // a UTF-8 string. Mirror that wire encoding so the daemon
            // parser path is identical.
            let data = try input.encode()
            let text = String(data: data, encoding: .utf8) ?? "{}"
            try await ws.send(.string(text))
        } catch {
            // Transient WS failure — the driver loop will detect a
            // closed socket on its next `receive()` and trigger the
            // reconnect path.
        }
    }

    public func close() {
        lock.lock()
        closed = true
        let ws = task
        lock.unlock()
        ws?.cancel(with: .normalClosure, reason: nil)
        driver?.cancel()
        continuation.finish()
    }
}

private struct EmptyResponse: Decodable {}
