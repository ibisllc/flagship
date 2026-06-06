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

    /// Set by callers (typically a container view) to pivot the mock
    /// responses on the active pod context. Real LiveScreensClient
    /// achieves the same by swapping `SessionStore.podBaseUrl`.
    public var podContext: String = "home"

    // MARK: - P1.1 server-detail

    public func serverDetail() async throws -> ServerDetailResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let oneDay: Int64 = 24 * 3600 * 1000
        // Vary fixture per current pod so the switcher visibly
        // changes what the screens render.
        let podName = podContext
        let serviceCount = abs(podContext.hashValue) % 5 + 1   // 1–5 apps
        return ServerDetailResponse(
            serverFqdn: "\(podName).harry.flagship.services",
            username: "harry",
            daemonVersion: "0.18.4",
            startedAt: now - Int64(abs(podContext.hashValue) % 30 + 1) * oneDay,
            uptimeMs: Int64(abs(podContext.hashValue) % 30 + 1) * oneDay,
            certNotAfter: now + 67 * oneDay,
            certNotBefore: now - 23 * oneDay,
            certSans: ["\(podName).harry.flagship.services", "*.\(podName).harry.flagship.services"],
            serviceCount: serviceCount,
            pairedSessionCount: 2,
            recentInstallEvents: [
                RecentInstallEvent(at: now - 60_000 * 30, kind: "installed", serviceId: "harry-plants", detail: "via vibe-code"),
                RecentInstallEvent(at: now - 60_000 * 60 * 6, kind: "deploy", serviceId: "harry-wiki", detail: "v1.4.0"),
                RecentInstallEvent(at: now - 60_000 * 60 * 26, kind: "installed", serviceId: "harry-wiki", detail: "via vibe-code"),
            ]
        )
    }

    // MARK: - P1.2 apps-list

    public func appsList() async throws -> AppsListResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return AppsListResponse(apps: [
            AppSummary(
                serviceId: "harry-plants",
                creator: "harry",
                slug: "plants",
                urlLabel: "plants",
                summary: "Houseplant watering tracker",
                url: "https://plants.harry.flagship.services/",
                status: "running",
                version: "0.0.3",
                installedAt: now - 60_000 * 30
            ),
            AppSummary(
                serviceId: "harry-wiki",
                creator: "harry",
                slug: "wiki",
                urlLabel: "wiki",
                summary: "Personal notes + recipes",
                url: "https://wiki.harry.flagship.services/",
                status: "running",
                version: "1.4.0",
                installedAt: now - 60_000 * 60 * 26
            ),
            AppSummary(
                serviceId: "trent-scratchpad",
                creator: "trent",
                slug: "scratchpad",
                urlLabel: "scratchpad-trent",
                summary: "Markdown scratchpad",
                url: "https://scratchpad-trent.harry.flagship.services/",
                status: "stopped",
                version: "0.7.1",
                installedAt: now - 60_000 * 60 * 24 * 12
            )
        ])
    }

    // MARK: - P1.3 app-detail

    public func appDetail(serviceId: String) async throws -> AppDetailResponse {
        try await tick()
        let list = try await appsList()
        guard let app = list.apps.first(where: { $0.serviceId == serviceId }) else {
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


    // MARK: - P1.10 browser-tabs

    public func browserTabsList(serviceId: String) async throws -> BrowserTabsListResponse {
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

    /// Overridable fixture so tests (and dev mode) can pin an exact tier
    /// wire shape — BYOK, custom-domains-present, free-tier, etc. — without
    /// editing the default. Nil = the default promo fixture below.
    public var tierStatusFixture: TierStatusResponse?

    public func tierStatus() async throws -> TierStatusResponse {
        try await tick()
        if let fixture = tierStatusFixture { return fixture }
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
        // Deterministic per-pod seed via FNV-1a over the podId bytes.
        // String.hashValue uses a per-process random salt which made
        // the previous `seed % 7` derivation collide ~14% of the time
        // across two pod IDs — the "yieldsDistinctSeriesPerPod" tests
        // failed flakily under that.
        let seed: UInt64 = {
            var h: UInt64 = 14695981039346656037
            for b in podId.utf8 { h ^= UInt64(b); h &*= 1099511628211 }
            return h
        }()

        var cpu: [ServerMetricsResponse.TimedSample] = []
        var mem: [ServerMetricsResponse.TimedSample] = []
        var io: [ServerMetricsResponse.IOSample] = []
        var net: [ServerMetricsResponse.IOSample] = []
        for i in 0..<60 {
            let t = now - Int64(59 - i) * interval
            let phase = Double(i) / 60.0 * .pi * 2
            // Stretch the seed across the full 0..2π range — using
            // (seed % 360) / 360 gives 360 distinct curves which is
            // plenty for visual distinction.
            let s = Double(seed % 360) / 360.0 * .pi * 2
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

    // MARK: - P1.22 custom-domain verify (mock)

    /// Mock domain verification state. Keyed by fqdn so calls converge
    /// — first call returns .pending, subsequent calls return
    /// .verified, mimicking the typical "register then check DNS"
    /// flow with propagation delay.
    private var verifyCallCount: [String: Int] = [:]

    public func verifyCustomDomain(_ req: VerifyCustomDomainRequest) async throws -> VerifyCustomDomainResponse {
        try await tick()
        let count = (verifyCallCount[req.fqdn] ?? 0) + 1
        verifyCallCount[req.fqdn] = count
        let expected = "flagship-verify=\(req.fqdn.hashValue.magnitude)"
        if count == 1 {
            return VerifyCustomDomainResponse(
                fqdn: req.fqdn,
                status: .pending,
                expectedTxtRecord: expected,
                observedTxtRecord: nil,
                reason: "Waiting for DNS propagation (typical: 1–5 minutes)."
            )
        }
        return VerifyCustomDomainResponse(
            fqdn: req.fqdn,
            status: .verified,
            expectedTxtRecord: expected,
            observedTxtRecord: expected,
            reason: nil
        )
    }

    // MARK: - P1.23 post-recovery status

    /// Drives the SwiftUI preview + dev loop without a real swap.
    /// Defaults to "no recovery in progress"; tests can flip this
    /// directly to exercise the with-report path.
    public var postRecoveryReport: PostRecoverySnapshot? = nil

    public func postRecoveryStatus() async throws -> PostRecoveryStatusResponse {
        try await tick()
        return PostRecoveryStatusResponse(report: postRecoveryReport)
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
                    continuation.yield(.deploy(serviceId: "habits", url: "https://habits.harry.flagship.services/"))
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
            fetchPath: "/api/screens/app-backup/\(req.serviceId)/fetch",
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

    // MARK: - W10 — per-app env vars + vibe-code session

    /// Mock store keyed by appId; values are SECRET — held only in the
    /// mock's in-memory map. Never echoed in any response (mirrors the
    /// daemon's "values never leave" invariant).
    private var mockEnvNames: [String: [String]] = [
        "harry-plants": ["WEATHER_API_KEY"],
        "harry-wiki": []
    ]

    public func serviceEnvList(appId: String) async throws -> ServiceEnvListResponse {
        try await tick()
        return ServiceEnvListResponse(names: (mockEnvNames[appId] ?? []).sorted())
    }
    public func serviceEnvSet(appId: String, _ req: ServiceEnvSetRequest) async throws -> ServiceEnvOpResponse {
        try await tick()
        var names = Set(mockEnvNames[appId] ?? [])
        names.insert(req.name)
        mockEnvNames[appId] = Array(names).sorted()
        return ServiceEnvOpResponse(ok: true)
    }
    public func serviceEnvUnset(appId: String, _ req: ServiceEnvUnsetRequest) async throws -> ServiceEnvOpResponse {
        try await tick()
        var names = Set(mockEnvNames[appId] ?? [])
        names.remove(req.name)
        mockEnvNames[appId] = Array(names).sorted()
        return ServiceEnvOpResponse(ok: true)
    }

    public func vibeCodeSessionState(sessionId: String) async throws -> VibeCodeSessionPublicState {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return VibeCodeSessionPublicState(
            id: sessionId,
            appId: "harry-plants",
            status: "awaiting-tool-response",
            messages: [
                VibeCodeSessionMessage(role: "user", text: "Build me a plants tracker", timestamp: now - 30_000),
                VibeCodeSessionMessage(role: "assistant", text: "Sure — I need a weather API key to send notifications when a plant has been thirsty too long.", timestamp: now - 5_000)
            ],
            pendingRequest: .requestEnvVar(
                toolUseId: "tu_mock_42",
                name: "WEATHER_API_KEY",
                description: "OpenWeather API key",
                why: "to look up today's high temperature for the dehydration warning",
                example: "abc123…",
                secret: true
            )
        )
    }
    public func vibeCodeSessionReply(sessionId: String, _ req: VibeCodeReplyRequest) async throws -> VibeCodeReplyResponse {
        try await tick()
        return VibeCodeReplyResponse(ok: true)
    }

    // MARK: - P9 peer-backup

    /// Overridable fixture for tests + dev. Nil → the honest-empty
    /// "not participating, zero peers, zeroed stats" default below
    /// (matches the daemon's behaviour when the registry is not wired).
    public var peerBackupStatusFixture: PeerBackupStatusResponse?

    /// Records each `peerBackupToggle` call's `participate` argument so
    /// tests can assert the right value flowed through.
    public private(set) var togglePeerBackupCalls: [Bool] = []

    public func peerBackupStatus() async throws -> PeerBackupStatusResponse {
        try await tick()
        if let fixture = peerBackupStatusFixture { return fixture }
        return PeerBackupStatusResponse(
            participating: false,
            peersBackingYouUp: [],
            peersYouBackUp: [],
            shards: [],
            repair: PeerBackupRepairStatus(
                state: "idle",
                lastTickMs: nil,
                queued: 0,
                completed24h: 0,
                lastError: nil
            ),
            stats: PeerBackupStats(
                total: 0,
                durable: 0,
                atRisk: 0,
                yourBytesStored: 0,
                peerBytesHosted: 0
            )
        )
    }

    public func peerBackupToggle(participate: Bool) async throws -> PeerBackupStatusResponse {
        try await tick()
        togglePeerBackupCalls.append(participate)
        if var fixture = peerBackupStatusFixture {
            fixture = PeerBackupStatusResponse(
                participating: participate,
                peersBackingYouUp: fixture.peersBackingYouUp,
                peersYouBackUp: fixture.peersYouBackUp,
                shards: fixture.shards,
                repair: fixture.repair,
                stats: fixture.stats
            )
            peerBackupStatusFixture = fixture
            return fixture
        }
        let next = PeerBackupStatusResponse(
            participating: participate,
            peersBackingYouUp: [],
            peersYouBackUp: [],
            shards: [],
            repair: PeerBackupRepairStatus(
                state: "idle",
                lastTickMs: nil,
                queued: 0,
                completed24h: 0,
                lastError: nil
            ),
            stats: PeerBackupStats(
                total: 0,
                durable: 0,
                atRisk: 0,
                yourBytesStored: 0,
                peerBytesHosted: 0
            )
        )
        peerBackupStatusFixture = next
        return next
    }

    // MARK: - P6 app-invite

    /// Overridable fixture for `appInviteList(serviceId:)`. Nil → honest-
    /// empty default. Matches the daemon's "no pending invites" steady
    /// state. Mirrors Android's `appInviteListFixture`.
    public var appInviteListFixture: AppInviteListResponse?

    /// Overridable fixture for `appInviteAccess(serviceId:)`. Nil →
    /// honest-empty default. Mirrors Android's `appInviteAccessFixture`.
    public var appInviteAccessFixture: AppInviteAccessResponse?

    /// Optional issuance result override. When nil the mock mints a
    /// deterministic 32-byte hex secret + 24h TTL — matching the
    /// daemon's `DEFAULT_TTL_MS`.
    public var appInviteIssueFixture: AppInviteIssueResponse?

    /// Records each `appInviteIssue` call's request so tests can assert
    /// the wire shape (incl. that no label/displayName/sentTo flowed
    /// through — privacy invariant). Mirrors `togglePeerBackupCalls`.
    public private(set) var appInviteIssueCalls: [AppInviteIssueRequest] = []

    /// Records each `appInviteRevoke` call's request — drives the
    /// "revoke fires the right shape" tests.
    public private(set) var appInviteRevokeCalls: [AppInviteRevokeRequest] = []

    public func appInviteIssue(_ req: AppInviteIssueRequest) async throws -> AppInviteIssueResponse {
        try await tick()
        appInviteIssueCalls.append(req)
        if let fixture = appInviteIssueFixture { return fixture }
        // Deterministic-ish: hex(SHA-like) over the opaqueTag; falls
        // back to a 64-zero-hex string if something exotic happens.
        let secret = (0..<32).map { _ in
            String(format: "%02x", UInt8.random(in: 0...255))
        }.joined()
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        return AppInviteIssueResponse(secret: secret, expiresAt: nowMs + 24 * 3600 * 1000)
    }

    public func appInviteList(serviceId: String) async throws -> AppInviteListResponse {
        try await tick()
        if let fixture = appInviteListFixture { return fixture }
        return AppInviteListResponse(pending: [])
    }

    public func appInviteAccess(serviceId: String) async throws -> AppInviteAccessResponse {
        try await tick()
        if let fixture = appInviteAccessFixture { return fixture }
        return AppInviteAccessResponse(access: [])
    }

    public func appInviteRevoke(_ req: AppInviteRevokeRequest) async throws -> AppInviteRevokeResponse {
        try await tick()
        appInviteRevokeCalls.append(req)
        // Idempotency: a second revoke for the same row returns
        // `alreadyRevoked = true`. Tracked by (scope, key) tuple over
        // the call history.
        let key: String = {
            if req.scope == "invite" { return "invite:\(req.serviceId):\(req.inviteId ?? "")" }
            return "access:\(req.serviceId):\(req.irkPubKey ?? "")"
        }()
        let priorMatches = appInviteRevokeCalls.dropLast().contains { prior in
            let pk: String
            if prior.scope == "invite" {
                pk = "invite:\(prior.serviceId):\(prior.inviteId ?? "")"
            } else {
                pk = "access:\(prior.serviceId):\(prior.irkPubKey ?? "")"
            }
            return pk == key
        }
        return AppInviteRevokeResponse(ok: true, alreadyRevoked: priorMatches)
    }

    // MARK: - P14 companion-dock

    /// Overridable fixture for `companionList()`. Nil → honest-empty
    /// default (`{ companions: [] }`), matching the daemon's behaviour
    /// when no companions have been redeemed. Mirrors Android's
    /// `companionListFixture`.
    public var companionListFixture: CompanionListResponse?

    /// Records each `companionMintTicket(_:)` call's request so tests
    /// can assert the label flowed through.
    public private(set) var companionMintCalls: [CompanionMintTicketRequest] = []

    /// Records each `companionRevoke(_:)` call's `tokenPrefix` so
    /// tests can assert the right session was killed.
    public private(set) var companionRevokeCalls: [String] = []

    public func companionMintTicket(_ req: CompanionMintTicketRequest) async throws -> CompanionMintTicketResponse {
        try await tick()
        companionMintCalls.append(req)
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let ticketId = "tk-\(UUID().uuidString.prefix(8).lowercased())"
        let secret = (0..<32).map { _ in
            String(format: "%02x", UInt8.random(in: 0...255))
        }.joined()
        return CompanionMintTicketResponse(
            ticketId: ticketId,
            ticketSecret: secret,
            expiresAt: nowMs + 60 * 1000
        )
    }

    public func companionList() async throws -> CompanionListResponse {
        try await tick()
        if let fixture = companionListFixture { return fixture }
        return CompanionListResponse(companions: [])
    }

    public func companionRevoke(_ req: CompanionRevokeRequest) async throws -> CompanionRevokeResponse {
        try await tick()
        companionRevokeCalls.append(req.tokenPrefix)
        if var fixture = companionListFixture {
            fixture = CompanionListResponse(
                companions: fixture.companions.filter { $0.tokenPrefix != req.tokenPrefix }
            )
            companionListFixture = fixture
        }
        return CompanionRevokeResponse(ok: true)
    }

    // MARK: - P14 Phase 2 companion write-relay (owner queue)

    /// Overridable fixture for `companionPendingWrites()`. Nil → honest-empty
    /// (`{ pending: [] }`), matching the daemon's behaviour when no
    /// companion has queued an unsigned write.
    public var companionPendingWritesFixture: CompanionPendingWritesResponse?

    /// Records each `companionResolvePending(_:)` call so tests can
    /// assert which request was resolved + with what outcome.
    public private(set) var companionResolveCalls: [CompanionResolvePendingRequest] = []

    public func companionPendingWrites() async throws -> CompanionPendingWritesResponse {
        try await tick()
        if let fixture = companionPendingWritesFixture { return fixture }
        return CompanionPendingWritesResponse(pending: [])
    }

    public func companionResolvePending(_ req: CompanionResolvePendingRequest) async throws -> CompanionResolvePendingResponse {
        try await tick()
        companionResolveCalls.append(req)
        if var fixture = companionPendingWritesFixture {
            fixture = CompanionPendingWritesResponse(
                pending: fixture.pending.filter { $0.requestId != req.requestId }
            )
            companionPendingWritesFixture = fixture
        }
        return CompanionResolvePendingResponse(ok: true, alreadyResolved: false)
    }

    // MARK: - P8 browser-tab stream (mock WS)

    public var browserStreamsOpened: [String] = []
    /// Test hook: callers can pre-seed frames the mock should emit on
    /// the next browserTabStream() call. Each entry is sent at startup;
    /// the stream then waits for close() (no auto-finish so the consumer
    /// drives lifecycle).
    public var browserStreamFramesToEmit: [BrowserFrame] = []
    /// Last `MockBrowserStream` handed out — tests inspect `.sent` here
    /// to assert what the VM forwarded after a sendKey/sendMouse call.
    public weak var lastBrowserStream: MockBrowserStream?

    public func browserTabStream(tabId: String) -> any BrowserStream {
        browserStreamsOpened.append(tabId)
        let s = MockBrowserStream()
        lastBrowserStream = s
        let toEmit = browserStreamFramesToEmit
        Task {
            for f in toEmit {
                s.yield(f)
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        return s
    }
}
