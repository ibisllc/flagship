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
    private let dnsRetryDelays: [TimeInterval]
    private let sleep: @Sendable (TimeInterval) async -> Void

    /// `dnsRetryDelays`: when the box's name doesn't resolve (a home router that
    /// cached "no such name" from a lookup made before the box registered),
    /// the request is tried again after each delay before it fails.
    public init(
        urlSession: URLSession = .shared,
        store: any SessionStoring,
        dnsRetryDelays: [TimeInterval] = [0.5, 1.5, 3],
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    ) {
        self.urlSession = urlSession
        self.store = store
        self.dnsRetryDelays = dnsRetryDelays
        self.sleep = sleep
    }

    /// True when the box's name could not be looked up at all: the request
    /// never left the phone, so asking again can't repeat a change.
    public static func isNameLookupFailure(_ error: Error) -> Bool {
        guard let u = error as? URLError else { return false }
        return u.code == .cannotFindHost || u.code == .dnsLookupFailed
    }

    /// `sendPreferringLan`, trying again with a short backoff while the name
    /// won't resolve; other failures pass straight through.
    private func sendWithNameRetry(_ req: URLRequest, host: String?) async throws -> (Data, URLResponse) {
        var attempt = 0
        var triedRelay = false
        while true {
            do {
                return try await sendPreferringLan(req, host: host)
            } catch {
                guard Self.isNameLookupFailure(error), !Task.isCancelled else { throw error }
                // The name won't resolve: ask the relay for it directly (docs/relay-addresses.md).
                // A hint: if it fails, in any way, the name is simply still unresolved.
                if !triedRelay, let host {
                    triedRelay = true
                    if let hinted = try await sendViaRelay(req, host: host) { return hinted }
                }
                guard attempt < dnsRetryDelays.count else { throw error }
                await sleep(dnsRetryDelays[attempt])
                attempt += 1
            }
        }
    }

    /// The request through the relay's addresses, or nil when that is not possible or did not
    /// work. A pin or certificate failure on this route says nothing about the box, so it is
    /// not recorded as one; a failure that may have reached the box is thrown, not replayed.
    private func sendViaRelay(_ req: URLRequest, host: String) async throws -> (Data, URLResponse)? {
        #if canImport(Network)
        guard let relay = await RelayRoute.shared.session(for: host) else { return nil }
        do {
            return try await relay.gatedData(for: req)
        } catch {
            if Task.isCancelled { throw error }
            // The calm outcome stays (the name is still unresolved), but the real class is kept.
            let pinMismatch = CertPinMismatchSink.shared.consumeRecentMismatch(host: host)
            DiagnosticsLog.shared.record(
                code: pinMismatch ? DiagnosticCode.relayPinMismatch : DiagnosticCode.relayRouteUnverified,
                host: host, detail: DiagnosticCode.of(error))
            guard LanDirectRegistry.mayResendOverRelay(error, method: req.httpMethod) else { throw error }
            return nil
        }
        #else
        return nil
        #endif
    }

    /// LAN-direct (docs/lan-direct.md): use the box's local listener when a
    /// probe has proven the box is on this network, else the relay. Any
    /// failure on the LAN route stops LAN use on this network; the request
    /// goes again over the relay unless it may already have changed something.
    private func sendPreferringLan(_ req: URLRequest, host: String?) async throws -> (Data, URLResponse) {
        #if canImport(Network)
        if let host, let lan = LanDirectRegistry.shared.session(for: host) {
            do {
                return try await lan.gatedData(for: req)
            } catch {
                if Task.isCancelled { throw error }
                // A pin mismatch here means some other device holds that LAN
                // address — not an interception of the relay path.
                let otherDevice = CertPinMismatchSink.shared.consumeRecentMismatch(host: host)
                LanDirectRegistry.shared.markFailed(host: host, why: otherDevice ? "another device answered" : "\((error as NSError).domain) \((error as NSError).code)")
                guard otherDevice || LanDirectRegistry.mayResendOverRelay(error, method: req.httpMethod) else { throw error }
            }
        }
        #endif
        return try await urlSession.gatedData(for: req)
    }

    /// The box's STK-signed LAN hint, or nil (204: it has none to offer).
    public func lanHint() async throws -> LanHint.Envelope? {
        guard let base = await store.podBaseUrl else { throw ScreensClientError.notPaired }
        guard let token = await store.sessionToken else { throw ScreensClientError.noSessionToken }
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/screens/lan-hint") else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "x-flagship-session")
        let (data, resp) = try await urlSession.gatedData(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try JSONDecoder().decode(LanHint.Envelope.self, from: data)
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
                                       timeout: TimeInterval? = nil) async throws -> T {
        let data = try await requestData(path, method: method, body: body, timeout: timeout)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ScreensClientError.decoding(String(describing: error))
        }
    }

    /// The raw 2xx body (non-2xx throws `.http` with the body text).
    private func requestData(_ path: String, method: String = "GET", body: Data? = nil,
                             timeout: TimeInterval? = nil, contentType: String = "application/json") async throws -> Data {
        guard let base = await store.podBaseUrl else { throw ScreensClientError.notPaired }
        guard let token = await store.sessionToken else { throw ScreensClientError.noSessionToken }
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw ScreensClientError.http(status: 0, message: "bad URL")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        req.setValue(token, forHTTPHeaderField: "x-flagship-session")
        if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "content-type")
        }

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await sendWithNameRetry(req, host: url.host)
        } catch {
            // UX-A — a hard-fail pin mismatch surfaces here as a generic
            // transport error (the delegate cancelled the auth challenge).
            // If the pinning delegate just flagged this host, report the
            // distinct "someone may be intercepting" error.
            if let host = url.host,
               CertPinMismatchSink.shared.consumeRecentMismatch(host: host) {
                throw ScreensClientError.certPinMismatch(host: host)
            }
            throw error
        }
        guard let http = resp as? HTTPURLResponse else {
            throw ScreensClientError.http(status: 0, message: "no response")
        }
        if !(200..<300).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ScreensClientError.http(status: http.statusCode, message: text)
        }
        return data
    }

    public func serverDetail() async throws -> ServerDetailResponse {
        try await request("/api/screens/server-detail")
    }
    public func serverUpdates(refresh: Bool) async throws -> ReleaseCatalogResponse {
        try await request(refresh ? "/api/screens/updates?refresh=1" : "/api/screens/updates")
    }
    public func appsList() async throws -> AppsListResponse {
        try await request("/api/screens/apps-list")
    }
    public func appDetail(serviceId: String) async throws -> AppDetailResponse {
        try await request("/api/screens/app-detail/\(serviceId)")
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
    public func appBackupFetch(fetchPath: String) async throws -> Data {
        guard fetchPath.hasPrefix("/api/backups/") else {
            throw ScreensClientError.http(status: 0, message: "unexpected backup path")
        }
        return try await requestData(fetchPath, timeout: 300)
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
                    let (bytes, _) = try await urlSession.gatedBytes(for: req)
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
    public func aiModels(_ req: AiModelsRequest) async throws -> AiModelsResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/ai/models", method: "POST", body: body)
    }
    public func vibeCodeDeploy(sessionId: String) async throws -> BuildDeployResponse {
        // The scratch deploy trigger is the daemon's legacy
        // `/api/llm/sessions/<id>/deploy` (paired-session gated, same
        // `x-flagship-session` auth the `request` helper applies) — the screens
        // BFF has no deploy route, and the WS stream is a pure relay. The vibe
        // session registry is shared between the screens-BFF start and this
        // legacy handler, so a session started via /api/screens/vibe-code/start
        // is deployable here. The box answers only once `docker build` and the
        // install finish, which takes minutes, not the default 60 s.
        return try await request("/api/llm/sessions/\(sessionId)/deploy", method: "POST", body: Data("{}".utf8),
                                 timeout: 15 * 60)
    }
    public func vibeCodeDeployStart(sessionId: String) async throws -> VibeCodeDeployReply {
        try await vibeCodeDeployStart(sessionId: sessionId, credential: nil)
    }
    public func vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?) async throws -> VibeCodeDeployReply {
        // An older box ignores `background` and answers once the app is live.
        let body = try JSONEncoder().encode(VibeCodeDeployRequest(background: true, credential: credential))
        return try await request("/api/llm/sessions/\(sessionId)/deploy", method: "POST",
                                 body: body, timeout: 15 * 60)
    }
    public func serviceEgressSet(serviceId: String, _ req: AppEgressSetRequest) async throws -> AppEgressSetResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/\(esc(serviceId))/egress", method: "POST", body: body)
    }

    public func boxDomain() async -> String? {
        guard let base = await store.podBaseUrl else { return nil }
        return URL(string: base)?.host?.lowercased()
    }
    public func serviceAccess(serviceId: String) async throws -> AppAccessState {
        try await request("/api/screens/services/\(esc(serviceId))/access")
    }
    public func serviceAccessSet(serviceId: String, _ req: AppAccessSetRequest) async throws -> AppAccessSetResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/\(esc(serviceId))/access", method: "POST", body: body)
    }
    @discardableResult
    public func serviceAccessDismiss(serviceId: String, host: String) async throws -> AppAccessState? {
        let body = try JSONSerialization.data(withJSONObject: ["host": host])
        let r: AppAccessSetResponse = try await request("/api/screens/services/\(esc(serviceId))/access/dismiss",
                                                        method: "POST", body: body)
        return r.access
    }
    @discardableResult
    public func serviceAccessDraftDismiss(serviceId: String) async throws -> AppAccessState? {
        let r: AppAccessSetResponse = try await request(
            "/api/screens/services/\(esc(serviceId))/access/draft/dismiss", method: "POST", body: Data("{}".utf8))
        return r.access
    }
    public func accessRequests() async throws -> AppAccessRequestsResponse {
        try await request("/api/screens/access-requests")
    }

    private func dbPath(_ serviceId: String, _ rest: String = "") -> String {
        "/api/screens/services/\(segment(serviceId))/db\(rest)"
    }
    public func serviceDb(serviceId: String) async throws -> AppDbStoresResponse {
        try await request(dbPath(serviceId))
    }
    public func serviceDbTableRows(serviceId: String, store: String, table: String,
                                   offset: Int, limit: Int) async throws -> AppDbTableRows {
        try await request(dbPath(serviceId, "/\(segment(store))/tables/\(segment(table))?offset=\(max(0, offset))&limit=\(max(1, limit))"),
                          timeout: 30)
    }
    public func serviceDbExportCsv(serviceId: String, store: String, table: String) async throws -> Data {
        try await requestData(dbPath(serviceId, "/\(segment(store))/tables/\(segment(table))/export.csv"), timeout: 120)
    }
    public func serviceDbQuery(serviceId: String, store: String, _ req: AppDbQueryRequest) async throws -> AppDbQueryResult {
        let body = try JSONEncoder().encode(req)
        return try await request(dbPath(serviceId, "/\(segment(store))/query"), method: "POST", body: body, timeout: 30)
    }
    public func appMembers(serviceId: String) async throws -> AppMembersResponse {
        try await request("/api/screens/services/\(segment(serviceId))/members")
    }
    public func setAppRank(serviceId: String, _ req: AppRankRequest) async throws -> AppRankResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/\(segment(serviceId))/members/rank", method: "POST", body: body)
    }
    @discardableResult
    public func deliverServerOrder(_ order: SignedServerOrderWire) async throws -> ServerOrderAck {
        try await request("/api/screens/server-order", method: "POST", body: try JSONEncoder().encode(order))
    }
    public func securitySliver() async throws -> SecuritySliverResponse {
        try await request("/api/screens/security-sliver")
    }
    public func publisherState(serviceId: String) async throws -> WaitingPublisherResponse {
        try await request("/api/screens/services/\(Self.pathSegment(serviceId))/publisher")
    }
    public func trustPublisher(serviceId: String, trust: PublisherTrust, signatureHex: String) async throws {
        struct Body: Encodable { let trust: PublisherTrust; let signatureHex: String }
        _ = try await requestData("/api/screens/services/\(Self.pathSegment(serviceId))/publisher/trust", method: "POST", body: try JSONEncoder().encode(Body(trust: trust, signatureHex: signatureHex)))
    }
    public func rejectPublisher(serviceId: String) async throws {
        _ = try await requestData("/api/screens/services/\(Self.pathSegment(serviceId))/publisher/reject", method: "POST", body: Data("{}".utf8))
    }
    public func restoredAccessDrafts() async throws -> RestoredAccessList {
        try await request("/api/screens/restored-access")
    }
    public func approveRestoredAccess(request: [String: Any], signatureHex: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["request": request, "signature": signatureHex])
        _ = try await requestData("/api/service-access/restored", method: "POST", body: body)
    }
    public func discardRestoredAccess(serviceRef: String) async throws {
        _ = try await requestData("/api/screens/restored-access/discard", method: "POST", body: try JSONSerialization.data(withJSONObject: ["serviceRef": serviceRef]))
    }
    public func updateMode(serviceId: String) async throws -> UpdateModeState {
        try await request("/api/screens/services/\(Self.pathSegment(serviceId))/update-mode")
    }
    public func setUpdateMode(serviceId: String, mode: String) async throws {
        _ = try await requestData("/api/screens/services/\(Self.pathSegment(serviceId))/update-mode", method: "POST", body: try JSONSerialization.data(withJSONObject: ["mode": mode]))
    }
    public func companionDelegations(sessionId: String) async throws -> CompanionDelegationList {
        try await request("/api/screens/companion-delegation?sessionId=\(sessionId)")
    }
    public func allowCompanionBuild(request: [String: Any], signatureHex: String) async throws {
        _ = try await requestData("/api/screens/companion-delegation", method: "POST", body: try JSONSerialization.data(withJSONObject: ["delegation": request, "signature": signatureHex]))
    }
    public func endCompanionDelegation(sessionId: String, serviceRef: String) async throws {
        _ = try await requestData("/api/screens/companion-delegation", method: "DELETE", body: try JSONSerialization.data(withJSONObject: ["sessionId": sessionId, "serviceRef": serviceRef]))
    }
    public func servicePermissions(serviceId: String) async throws -> ServicePermissions {
        try await request("/api/screens/services/\(Self.pathSegment(serviceId))/permissions")
    }
    public func revokeServicePermission(serviceId: String, grantId: String?) async throws -> PermissionRevokeResult {
        struct Body: Encodable { let grantId: String? }
        return try await request("/api/screens/services/\(Self.pathSegment(serviceId))/permissions/revoke", method: "POST", body: try JSONEncoder().encode(Body(grantId: grantId)))
    }
    public func debugAccessGrant(body: String) async throws -> DebugAccessChange {
        try await request("/api/screens/debug-access", method: "POST", body: Data(body.utf8))
    }
    public func debugAccessRevoke(body: String) async throws -> DebugAccessChange {
        try await request("/api/screens/debug-access/revoke", method: "POST", body: Data(body.utf8))
    }
    public func accessAlertsSetting() async throws -> AccessAlertsSetting {
        try await request("/api/screens/settings/access-alerts")
    }
    @discardableResult
    public func setAccessAlerts(enabled: Bool) async throws -> AccessAlertsSetting {
        let body = try JSONSerialization.data(withJSONObject: ["enabled": enabled])
        return try await request("/api/screens/settings/access-alerts", method: "POST", body: body)
    }
    public func serviceApiKeys(serviceId: String) async throws -> AppApiKeysResponse {
        try await request("/api/screens/services/\(esc(serviceId))/api-keys")
    }
    public func serviceCopy(_ req: AppCopyRequest) async throws -> AppCopyStartResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/copy", method: "POST", body: body, timeout: 30)
    }
    public func serviceCopies() async throws -> AppCopiesResponse {
        try await request("/api/screens/services/copies")
    }
    public func serverArchiveStart(_ req: ServerArchiveStartRequest) async throws {
        _ = try await requestData("/api/screens/server-archive/start", method: "POST", body: try JSONEncoder().encode(req), timeout: 30)
    }
    public func serverArchiveStatus() async throws -> ServerArchiveStatus? {
        let r: ServerArchiveStatusResponse = try await request("/api/screens/server-archive")
        return r.archive
    }
    public func serverArchiveChunk(offset: Int64) async throws -> Data {
        try await requestData("/api/screens/server-archive/chunk?offset=\(offset)", timeout: 300)
    }
    public func serverArchiveBackupFile() async throws -> Data {
        try await requestData("/api/screens/server-archive/backup-file", timeout: 60)
    }
    public func serverArchiveBundle(_ route: ServerArchiveRoute, offset: Int64) async throws -> Data {
        try await requestData("\(route.base)/bundle?offset=\(offset)", timeout: 300)
    }
    public func savedBackups() async throws -> SavedBackupsView {
        try await request("/api/screens/server-archive/backups")
    }
    public func savedBackupsSetSchedule(_ schedule: BackupSchedule) async throws -> SavedBackupsView {
        try await request("/api/screens/server-archive/backups/schedule", method: "PUT", body: try JSONEncoder().encode(schedule))
    }
    public func savedBackupsDepositKeys(_ req: ArchiveKeysDepositRequest) async throws -> SavedBackupsView {
        try await request("/api/screens/server-archive/backups/keys", method: "POST", body: try JSONEncoder().encode(req), timeout: 60)
    }
    public func savedBackupsRun() async throws -> SavedBackupRunResponse {
        try await request("/api/screens/server-archive/backups/run", method: "POST", body: Data("{}".utf8), timeout: 30)
    }
    public func savedBackupDelete(archiveId: String) async throws -> SavedBackupsView {
        try await request("/api/screens/server-archive/backups/\(esc(archiveId))", method: "DELETE", timeout: 30)
    }
    public func backupPolicy() async throws -> BackupPolicyView {
        try await request("/api/screens/backup-policy")
    }
    public func setBackupPolicy(_ req: BackupPolicyRequest) async throws -> BackupPolicyView {
        try await request("/api/screens/backup-policy", method: "POST", body: try JSONEncoder().encode(req), timeout: 30)
    }
    public func serverArchiveForget() async throws {
        _ = try await requestData("/api/screens/server-archive", method: "DELETE", timeout: 30)
    }
    public func serverArchiveApprove(_ req: ServerArchiveApproveRequest) async throws {
        _ = try await requestData("/api/screens/server-archive/approve", method: "POST", body: try JSONEncoder().encode(req), timeout: 30)
    }
    public func serverRestoreStart(_ req: ServerRestoreStartRequest) async throws -> ServerRestoreStartResponse {
        try await request("/api/screens/server-restore/start", method: "POST", body: try JSONEncoder().encode(req))
    }
    public func serverRestoreChunk(offset: Int64, data: Data) async throws {
        _ = try await requestData("/api/screens/server-restore/chunk?offset=\(offset)", method: "POST", body: data, timeout: 300,
                                  contentType: "application/octet-stream")
    }
    public func serverRestoreCommit(_ req: ServerRestoreCommitRequest) async throws {
        _ = try await requestData("/api/screens/server-restore/commit", method: "POST", body: try JSONEncoder().encode(req), timeout: 60)
    }
    public func serverRestoreStatus() async throws -> ServerRestoreStatusResponse {
        try await request("/api/screens/server-restore")
    }
    public func boxActivity(limit: Int, before: Int?) async throws -> [BoxActivityEntry] {
        var path = "/api/screens/activity?limit=\(limit)"
        if let before { path += "&before=\(before)" }
        let r: BoxActivityResponse = try await request(path)
        return r.entries
    }
    public func serviceApiKeyCreate(serviceId: String, _ req: AppApiKeyCreateRequest) async throws -> AppApiKeyCreateResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/services/\(esc(serviceId))/api-keys", method: "POST", body: body)
    }
    public func serviceApiKeyRevoke(serviceId: String, keyId: String) async throws {
        do {
            let _: EmptyResponse = try await request(
                "/api/screens/services/\(esc(serviceId))/api-keys/\(esc(keyId))", method: "DELETE")
        } catch ScreensClientError.decoding {
            // A 2xx with no JSON body (e.g. 204) still revoked the key.
        }
    }
    public func accessRequestEvents() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let task = Task { [self] in
                guard let base = await store.podBaseUrl,
                      let token = await store.sessionToken,
                      var comps = URLComponents(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/screens/events")
                else { continuation.finish(); return }
                comps.scheme = comps.scheme?.hasSuffix("s") == true ? "wss" : "ws"
                comps.queryItems = [URLQueryItem(name: "sessionToken", value: token)]
                guard let url = comps.url else { continuation.finish(); return }
                var req = URLRequest(url: url)
                req.setValue(token, forHTTPHeaderField: "x-flagship-session")
                guard let ws = try? urlSession.gatedWebSocketTask(with: req) else { continuation.finish(); return }
                ws.resume()
                while !Task.isCancelled {
                    guard let msg = try? await ws.receive() else { break }
                    let data: Data
                    switch msg {
                    case .data(let d): data = d
                    case .string(let str): data = Data(str.utf8)
                    @unknown default: continue
                    }
                    if AppAccessEvents.isRequestFrame(data) { continuation.yield(()) }
                }
                ws.cancel(with: .normalClosure, reason: nil)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func peerBackupStatus() async throws -> PeerBackupStatusResponse {
        try await request("/api/screens/peer-backup/status")
    }
    public func peerBackupRoot(_ req: PeerRestoreRequest) async throws -> PeerRootSummary {
        try await request("/api/screens/peer-backup/root", method: "POST", body: try JSONEncoder().encode(req))
    }
    public func serverRestoreFromPeers(_ req: PeerRestoreRequest) async throws {
        _ = try await requestData("/api/screens/server-restore/from-peers", method: "POST", body: try JSONEncoder().encode(req), timeout: 60)
    }
    public func peerBackupToggle(participate: Bool) async throws -> PeerBackupStatusResponse {
        let body = try JSONEncoder().encode(PeerBackupToggleRequest(participate: participate))
        return try await request("/api/screens/peer-backup/toggle", method: "POST", body: body)
    }

    /// WebSocket stream of vibe-code frames. The daemon currently
    /// stubs this to a poll-driven proxy; we model the SDK-level
    /// API as a true AsyncStream so the UI doesn't care.
    public func vibeCodeStream(sessionId: String) -> AsyncStream<VibeCodeFrame> {
        AsyncStream { continuation in
            let task = Task { [self] in
                var sawTerminal = false
                // Surface a synthetic error when the stream ends WITHOUT a
                // terminal frame from the daemon. Connect / decode / transport
                // failures previously finished silently, leaving the Building
                // screen stuck on "…" with no error card ever shown.
                func finish(incomplete reason: String?) {
                    if let reason, !sawTerminal {
                        continuation.yield(.error(message: reason))
                    }
                    continuation.finish()
                }
                guard let base = await store.podBaseUrl,
                      let token = await store.sessionToken,
                      var comps = URLComponents(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/screens/vibe-code/\(sessionId)/stream")
                else {
                    finish(incomplete: "Couldn't reach the server to load this build.")
                    return
                }
                comps.scheme = comps.scheme?.hasSuffix("s") == true ? "wss" : "ws"
                guard let url = comps.url else {
                    finish(incomplete: "Couldn't reach the server to load this build.")
                    return
                }
                var req = URLRequest(url: url)
                req.setValue(token, forHTTPHeaderField: "x-flagship-session")
                guard let ws = try? urlSession.gatedWebSocketTask(with: req) else {
                    finish(incomplete: UpdateRequiredError.sentence)
                    return
                }
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
                        if AppAccessEvents.isRequestFrame(data) {
                            AppAccessEvents.post()
                            continue
                        }
                        if let frame = try? JSONDecoder().decode(VibeCodeFrame.self, from: data) {
                            continuation.yield(frame)
                            if case .done = frame { sawTerminal = true; break }
                            if case .error = frame { sawTerminal = true; break }
                        }
                    } catch {
                        break
                    }
                }
                ws.cancel(with: .normalClosure, reason: nil)
                // A user-initiated cancel (screen popped) is not an error; a
                // drop before any terminal frame is.
                finish(incomplete: Task.isCancelled ? nil : "Lost connection to the server before the build finished.")
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

    // MARK: - P14 Phase 2 companion write-relay (owner queue)

    public func companionPendingWrites() async throws -> CompanionPendingWritesResponse {
        try await request("/api/screens/companion/pending-writes")
    }

    public func companionResolvePending(_ req: CompanionResolvePendingRequest) async throws -> CompanionResolvePendingResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/screens/companion/resolve-pending", method: "POST", body: body)
    }

    // MARK: - Build-a-service modes (/api/build/*)
    //
    // These hang off the daemon root, NOT /api/screens — same paired
    // `x-flagship-session` auth the `request` helper already applies.

    public func buildGit(_ req: BuildGitRequest) async throws -> BuildGitResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/build/git", method: "POST", body: body)
    }
    public func buildAdapt(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/build/sessions/\(esc(buildId))/adapt", method: "POST", body: body)
    }
    public func buildMcpCreate(_ req: BuildMcpRequest) async throws -> BuildMcpResponse {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/build/mcp", method: "POST", body: body)
    }
    public func buildMcpInfo(buildId: String) async throws -> BuildMcpConnection {
        try await request("/api/build/sessions/\(esc(buildId))/mcp")
    }
    public func buildMcpRotate(buildId: String, _ req: BuildMcpRequest) async throws -> BuildMcpConnection {
        let body = try JSONEncoder().encode(req)
        return try await request("/api/build/sessions/\(esc(buildId))/mcp/rotate", method: "POST", body: body)
    }
    public func buildEnvRequests(buildId: String) async throws -> BuildEnvRequestsResponse {
        try await request("/api/build/sessions/\(esc(buildId))/env-requests")
    }
    public func buildAdaptStart(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptReply {
        // An older box ignores `background` and answers when the AI is done.
        let body = try JSONEncoder().encode(req)
        return try await request("/api/build/sessions/\(esc(buildId))/adapt", method: "POST", body: body,
                                 timeout: 30 * 60)
    }
    public func buildState(buildId: String) async throws -> BuildStateResponse {
        try await request("/api/build/sessions/\(esc(buildId))")
    }
    public func adapterReport(serviceId: String, detail: String) async throws {
        struct Ok: Decodable { let ok: Bool }
        let body = try JSONEncoder().encode(["detail": detail])
        let _: Ok = try await request("/api/screens/adapter-report/\(esc(serviceId))", method: "POST", body: body)
    }
    public func buildAdapterFile(buildId: String) async throws -> String {
        struct File: Decodable { let file: String }
        let r: File = try await request("/api/build/sessions/\(esc(buildId))/adapter")
        return r.file
    }
    public func buildDiscard(buildId: String) async throws {
        struct Ok: Decodable { let ok: Bool }
        let _: Ok = try await request("/api/build/sessions/\(esc(buildId))/discard", method: "POST", body: Data("{}".utf8))
    }
    public func buildDeploy(buildId: String) async throws -> BuildDeployResponse {
        // Answers once `docker build` and the install finish: minutes.
        try await request("/api/build/sessions/\(esc(buildId))/deploy", method: "POST", body: Data("{}".utf8),
                          timeout: 15 * 60)
    }
    /// The daemon's live vibe-code sessions (legacy `/api/llm/sessions`, same
    /// paired-session auth as the deploy trigger).
    public func vibeCodeSessions() async throws -> VibeCodeSessionsResponse {
        try await request("/api/llm/sessions")
    }
    public func vibeCodeNameCheck(name: String) async throws -> VibeCodeNameCheck {
        let q = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? name
        do {
            return try await request("/api/screens/vibe-code/name-check?name=\(q)")
        } catch ScreensClientError.http(status: 404, _) {
            return .unknown
        }
    }
    public func vibeCodeDiscard(sessionId: String) async throws {
        struct Ok: Decodable { let ok: Bool }
        let _: Ok = try await request("/api/llm/sessions/\(esc(sessionId))/discard", method: "POST", body: Data("{}".utf8))
    }
    public func buildSessions() async throws -> BuildSessionsResponse {
        try await request("/api/build/sessions")
    }
    public func buildJournal(buildId: String) async throws -> BuildJournalResponse {
        try await request("/api/build/sessions/\(esc(buildId))/journal")
    }

    private func esc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    /// One path segment: everything but unreserved characters is escaped (a
    /// table name may hold `/`, `?` or `#`).
    private func segment(_ s: String) -> String {
        Self.pathSegment(s)
    }

    static func pathSegment(_ s: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
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
        let encodedTabId = tabId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tabId
        // The session rides in a header, never in the URL (N06): URLs end up in proxies and logs.
        guard let url = URL(string: "\(wsBase)/api/screens/browser-tabs/\(encodedTabId)/stream") else { return true }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "x-flagship-session")
        guard let ws = try? urlSession.gatedWebSocketTask(with: req) else { return true }
        lock.withLock { self.task = ws }
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
        let (ws, isClosed) = lock.withLock { (task, closed) }
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
