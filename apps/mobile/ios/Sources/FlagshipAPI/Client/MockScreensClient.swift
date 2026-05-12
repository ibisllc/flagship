import Foundation

/// In-memory fixture data for the dev cycle. Every method returns
/// deterministic, plausible data so the entire UI can be exercised
/// without a paired pod.
///
/// To simulate latency or failure, pass a non-zero `simulatedLatency`
/// or set `shouldFail = true` before a call.
public final class MockScreensClient: ScreensClient, @unchecked Sendable {
    public var simulatedLatency: TimeInterval = 0.18
    public var shouldFail: Bool = false

    public init() {}

    private func tick() async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        if shouldFail {
            throw ScreensClientError.http(status: 503, message: "simulated failure")
        }
    }

    // MARK: - P1.1 server-detail

    public func serverDetail() async throws -> ServerDetailResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let oneDay: Int64 = 24 * 3600 * 1000
        return ServerDetailResponse(
            serverFqdn: "home.harry.flagship.services",
            username: "harry",
            daemonVersion: "0.18.4",
            startedAt: now - 11 * oneDay,
            uptimeMs: 11 * oneDay,
            certNotAfter: now + 67 * oneDay,
            certNotBefore: now - 23 * oneDay,
            certSans: ["home.harry.flagship.services", "*.home.harry.flagship.services"],
            appCount: 3,
            pairedSessionCount: 2,
            recentInstallEvents: [
                RecentInstallEvent(at: now - 60_000 * 30, kind: "installed", appId: "plants", detail: "via vibe-code"),
                RecentInstallEvent(at: now - 60_000 * 60 * 6, kind: "deploy", appId: "wiki", detail: "v1.4.0"),
                RecentInstallEvent(at: now - 60_000 * 60 * 26, kind: "installed", appId: "wiki", detail: "marketplace"),
            ]
        )
    }

    // MARK: - P1.2 apps-list

    public func appsList() async throws -> AppsListResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return AppsListResponse(apps: [
            AppSummary(
                appId: "plants",
                creator: "harry",
                slug: "plants",
                urlLabel: "plants.harry.flagship.services",
                summary: "Houseplant watering tracker",
                url: "https://plants.harry.flagship.services/",
                status: "running",
                version: "0.0.3",
                installedAt: now - 60_000 * 30
            ),
            AppSummary(
                appId: "wiki",
                creator: "harry",
                slug: "wiki",
                urlLabel: "wiki.harry.flagship.services",
                summary: "Personal notes + recipes",
                url: "https://wiki.harry.flagship.services/",
                status: "running",
                version: "1.4.0",
                installedAt: now - 60_000 * 60 * 26
            ),
            AppSummary(
                appId: "pad",
                creator: "trent",
                slug: "scratchpad",
                urlLabel: "pad.harry.flagship.services",
                summary: "Markdown scratchpad",
                url: "https://pad.harry.flagship.services/",
                status: "stopped",
                version: "0.7.1",
                installedAt: now - 60_000 * 60 * 24 * 12
            )
        ])
    }

    // MARK: - P1.3 app-detail

    public func appDetail(appId: String) async throws -> AppDetailResponse {
        try await tick()
        let list = try await appsList()
        guard let app = list.apps.first(where: { $0.appId == appId }) else {
            throw ScreensClientError.http(status: 404, message: "no such app")
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return AppDetailResponse(
            app: app,
            manifest: [
                "name": AnyCodable(app.slug),
                "datastore": AnyCodable("postgres"),
                "siblings": AnyCodable(false),
            ],
            dataLayerInstances: [
                .init(store: "postgres", instanceName: "\(app.slug)_db")
            ],
            members: [
                .init(stableIdPrefix: "ab12cd", role: "owner", addedAt: app.installedAt)
            ],
            browserTabs: [],
            lastBackup: .init(backupId: "bk-\(app.slug)-001", createdAt: now - 60_000 * 60 * 2, bytes: 4_812_000),
            recentLogs: [
                "[\(Self.relativeTime(60))] listening on :8080",
                "[\(Self.relativeTime(45))] GET / → 200",
                "[\(Self.relativeTime(30))] migration check ok"
            ]
        )
    }

    // MARK: - P1.4 marketplace-browse

    public func marketplaceBrowse() async throws -> MarketplaceBrowseResponse {
        try await tick()
        return MarketplaceBrowseResponse(listings: [
            MarketplaceListing(
                creator: "trent",
                slug: "scratchpad",
                title: "Scratchpad",
                summary: "A markdown notes app with offline-first sync.",
                screenshots: [],
                installCount: 412,
                requiresLlmKey: false,
                alreadyInstalled: true
            ),
            MarketplaceListing(
                creator: "wendy",
                slug: "wishlist",
                title: "Family Wishlist",
                summary: "Shared birthday + holiday lists for the household.",
                screenshots: [],
                installCount: 188,
                requiresLlmKey: false,
                alreadyInstalled: false
            ),
            MarketplaceListing(
                creator: "peggy",
                slug: "feed-reader",
                title: "Tiny Feed Reader",
                summary: "Atom + RSS in a clean reader. Optional AI summaries.",
                screenshots: [],
                installCount: 974,
                requiresLlmKey: true,
                alreadyInstalled: false
            )
        ])
    }

    // MARK: - P1.5 vibe-code/start

    public func vibeCodeStart(_ req: VibeCodeStartRequest) async throws -> VibeCodeStartResponse {
        try await tick()
        return VibeCodeStartResponse(sessionId: "vc-\(UUID().uuidString.prefix(8).lowercased())")
    }

    // MARK: - P1.7 vibe-code/:id

    public func vibeCodeStatus(sessionId: String) async throws -> VibeCodeStatusResponse {
        try await tick()
        return VibeCodeStatusResponse(
            status: "streaming",
            transcript: [
                .init(role: "user", content: "Build a habit tracker."),
                .init(role: "assistant", content: "Sketching schema for habits + check-ins…")
            ],
            files: [:],
            deployedUrl: nil,
            errorReason: nil
        )
    }

    // MARK: - P1.8 / P1.9 unlock-approvals

    public func unlockApprovalsPending() async throws -> UnlockApprovalsPendingResponse {
        try await tick()
        return UnlockApprovalsPendingResponse(pending: [])
    }

    public func approveUnlock(requestId: String, body: UnlockApprovalApproveRequest) async throws {
        try await tick()
    }

    // MARK: - P1.10 browser-tabs

    public func browserTabsList(appId: String) async throws -> BrowserTabsListResponse {
        try await tick()
        return BrowserTabsListResponse(tabs: [])
    }

    // MARK: - P1.12 / P1.13 paired-sessions

    public func pairedSessionsList() async throws -> PairedSessionsListResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return PairedSessionsListResponse(sessions: [
            .init(tokenPrefix: "a1b2c3d4", label: "iPhone — Harry", addedAt: now - 60_000 * 60 * 24 * 14, current: true),
            .init(tokenPrefix: "f9e8d7c6", label: "MacBook Pro", addedAt: now - 60_000 * 60 * 24 * 3, current: false)
        ])
    }

    public func revokePairedSession(tokenPrefix: String) async throws {
        try await tick()
    }

    // MARK: - P1.14 orders/send

    public func ordersSend(_ req: OrdersSendRequest) async throws -> OrdersSendResponse {
        try await tick()
        return OrdersSendResponse(ok: true, response: nil)
    }

    // MARK: - P1.16 tier-status

    public func tierStatus() async throws -> TierStatusResponse {
        try await tick()
        return TierStatusResponse(
            tier: "promo",
            llmCreditsRemainingDay: 38,
            llmCreditsRemainingTotal: 162,
            dispatcherUsageGBmonth: 1.2,
            dispatcherFreeQuotaGBmonth: 50.0,
            customDomains: [],
            reservedNames: ["harry"]
        )
    }

    // MARK: - P1.17 / P1.18 url-controller

    public func urlControllerOwned() async throws -> UrlControllerOwnedResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return UrlControllerOwnedResponse(urls: [
            .init(fqdn: "home.harry.flagship.services", kind: "canonical", claimedAt: now - 60_000 * 60 * 24 * 30),
            .init(fqdn: "plants.harry.flagship.services", kind: "alias", claimedAt: now - 60_000 * 30),
            .init(fqdn: "wiki.harry.flagship.services", kind: "alias", claimedAt: now - 60_000 * 60 * 26)
        ])
    }

    public func urlControllerClaim(_ req: UrlControllerClaimRequest) async throws -> UrlControllerClaimResponse {
        try await tick()
        return UrlControllerClaimResponse(ok: true)
    }

    // MARK: - P1.19 / P1.20 app-backup

    // MARK: - P1.21 server-metrics

    public func serverMetrics(podId: String) async throws -> ServerMetricsResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let interval: Int64 = 60_000  // 1-minute samples
        let memTotal: Int64 = 8 * 1024 * 1024 * 1024  // 8 GB
        let diskTotal: Int64 = 256 * 1024 * 1024 * 1024 // 256 GB
        let seed = abs(podId.hashValue)

        var cpu: [ServerMetricsResponse.TimedSample] = []
        var mem: [ServerMetricsResponse.TimedSample] = []
        var io: [ServerMetricsResponse.IOSample] = []
        var net: [ServerMetricsResponse.IOSample] = []
        for i in 0..<60 {
            let t = now - Int64(59 - i) * interval
            let phase = Double(i) / 60.0 * .pi * 2
            let s = Double(seed % 7) / 7.0
            cpu.append(.init(at: t, value: max(2, min(95, 18 + 14 * sin(phase + s) + 6 * cos(2 * phase + s)))))
            mem.append(.init(at: t, value: Double(memTotal) * (0.42 + 0.06 * sin(phase + s))))
            io.append(.init(
                at: t,
                read:  max(0, 220_000 + 180_000 * sin(phase * 1.3 + s)),
                write: max(0, 140_000 + 110_000 * cos(phase * 1.1 + s))
            ))
            net.append(.init(
                at: t,
                read:  max(0, 90_000 + 70_000 * sin(phase * 0.7 + s)),
                write: max(0, 55_000 + 50_000 * cos(phase * 0.9 + s))
            ))
        }
        let memUsed = Int64(mem.last?.value ?? Double(memTotal) * 0.45)
        return ServerMetricsResponse(
            collectedAt: now,
            cpuPercent: cpu.last?.value ?? 21,
            loadAvg1: 0.62, loadAvg5: 0.71, loadAvg15: 0.55,
            memUsedBytes: memUsed,
            memTotalBytes: memTotal,
            diskUsedBytes: Int64(Double(diskTotal) * 0.34),
            diskTotalBytes: diskTotal,
            diskIOReadBytesPerSec: io.last?.read ?? 0,
            diskIOWriteBytesPerSec: io.last?.write ?? 0,
            netRxBytesPerSec: net.last?.read ?? 0,
            netTxBytesPerSec: net.last?.write ?? 0,
            cpuHistory: cpu,
            memHistory: mem,
            ioHistory: io,
            netHistory: net
        )
    }

    // MARK: - P1.15 install-events (mock SSE)

    public func installEvents(serial: String) -> AsyncStream<InstallEvent> {
        AsyncStream { continuation in
            let task = Task { [serial] in
                let timeline: [(TimeInterval, InstallEvent)] = [
                    (0.0,  .registered(serial: serial, at: ts())),
                    (1.5,  .boot(at: ts())),
                    (4.0,  .tunnelOnline(at: ts())),
                    (9.5,  .certIssued(at: ts())),
                    (11.0, .ready(serverFqdn: "newbox.harry.flagship.services", at: ts()))
                ]
                var elapsed: TimeInterval = 0
                for (delay, event) in timeline {
                    let wait = delay - elapsed
                    if wait > 0 {
                        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    }
                    if Task.isCancelled { break }
                    let stamped = event.restamped(ts())
                    continuation.yield(stamped)
                    elapsed = delay
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - P1.6 vibe-code stream (mock WS)

    public func vibeCodeStream(sessionId: String) -> AsyncStream<VibeCodeFrame> {
        AsyncStream { continuation in
            let task = Task {
                let tokens = [
                    "Sketching ", "schema. ", "Two tables: ", "habits, ", "check_ins.\n",
                    "Building manifest…\n",
                    "Creating Docker image…\n",
                    "Deploying to ", "home pod…\n",
                    "Live. 🎉"
                ]
                for t in tokens {
                    if Task.isCancelled { break }
                    continuation.yield(.token(text: t))
                    try? await Task.sleep(nanoseconds: 600_000_000)
                }
                if !Task.isCancelled {
                    continuation.yield(.manifestEmit(manifestJson: "{\"name\":\"habits\",\"datastore\":\"postgres\"}"))
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    continuation.yield(.buildStart)
                    for log in ["FROM node:20-alpine", "RUN apk add postgresql-client", "COPY . /app", "Build ok in 8.4s"] {
                        if Task.isCancelled { break }
                        continuation.yield(.buildLog(line: log))
                        try? await Task.sleep(nanoseconds: 300_000_000)
                    }
                    continuation.yield(.deploy(appId: "habits", url: "https://habits.harry.flagship.services/"))
                    continuation.yield(.done)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func ts() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    public func appBackupStart(_ req: AppBackupStartRequest) async throws -> AppBackupStartResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return AppBackupStartResponse(
            backupId: "bk-\(UUID().uuidString.prefix(8).lowercased())",
            fetchPath: "/api/screens/app-backup/\(req.appId)/fetch",
            expiresAt: now + 3600 * 1000,
            bytes: 4_812_000,
            encrypted: req.password != nil
        )
    }

    private static func relativeTime(_ secondsAgo: Int) -> String {
        let d = Date().addingTimeInterval(-Double(secondsAgo))
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: d)
    }
}
