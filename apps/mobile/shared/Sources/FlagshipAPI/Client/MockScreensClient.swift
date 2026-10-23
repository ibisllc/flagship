#if DEBUG
import Foundation
import CryptoKit

/// In-memory fixture data for the dev cycle. Every method returns
/// deterministic, plausible data so the entire UI can be exercised
/// without a paired pod.
///
/// To simulate latency or failure, pass a non-zero `simulatedLatency`
/// or set `shouldFail = true` before a call.
public final class MockScreensClient: ScreensClient, @unchecked Sendable {
    public var simulatedLatency: TimeInterval = 0.18
    public var shouldFail: Bool = false
    /// When set, `tick()` throws an `.http` error with this status (used to
    /// exercise status-specific handling, e.g. a 404 build-platform-absent).
    public var simulatedFailureStatus: Int? = nil

    public init() {}

    private func tick() async throws {
        if simulatedLatency > 0 {
            try? await Task.sleep(nanoseconds: UInt64(simulatedLatency * 1_000_000_000))
        }
        if let status = simulatedFailureStatus {
            throw ScreensClientError.http(status: status, message: "simulated failure")
        }
        if shouldFail {
            throw ScreensClientError.http(status: 503, message: "simulated failure")
        }
    }

    /// Set by callers (typically a container view) to pivot the mock
    /// responses on the active pod context. Real LiveScreensClient
    /// achieves the same by swapping `SessionStore.podBaseUrl`.
    public var podContext: String = "home"

    /// Pods whose box doesn't answer (offline, revoked, never came online):
    /// their server detail fails like a real unreachable box, so the server
    /// page shows its honest offline / revoked state.
    public var unreachablePodIds: Set<String> = []

    // MARK: - Releases

    public func serverUpdates(refresh: Bool) async throws -> ReleaseCatalogResponse {
        try await tick()
        let running = "9f2c1ab3de4567890abcdef1234567890abcdef1"
        let newer = "4b1e0c9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c"
        let older = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
        let latest = ReleaseEntry(commit: newer, releaseId: "mock-new", tag: "v0.0.0-2026-10-11-4b1e0c9d",
                                  endorsedAt: "2026-10-11T12:00:00.000Z", relation: "newer")
        return ReleaseCatalogResponse(
            checkedAt: Int64(Date().timeIntervalSince1970 * 1000), currentCommit: running, latest: latest,
            releases: [
                latest,
                ReleaseEntry(commit: running, releaseId: "mock-cur", tag: "v0.0.0-2026-10-10-9f2c1ab3",
                             endorsedAt: "2026-10-10T12:00:00.000Z", relation: "current"),
                ReleaseEntry(commit: older, releaseId: "mock-old", tag: "v0.0.0-2026-10-09-1a2b3c4d",
                             endorsedAt: "2026-10-09T12:00:00.000Z", relation: "older"),
            ],
            stale: nil)
    }

    // MARK: - P1.1 server-detail

    /// What every server detail reports as its app sandbox (nil: absent, as
    /// from an older daemon).
    public var appSandboxFixture: AppSandbox?

    public func serverDetail() async throws -> ServerDetailResponse {
        var detail = try await serverDetailFixture()
        detail.appSandbox = appSandboxFixture
        return detail
    }

    private func serverDetailFixture() async throws -> ServerDetailResponse {
        try await tick()
        if unreachablePodIds.contains(podContext) { throw URLError(.cannotConnectToHost) }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let oneDay: Int64 = 24 * 3600 * 1000
        // Vary fixture per current pod so the switcher visibly
        // changes what the screens render.
        // DemoFixtures pod ids are `demo-<label>-<suffix>`; render the label.
        let podName = podContext.hasPrefix("demo-")
            ? String(podContext.split(separator: "-").dropFirst().first ?? Substring(podContext))
            : podContext
        let serviceCount = abs(podContext.hashValue) % 5 + 1   // 1–5 apps
        return ServerDetailResponse(
            serverFqdn: "\(podName).bright-maple.flagship.services",
            username: "bright-maple",
            daemonVersion: "0.18.4",
            currentCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
            startedAt: now - Int64(abs(podContext.hashValue) % 30 + 1) * oneDay,
            uptimeMs: Int64(abs(podContext.hashValue) % 30 + 1) * oneDay,
            certNotAfter: now + 67 * oneDay,
            certNotBefore: now - 23 * oneDay,
            certSans: ["\(podName).bright-maple.flagship.services", "*.\(podName).bright-maple.flagship.services"],
            serviceCount: serviceCount,
            pairedSessionCount: 2,
            recentInstallEvents: [
                RecentInstallEvent(at: now - 60_000 * 30, kind: "installed", serviceId: "bright-maple--plants", detail: "via vibe-code"),
                RecentInstallEvent(at: now - 60_000 * 60 * 6, kind: "deploy", serviceId: "bright-maple--wiki", detail: "v1.4.0"),
                RecentInstallEvent(at: now - 60_000 * 60 * 26, kind: "installed", serviceId: "bright-maple--wiki", detail: "via vibe-code"),
            ],
            lastUpdate: LastUpdate(outcome: "applied", at: now - 2 * oneDay,
                                   targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
                                   previousCommit: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"),
            debugAccess: debugAccessView(now: now),
            storage: ServerStorage(
                brake: "off", capped: true,
                apps: appStorageFixture.map { AppStorageEntry(serviceId: $0.key, files: $0.value.files, postgres: $0.value.postgres) }
                    .sorted { $0.serviceId < $1.serviceId }
            )
        )
    }

    /// Each app's disk use against its limits, as the box sends it (Wiki's files folder is full).
    public var appStorageFixture: [String: AppDiskUsage] = [
        "bright-maple--plants": AppDiskUsage(
            files: StoreUsage(usedBytes: 2 * 1_073_741_824, limitBytes: 5 * 1_073_741_824, enforced: true),
            postgres: StoreUsage(usedBytes: 300 * 1_048_576, limitBytes: 1_073_741_824)
        ),
        "bright-maple--wiki": AppDiskUsage(
            files: StoreUsage(usedBytes: 5 * 1_073_741_824, limitBytes: 5 * 1_073_741_824, full: true, enforced: true)
        ),
    ]

    // MARK: - Debug access (docs/recipe-delivery-and-remote-install.md)

    /// What the mock box lets in, per server; refusals use the box's sentences.
    public private(set) var debugAccessByPod: [String: DebugAccessView] = [:]
    public private(set) var debugAccessBodies: [String] = []

    private var mockFqdn: String {
        let podName = podContext.hasPrefix("demo-")
            ? String(podContext.split(separator: "-").dropFirst().first ?? Substring(podContext))
            : podContext
        return "\(podName).bright-maple.flagship.services"
    }

    private func debugAccessView(now: Int64) -> DebugAccessView {
        let v = debugAccessByPod[podContext] ?? .off
        if v.on, let e = v.expiresAt, e <= now {
            return DebugAccessView(on: false, lastEnded: .init(at: e, why: "expired"))
        }
        return v
    }

    private static func refuse(_ status: Int, _ sentence: String) -> ScreensClientError {
        let body = (try? JSONSerialization.data(withJSONObject: ["error": sentence])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return .http(status: status, message: body)
    }

    private static func mockFingerprint(_ key: String) -> String? {
        let parts = key.split(separator: " ")
        guard parts.count == 2, let blob = Data(base64Encoded: String(parts[1])) else { return nil }
        return "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }

    // N14 / N11 — scripted sliver and publisher-key state, with the calls recorded.
    public var sliver = SecuritySliverResponse(lines: [])
    public var publisherStates: [String: WaitingPublisherResponse] = [:]
    public private(set) var trustCalls: [(serviceId: String, trust: PublisherTrust, signatureHex: String)] = []
    public private(set) var rejectCalls: [String] = []

    public func securitySliver() async throws -> SecuritySliverResponse {
        try await tick()
        return sliver
    }
    public func publisherState(serviceId: String) async throws -> WaitingPublisherResponse {
        try await tick()
        return publisherStates[serviceId] ?? WaitingPublisherResponse(pinned: nil, waiting: nil)
    }
    public func trustPublisher(serviceId: String, trust: PublisherTrust, signatureHex: String) async throws {
        try await tick()
        trustCalls.append((serviceId, trust, signatureHex))
    }
    public func rejectPublisher(serviceId: String) async throws {
        try await tick()
        rejectCalls.append(serviceId)
    }

    public func debugAccessGrant(body: String) async throws -> DebugAccessChange {
        try await tick()
        debugAccessBodies.append(body)
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any],
              let g = obj["grant"] as? [String: Any] else {
            throw Self.refuse(400, "That debug access grant can't be read.")
        }
        if g["sshAuthorizedKey"] != nil {
            throw Self.refuse(422, "This debug access grant is from an older app. Update the app and turn debug access on again.")
        }
        guard let domain = g["serverDomain"] as? String, let key = g["sshPublicKey"] as? String,
              let issued = (g["issuedAt"] as? NSNumber)?.int64Value,
              let expires = (g["expiresAt"] as? NSNumber)?.int64Value else {
            throw Self.refuse(400, "That debug access grant can't be read.")
        }
        if key.isEmpty { throw Self.refuse(422, "Debug access needs an SSH public key.") }
        guard let fp = Self.mockFingerprint(key) else { throw Self.refuse(422, "That isn't an SSH public key this server can use.") }
        if expires - issued > 7 * 24 * 3600 * 1000 { throw Self.refuse(422, "Debug access can be on for at most 7 days at a time.") }
        if domain.lowercased() != mockFqdn { throw Self.refuse(422, "That debug access grant is for another server.") }
        guard let sig = obj["signatureHex"] as? String, sig.count == 128 else {
            throw Self.refuse(403, "This server takes debug access only from an admin device of this account.")
        }
        let wasOn = debugAccessView(now: issued).on
        let v = DebugAccessView(on: true, expiresAt: expires, keyFingerprint: fp, grantedBy: "admin")
        debugAccessByPod[podContext] = v
        return DebugAccessChange(ok: true, change: wasOn ? "renewed" : "granted", debugAccess: v)
    }

    public func debugAccessRevoke(body: String) async throws -> DebugAccessChange {
        try await tick()
        debugAccessBodies.append(body)
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any],
              let r = obj["revoke"] as? [String: Any], let domain = r["serverDomain"] as? String,
              let issued = (r["issuedAt"] as? NSNumber)?.int64Value else {
            throw Self.refuse(400, "That request to turn off debug access can't be read.")
        }
        if domain.lowercased() != mockFqdn { throw Self.refuse(422, "That request is for another server.") }
        guard let sig = obj["signatureHex"] as? String, sig.count == 128 else {
            throw Self.refuse(403, "This server takes debug access only from an admin device of this account.")
        }
        let wasOn = debugAccessView(now: issued).on
        let v = DebugAccessView(on: false, lastEnded: wasOn ? .init(at: issued, why: "revoked") : debugAccessByPod[podContext]?.lastEnded)
        debugAccessByPod[podContext] = v
        return DebugAccessChange(ok: true, change: wasOn ? "revoked" : "unchanged", debugAccess: v)
    }

    // MARK: - P1.2 apps-list

    /// Replaces the fixture apps list (tests: what this box has).
    public var appsListFixture: AppsListResponse?
    /// Thrown by `appsList` (an unreachable box), every call while set.
    public var appsListError: Error?
    /// `appsListError` applies to the next call only (a retry then works).
    public var appsListErrorOnce = false

    public func appsList() async throws -> AppsListResponse {
        try await tick()
        if let appsListError {
            if appsListErrorOnce { self.appsListError = nil }
            throw appsListError
        }
        if let appsListFixture { return appsListFixture }
        let all = try await defaultAppsList()
        return AppsListResponse(apps: all.apps.filter { !hiddenApps.contains($0.serviceId) }.map { app in
            var a = app
            if membersOnlyApps.contains(a.serviceId) { a.accessMode = "members-only" }
            return a
        })
    }

    /// Apps this box doesn't have (filtered out of the default list).
    public var hiddenApps: Set<String> = []
    /// Apps the default list reports as members only.
    public var membersOnlyApps: Set<String> = []

    private func defaultAppsList() async throws -> AppsListResponse {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // url mirrors the live daemon's tier-1 form
        // `https://<urlLabel>.<serverFqdn>` (screensHttp builds it off the
        // box's per-box wildcard name — cert model A′).
        let fqdn = "\(podContext).bright-maple.flagship.services"
        return AppsListResponse(apps: [
            AppSummary(
                serviceId: "bright-maple--plants",
                creator: "bright-maple",
                slug: "plants",
                urlLabel: "plants",
                summary: "Houseplant watering tracker",
                url: "https://plants.\(fqdn)/",
                status: "running",
                version: "0.0.3",
                installedAt: now - 60_000 * 30,
                egress: mockEgress["bright-maple--plants"],
                access: mockAccessSummary("bright-maple--plants")
            ),
            AppSummary(
                serviceId: "bright-maple--wiki",
                creator: "bright-maple",
                slug: "wiki",
                urlLabel: "wiki",
                summary: "Personal notes + recipes",
                url: "https://wiki.\(fqdn)/",
                status: "running",
                version: "1.4.0",
                installedAt: now - 60_000 * 60 * 26,
                egress: mockEgress["bright-maple--wiki"],
                access: mockAccessSummary("bright-maple--wiki")
            ),
            AppSummary(
                serviceId: "trent--scratchpad",
                creator: "trent",
                slug: "scratchpad",
                urlLabel: "scratchpad--trent",
                summary: "Markdown scratchpad",
                url: "https://scratchpad-trent.\(fqdn)/",
                status: "stopped",
                version: "0.7.1",
                installedAt: now - 60_000 * 60 * 24 * 12
            )
        ])
    }

    /// Set on the mock a co-manager's session reads a shared server through:
    /// its orders verify under that share's member key, as the box checks a
    /// share's orders (docs/share-a-server.md), not under the admin root.
    public var signingShareId: String?

    func requireOwnerOrShare(kind: String, signatureHex: String, over bytes: Data?) throws {
        if let share = signingShareId {
            try MockOrderSigners.shared.requireShare(shareId: share, kind: kind, signatureHex: signatureHex, over: bytes)
        } else {
            try MockOrderSigners.shared.require(.sensitive, kind: kind, signatureHex: signatureHex, over: bytes)
        }
    }

    // MARK: - App copies (docs/app-placement.md §5)

    /// When set, `serviceCopy` refuses a signature this key didn't make.
    public var mockCopyVerifyKey: Data?
    public private(set) var serviceCopyCalls: [AppCopyRequest] = []
    /// Thrown by `serviceCopy` (after recording the call), once.
    public var serviceCopyError: Error?
    /// What `serviceCopies` reports; a successful `serviceCopy` adds one.
    public var mockCopies: [AppCopyEntry] = []
    /// Thrown by `serviceCopies`, every call while set.
    public var serviceCopiesError: Error?
    public private(set) var serviceCopiesCalls = 0

    public func serviceCopy(_ req: AppCopyRequest) async throws -> AppCopyStartResponse {
        try await tick()
        serviceCopyCalls.append(req)
        if let e = serviceCopyError { serviceCopyError = nil; throw e }
        if let key = mockCopyVerifyKey {
            guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
                  let sig = Self.hexBytes(req.signature),
                  pub.isValidSignature(sig, for: req.grant.canonicalBytes()) else {
                throw ScreensClientError.http(status: 403, message: #"{"error":"invalid signature"}"#)
            }
        } else {
            try MockOrderSigners.shared.require(.sensitive, kind: "app-copy", signatureHex: req.signature, over: req.grant.canonicalBytes())
        }
        let me = await boxDomain()
        guard req.grant.targetServer.lowercased() == me?.lowercased() else {
            throw ScreensClientError.http(status: 403, message: #"{"error":"the order is for a different server"}"#)
        }
        let here = (try? await appsList().apps.map(\.serviceId)) ?? []
        if here.contains(req.grant.serviceId)
            || mockCopies.contains(where: { $0.serviceId == req.grant.serviceId && $0.isUnderway }) {
            throw ScreensClientError.http(status: 409, message: #"{"error":"the app is already on this server"}"#)
        }
        let copyId = "cp-\(UUID().uuidString.prefix(8).lowercased())"
        mockCopies.append(AppCopyEntry(
            copyId: copyId, serviceId: req.grant.serviceId,
            appName: mockAppNames[req.grant.serviceId] ?? req.grant.serviceId,
            sourceServer: req.grant.sourceServer, state: "copying", progress: 0,
            startedAt: Int64(Date().timeIntervalSince1970 * 1000)))
        return AppCopyStartResponse(copyId: copyId)
    }

    public func serviceCopies() async throws -> AppCopiesResponse {
        try await tick()
        serviceCopiesCalls += 1
        if let serviceCopiesError { throw serviceCopiesError }
        return AppCopiesResponse(copies: mockCopies)
    }

    // MARK: - App internet access

    /// Per-service `{declared, approved}`; a missing entry is an older box.
    public var mockEgress: [String: AppEgress] = [
        "bright-maple--plants": AppEgress(declared: ["api.open-meteo.com"], approved: []),
        "bright-maple--wiki": AppEgress(declared: ["api.github.com"], approved: ["api.github.com"]),
    ]
    public private(set) var serviceEgressSetCalls: [(serviceId: String, req: AppEgressSetRequest)] = []
    /// Thrown by `serviceEgressSet` (after recording the call).
    public var serviceEgressSetError: Error?

    public func serviceEgressSet(serviceId: String, _ req: AppEgressSetRequest) async throws -> AppEgressSetResponse {
        try await tick()
        serviceEgressSetCalls.append((serviceId, req))
        if let e = serviceEgressSetError { throw e }
        try MockOrderSigners.shared.require(.sensitive, kind: "app-egress", signatureHex: req.signature, over: req.grant.canonicalBytes())
        guard let current = mockEgress[serviceId] else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"no such service"}"#)
        }
        let undeclared = req.grant.hosts.filter { !current.declared.contains($0) }
        if !undeclared.isEmpty {
            throw ScreensClientError.http(
                status: 422,
                message: #"{"error":"not declared in the app's network.egress: \#(undeclared.joined(separator: ", "))"}"#)
        }
        let next = AppEgress(declared: current.declared, approved: req.grant.hosts)
        mockEgress[serviceId] = next
        return AppEgressSetResponse(ok: true, egress: next)
    }

    // MARK: - App access lists (§3a)

    /// Per-service list + pending hosts; a missing entry is a box without
    /// access lists (the page then falls back to `mockEgress`).
    public var mockAccess: [String: AppAccessState] = [
        "bright-maple--plants": AppAccessState(
            list: AppAccessList.defaultList,
            pending: [
                AppAccessPendingHost(host: "api.open-meteo.com", source: "app", attempts: 0,
                                     firstSeen: 1_760_000_000_000, lastSeen: 1_760_000_000_000),
                AppAccessPendingHost(host: "tile.openstreetmap.org", source: "attempt", attempts: 3,
                                     firstSeen: 1_760_000_100_000, lastSeen: 1_760_000_400_000),
            ]),
        "bright-maple--wiki": AppAccessState(
            list: "allow api.github.com\n" + AppAccessList.defaultList),
    ]
    /// Overrides the box FQDN this mock reports (default
    /// `<podContext>.bright-maple.flagship.services`).
    public var mockBoxDomain: String?
    /// When set, `serviceAccessSet` refuses a signature this key didn't make.
    public var mockAccessVerifyKey: Data?
    public private(set) var serviceAccessSetCalls: [(serviceId: String, req: AppAccessSetRequest)] = []
    public private(set) var serviceAccessDismissCalls: [(serviceId: String, host: String)] = []
    public private(set) var accessRequestsCalls = 0
    /// Thrown by `serviceAccessSet` (after recording the call), once.
    public var serviceAccessSetError: Error?
    private var mockAccessIssuedAt: [String: Int64] = [:]

    private let mockAppNames = ["bright-maple--plants": "Plants", "bright-maple--wiki": "Wiki",
                                "trent--scratchpad": "Scratchpad"]

    /// Suggested lists waiting for review, per service (§3a "Suggested
    /// lists"). Applying any list or dismissing drops it.
    public var mockAccessDrafts: [String: AppAccessDraft] = [:]
    public private(set) var serviceAccessDraftDismissCalls: [String] = []

    func mockAccessSummary(_ serviceId: String) -> AppAccessSummary? {
        mockAccess[serviceId].map {
            AppAccessSummary(rules: $0.ruleCount, pending: $0.pending.count, draft: mockAccessDrafts[serviceId] != nil)
        }
    }

    public func boxDomain() async -> String? {
        mockBoxDomain ?? "\(podContext).bright-maple.flagship.services"
    }

    public func serviceAccess(serviceId: String) async throws -> AppAccessState {
        try await tick()
        guard let a = mockAccess[serviceId] else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"no such service"}"#)
        }
        return AppAccessState(list: a.list, listSha256: AppAccessList.sha256Hex(a.list), pending: a.pending,
                              draft: mockAccessDrafts[serviceId])
    }

    /// Checks what the box checks (hash, normalized, parses, own server,
    /// newer), applies the list and drops the requests it now answers.
    public func serviceAccessSet(serviceId: String, _ req: AppAccessSetRequest) async throws -> AppAccessSetResponse {
        try await tick()
        serviceAccessSetCalls.append((serviceId, req))
        if let e = serviceAccessSetError { serviceAccessSetError = nil; throw e }
        guard let current = mockAccess[serviceId] else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"no such service"}"#)
        }
        func refuse(_ status: Int, _ reason: String) -> ScreensClientError {
            .http(status: status, message: #"{"error":"\#(reason)"}"#)
        }
        guard req.grant.serviceId == serviceId else { throw refuse(400, "grant is for a different service") }
        guard AppAccessList.isNormalized(req.list) else {
            throw ScreensClientError.http(status: 400, message: #"{"error":"the list is not normalized","errors":[]}"#)
        }
        let parsed = AppAccessList.parse(req.list)
        if !parsed.isValid {
            let errors = parsed.errors.map { #"{"line":\#($0.line),"message":"\#($0.message.replacingOccurrences(of: "\"", with: "\\\""))"}"# }
            throw ScreensClientError.http(status: 400,
                                          message: #"{"error":"the list has errors","errors":[\#(errors.joined(separator: ","))]}"#)
        }
        guard req.grant.listSha256 == AppAccessList.sha256Hex(req.list) else {
            throw refuse(403, "the list is not the one that was signed")
        }
        guard req.grant.serverDomain == (await boxDomain()) else { throw refuse(403, "grant is for a different server") }
        if let key = mockAccessVerifyKey {
            guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
                  let sig = Self.hexBytes(req.signature),
                  pub.isValidSignature(sig, for: req.grant.canonicalBytes()) else {
                throw refuse(403, "bad signature")
            }
        } else {
            try requireOwnerOrShare(kind: "app-access", signatureHex: req.signature, over: req.grant.canonicalBytes())
        }
        if let last = mockAccessIssuedAt[serviceId], req.grant.issuedAt <= last {
            throw refuse(409, "not newer than the applied list")
        }
        mockAccessIssuedAt[serviceId] = req.grant.issuedAt
        let next = AppAccessState(
            list: req.list, listSha256: req.grant.listSha256,
            pending: current.pending.filter { AppAccessList.decide(req.list, host: $0.host).rule == nil })
        mockAccess[serviceId] = next
        mockAccessDrafts[serviceId] = nil
        return AppAccessSetResponse(ok: true, access: next)
    }

    private static func hexBytes(_ hex: String) -> Data? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let b = UInt8(String(decoding: chars[i..<i + 2], as: UTF8.self), radix: 16) else { return nil }
            out.append(b)
            i += 2
        }
        return out
    }

    @discardableResult
    public func serviceAccessDismiss(serviceId: String, host: String) async throws -> AppAccessState? {
        try await tick()
        serviceAccessDismissCalls.append((serviceId, host))
        GymProbe.note("ignored \(host) for \(serviceId)")
        guard let current = mockAccess[serviceId] else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"no such service"}"#)
        }
        let next = AppAccessState(list: current.list, listSha256: current.listSha256,
                                  pending: current.pending.filter { $0.host != host })
        mockAccess[serviceId] = next
        return AppAccessState(list: next.list, listSha256: next.listSha256, pending: next.pending,
                              draft: mockAccessDrafts[serviceId])
    }

    @discardableResult
    public func serviceAccessDraftDismiss(serviceId: String) async throws -> AppAccessState? {
        try await tick()
        serviceAccessDraftDismissCalls.append(serviceId)
        GymProbe.note("dismissed draft for \(serviceId)")
        guard let current = mockAccess[serviceId] else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"no such service"}"#)
        }
        mockAccessDrafts[serviceId] = nil
        return AppAccessState(list: current.list, listSha256: AppAccessList.sha256Hex(current.list),
                              pending: current.pending)
    }

    // MARK: - The owner's Database section (docs/app-apis.md §6)

    /// A mock table: its columns and every row.
    public struct MockDbTable {
        public var kind: String
        public var columns: [AppDbColumn]
        public var rows: [[AppDbValue]]
        public init(kind: String = "table", columns: [AppDbColumn], rows: [[AppDbValue]]) {
            self.kind = kind
            self.columns = columns
            self.rows = rows
        }
    }

    /// serviceId → store → table name → table. A missing service is a box
    /// without the Database section (404, like an older box).
    public var mockDb: [String: [String: [String: MockDbTable]]] = [
        "bright-maple--plants": ["default": MockScreensClient.mockPlantsTables()],
    ]

    static func mockPlantsTables() -> [String: MockDbTable] {
        let rooms = ["Kitchen", "Hall", "Bedroom"]
        var plantRows: [[AppDbValue]] = []
        for i in 1...240 {
            let room: AppDbValue = i % 7 == 0 ? .null : .string(rooms[i % 3])
            plantRows.append([.int(Int64(i)), .string("Plant \(i)"), room, .bool(i % 2 == 0)])
        }
        let plants = MockDbTable(
            columns: [AppDbColumn(name: "id", type: "int4"), AppDbColumn(name: "name", type: "text"),
                      AppDbColumn(name: "room", type: "text"), AppDbColumn(name: "thirsty", type: "bool")],
            rows: plantRows)
        let wateringRows: [[AppDbValue]] = [
            [.int(1), .string("2026-10-01 08:00:00+00")],
            [.int(2), .string("2026-10-02 08:30:00+00")],
        ]
        let waterings = MockDbTable(
            columns: [AppDbColumn(name: "plant_id", type: "int4"), AppDbColumn(name: "at", type: "timestamptz")],
            rows: wateringRows)
        return ["plants": plants, "waterings": waterings]
    }
    // MARK: Access control — members' roles

    /// Per-service members the box would list (nil: none yet, default editor).
    public var mockMembers: [String: AppMembersResponse] = [:]
    public private(set) var setAppRankCalls: [(serviceId: String, req: AppRankRequest)] = []
    /// Status to answer the next rank change with (e.g. 403), once.
    public var mockMemberRoleStatus: Int?

    public func appMembers(serviceId: String) async throws -> AppMembersResponse {
        try await tick()
        return mockMembers[serviceId]
            ?? AppMembersResponse(serviceId: serviceId, mode: "open", defaultRole: "member", members: [], invites: [])
    }

    /// Mirrors the box: records the order and updates the listed rank.
    public func setAppRank(serviceId: String, _ req: AppRankRequest) async throws -> AppRankResponse {
        try await tick()
        setAppRankCalls.append((serviceId, req))
        try MockOrderSigners.shared.require(.sensitive, kind: "app-rank", signatureHex: req.signature, over: try? req.order.canonicalBytes())
        if let status = mockMemberRoleStatus {
            mockMemberRoleStatus = nil
            throw ScreensClientError.http(status: status, message: #"{"error":"refused"}"#)
        }
        let cur = try await appMembers(serviceId: serviceId)
        let t = req.order.target
        let rank = req.order.rank
        var invites = cur.invites
        var members = cur.members
        var account = cur.account
        if t.hasPrefix("device:") || t.hasPrefix("share:") {
            let refused = rank == "refused"
            account = account.map { a in
                guard a.rankTarget == t else { return a }
                return AppAccountMember(kind: a.kind, deviceId: a.deviceId, devicePub: a.devicePub, tier: a.tier,
                                        shareId: a.shareId, label: a.label, rank: refused ? nil : rank,
                                        set: true, refused: refused)
            }
        } else if t.hasPrefix("invite:") {
            let id = String(t.dropFirst(7))
            let old = invites.first { $0.inviteId == id }
            invites.removeAll { $0.inviteId == id }
            invites.append(AppMemberInviteRole(inviteId: id, role: rank, set: true, tier: old?.tier,
                                               creatorPub: old?.creatorPub, creatorDeviceId: old?.creatorDeviceId))
            members = members.map { m in
                AppMember(aid: m.aid, role: m.role,
                          grants: m.grants.map { $0.inviteId == id ? AppMemberGrant(inviteId: id, role: rank, tier: $0.tier) : $0 },
                          direct: m.direct)
            }
        } else if t.hasPrefix("aid:") {
            let aid = String(t.dropFirst(4))
            members = members.map { $0.aid == aid ? AppMember(aid: aid, role: rank, grants: $0.grants, direct: rank) : $0 }
        }
        mockMembers[serviceId] = AppMembersResponse(serviceId: serviceId, mode: cur.mode, roles: cur.roles,
                                                   defaultRole: cur.defaultRole, descriptions: cur.descriptions,
                                                   accountMembers: cur.accountMembers == nil ? nil : account,
                                                   members: members, invites: invites)
        return AppRankResponse(ok: true, target: t, rank: rank)
    }

    /// When set, a signed query is refused unless this key made the signature.
    public var mockDbVerifyKey: Data?
    public private(set) var serviceDbQueryCalls: [(serviceId: String, store: String, req: AppDbQueryRequest)] = []
    public private(set) var serviceDbTableRowsCalls: [(table: String, offset: Int, limit: Int)] = []
    public private(set) var serviceDbExportCalls: [String] = []
    /// Status to answer every Database call with (e.g. 403 for a companion).
    public var mockDbStatus: Int?
    /// Signed orders already used (`serviceId|store|sqlSha256|issuedAt`).
    private var mockDbUsedOrders: Set<String> = []
    /// Orders to treat as already used, once each: the next signed query
    /// answers 409 this many times.
    public var mockDbForceReplays = 0

    private func dbRefuse(_ status: Int, _ body: String) -> ScreensClientError {
        .http(status: status, message: body)
    }

    private func dbStore(_ serviceId: String, _ store: String) throws -> [String: MockDbTable] {
        if let status = mockDbStatus { throw dbRefuse(status, #"{"error":"refused"}"#) }
        guard let stores = mockDb[serviceId] else { throw dbRefuse(404, #"{"error":"not found"}"#) }
        guard let tables = stores[store] else { throw dbRefuse(404, #"{"error":"no such store"}"#) }
        return tables
    }

    public func serviceDb(serviceId: String) async throws -> AppDbStoresResponse {
        try await tick()
        if let status = mockDbStatus { throw dbRefuse(status, #"{"error":"refused"}"#) }
        guard let stores = mockDb[serviceId] else { throw dbRefuse(404, #"{"error":"not found"}"#) }
        return AppDbStoresResponse(stores: stores.keys.sorted().map { store in
            AppDbStore(store: store, tables: (stores[store] ?? [:]).sorted { $0.key < $1.key }.map { name, t in
                AppDbTable(name: name, kind: t.kind, rows: t.kind == "view" ? nil : Int64(t.rows.count),
                           bytes: Int64(8192 + t.rows.count * 64))
            })
        })
    }

    public func serviceDbTableRows(serviceId: String, store: String, table: String,
                                   offset: Int, limit: Int) async throws -> AppDbTableRows {
        try await tick()
        serviceDbTableRowsCalls.append((table, offset, limit))
        guard let t = try dbStore(serviceId, store)[table] else {
            throw dbRefuse(404, #"{"error":"no such table"}"#)
        }
        let lo = min(max(0, offset), t.rows.count)
        let hi = min(lo + min(limit, 1000), t.rows.count)
        return AppDbTableRows(columns: t.columns, rows: Array(t.rows[lo..<hi]), total: Int64(t.rows.count))
    }

    public func serviceDbExportCsv(serviceId: String, store: String, table: String) async throws -> Data {
        try await tick()
        serviceDbExportCalls.append(table)
        GymProbe.note("exported csv \(table)")
        guard let t = try dbStore(serviceId, store)[table] else {
            throw dbRefuse(404, #"{"error":"no such table"}"#)
        }
        func cell(_ v: AppDbValue) -> String {
            if v.isNull { return "" }
            let s = v.display
            return s.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" })
                ? "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : s
        }
        let lines = [t.columns.map(\.name).joined(separator: ",")] + t.rows.map { $0.map(cell).joined(separator: ",") }
        return Data((lines.joined(separator: "\n") + "\n").utf8)
    }

    /// Mirrors the box: an unsigned statement runs READ ONLY (a write gets
    /// 400 `needsGrant`); a signed one is checked (store, app, server,
    /// statement hash, freshness, signature) and works once (409 after).
    public func serviceDbQuery(serviceId: String, store: String, _ req: AppDbQueryRequest) async throws -> AppDbQueryResult {
        try await tick()
        serviceDbQueryCalls.append((serviceId, store, req))
        let tables = try dbStore(serviceId, store)
        let sql = req.sql.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sql.isEmpty else { throw dbRefuse(400, #"{"error":"sql required"}"#) }
        let verb = sql.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "(" })
            .first.map { $0.uppercased() } ?? ""
        let reads: Set<String> = ["SELECT", "WITH", "SHOW", "EXPLAIN", "TABLE", "VALUES"]
        if let grant = req.grant {
            guard let sigHex = req.signature, let sig = Self.hexBytes(sigHex), sig.count == 64 else {
                throw dbRefuse(400, #"{"error":"invalid signature hex"}"#)
            }
            guard grant.serviceId == serviceId else { throw dbRefuse(400, #"{"error":"the order is for a different app"}"#) }
            guard grant.store == store else { throw dbRefuse(400, #"{"error":"the order is for a different store"}"#) }
            guard grant.serverDomain == (await boxDomain()) else {
                throw dbRefuse(403, #"{"error":"the order is for a different server"}"#)
            }
            guard grant.sqlSha256 == AppDbWriteGrant.sqlSha256(req.sql) else {
                throw dbRefuse(403, #"{"error":"the statement is not the one that was signed"}"#)
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            guard abs(now - grant.issuedAt) <= 10 * 60 * 1000 else {
                throw dbRefuse(403, #"{"error":"the order is stale: sign it again"}"#)
            }
            if let key = mockDbVerifyKey {
                guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
                      pub.isValidSignature(sig, for: grant.canonicalBytes()) else {
                    throw dbRefuse(403, #"{"error":"invalid signature"}"#)
                }
            } else {
                try requireOwnerOrShare(kind: "app-db-write", signatureHex: sigHex, over: grant.canonicalBytes())
            }
            let order = "\(grant.serviceId)|\(grant.store)|\(grant.sqlSha256)|\(grant.issuedAt)"
            if mockDbForceReplays > 0 || mockDbUsedOrders.contains(order) {
                mockDbForceReplays = max(0, mockDbForceReplays - 1)
                throw dbRefuse(409, #"{"error":"this signed order was already used: sign it again"}"#)
            }
            mockDbUsedOrders.insert(order)
            return AppDbQueryResult(command: verb, rowCount: 1)
        }
        guard reads.contains(verb) else {
            throw dbRefuse(400, #"{"error":"cannot execute \#(verb) in a read-only transaction","sqlState":"25006","needsGrant":true}"#)
        }
        if verb == "SELECT", let from = sql.range(of: "from ", options: .caseInsensitive) {
            let name = sql[from.upperBound...].split(whereSeparator: { $0 == " " || $0 == ";" || $0 == "\n" })
                .first.map(String.init) ?? ""
            guard let t = tables[name] else {
                throw dbRefuse(400, #"{"error":"relation \"\#(name)\" does not exist","sqlState":"42P01","position":15}"#)
            }
            let cap = 1000
            return AppDbQueryResult(command: "SELECT", columns: t.columns, rows: Array(t.rows.prefix(cap)),
                                    rowCount: Int64(min(t.rows.count, cap)), truncated: t.rows.count > cap)
        }
        return AppDbQueryResult(command: verb, columns: [AppDbColumn(name: "?column?", type: "int4")],
                                rows: [[.int(1)]], rowCount: 1)
    }

    // MARK: - App API keys (docs/app-apis.md §3)

    /// Per-service keys; a missing entry is a box without API keys (404).
    public var mockApiKeys: [String: [AppApiKey]] = [
        "bright-maple--plants": [
            AppApiKey(keyId: "3f9a0c2e7b1d4a68", label: "Garden sensor", scope: .write,
                      createdAt: 1_760_000_000_000, lastUsedAt: 1_760_100_000_000, expiresAt: nil),
            AppApiKey(keyId: "a1b2c3d4e5f60718", label: "Dashboard", scope: .read,
                      createdAt: 1_760_000_500_000, lastUsedAt: nil, expiresAt: nil),
        ],
        "bright-maple--wiki": [],
    ]
    /// When set, `serviceApiKeyCreate` refuses a signature this key didn't make.
    public var mockApiKeyVerifyKey: Data?
    public private(set) var serviceApiKeyCreateCalls: [(serviceId: String, req: AppApiKeyCreateRequest)] = []
    public private(set) var serviceApiKeyRevokeCalls: [(serviceId: String, keyId: String)] = []
    /// Thrown by `serviceApiKeyCreate` (after recording the call), once.
    public var serviceApiKeyCreateError: Error?

    public func serviceApiKeys(serviceId: String) async throws -> AppApiKeysResponse {
        try await tick()
        guard let keys = mockApiKeys[serviceId] else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"not found"}"#)
        }
        return AppApiKeysResponse(keys: keys)
    }

    /// Checks what the box checks (shape, own server, clock, signature, a
    /// fresh keyId) and answers with a full key once.
    public func serviceApiKeyCreate(serviceId: String, _ req: AppApiKeyCreateRequest) async throws -> AppApiKeyCreateResponse {
        try await tick()
        serviceApiKeyCreateCalls.append((serviceId, req))
        if let e = serviceApiKeyCreateError { serviceApiKeyCreateError = nil; throw e }
        func refuse(_ status: Int, _ reason: String) -> ScreensClientError {
            .http(status: status, message: #"{"error":"\#(reason)"}"#)
        }
        guard var keys = mockApiKeys[serviceId] else { throw refuse(404, "not found") }
        let g = req.grant
        guard g.serviceId == serviceId, AppApiKeyId.isValid(g.keyId), g.expiresAt >= 0,
              (1...64).contains(req.label.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) else {
            throw refuse(400, "malformed grant")
        }
        guard g.serverDomain == (await boxDomain()) else { throw refuse(403, "grant is for a different server") }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard abs(g.issuedAt - now) <= 10 * 60 * 1000 else { throw refuse(403, "stale grant") }
        if let key = mockApiKeyVerifyKey {
            guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
                  let sig = Self.hexBytes(req.signature),
                  pub.isValidSignature(sig, for: g.canonicalBytes()) else {
                throw refuse(403, "bad signature")
            }
        } else {
            try MockOrderSigners.shared.require(.sensitive, kind: "app-api-key", signatureHex: req.signature, over: g.canonicalBytes())
        }
        guard !keys.contains(where: { $0.keyId == g.keyId }) else { throw refuse(409, "keyId exists") }
        keys.insert(AppApiKey(keyId: g.keyId, label: req.label, scope: g.scope, createdAt: now,
                              lastUsedAt: nil, expiresAt: g.expiresAt), at: 0)
        mockApiKeys[serviceId] = keys
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let secret = String((0..<43).map { _ in alphabet.randomElement()! })
        return AppApiKeyCreateResponse(ok: true, key: "fsk_\(g.keyId)_\(secret)")
    }

    public func serviceApiKeyRevoke(serviceId: String, keyId: String) async throws {
        try await tick()
        serviceApiKeyRevokeCalls.append((serviceId, keyId))
        guard var keys = mockApiKeys[serviceId], keys.contains(where: { $0.keyId == keyId }) else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"not found"}"#)
        }
        keys.removeAll { $0.keyId == keyId }
        mockApiKeys[serviceId] = keys
        GymProbe.note("revoked api key \(keyId)")
    }

    private var accessEventContinuations: [AsyncStream<Void>.Continuation] = []

    /// Stays open; `emitAccessRequestEvent()` sends a frame.
    public func accessRequestEvents() -> AsyncStream<Void> {
        AsyncStream { accessEventContinuations.append($0) }
    }

    /// What the box sends when it records a new request.
    public func emitAccessRequestEvent() {
        accessEventContinuations.forEach { $0.yield(()) }
    }

    /// Server orders handed to this box; it holds the newest.
    public private(set) var deliveredServerOrders: [SignedServerOrderWire] = []
    public var deliverServerOrderError: Error?

    @discardableResult
    public func deliverServerOrder(_ order: SignedServerOrderWire) async throws -> ServerOrderAck {
        try await tick()
        if let deliverServerOrderError { throw deliverServerOrderError }
        try MockOrderSigners.shared.require(.sensitive, kind: "server-order", signatureHex: order.signature, payload: order)
        deliveredServerOrders.append(order)
        return ServerOrderAck(heldIssuedAt: deliveredServerOrders.map(\.order.issuedAt).max() ?? 0)
    }

    /// The box's push-alert setting; nil answers 404 like an older box.
    public var mockAccessAlertsEnabled: Bool? = true
    public private(set) var accessAlertsSettingCalls = 0
    public private(set) var setAccessAlertsCalls: [Bool] = []

    public func accessAlertsSetting() async throws -> AccessAlertsSetting {
        try await tick()
        accessAlertsSettingCalls += 1
        guard let enabled = mockAccessAlertsEnabled else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"not found"}"#)
        }
        return AccessAlertsSetting(enabled: enabled)
    }

    @discardableResult
    public func setAccessAlerts(enabled: Bool) async throws -> AccessAlertsSetting {
        try await tick()
        setAccessAlertsCalls.append(enabled)
        guard mockAccessAlertsEnabled != nil else {
            throw ScreensClientError.http(status: 404, message: #"{"error":"not found"}"#)
        }
        mockAccessAlertsEnabled = enabled
        return AccessAlertsSetting(enabled: enabled, ok: true)
    }

    public func accessRequests() async throws -> AppAccessRequestsResponse {
        try await tick()
        accessRequestsCalls += 1
        let requests = mockAccess.keys.sorted().flatMap { id in
            (mockAccess[id]?.pending ?? []).map {
                AppAccessRequest(serviceId: id, appName: mockAppNames[id] ?? id, host: $0.host, source: $0.source,
                                 attempts: $0.attempts, firstSeen: $0.firstSeen, lastSeen: $0.lastSeen)
            }
        }
        let drafts = mockAccessDrafts.keys.sorted().compactMap { id -> AppAccessDraftEntry? in
            guard let d = mockAccessDrafts[id] else { return nil }
            return AppAccessDraftEntry(serviceId: id, appName: mockAppNames[id] ?? id, hosts: d.hosts, createdAt: d.createdAt)
        }.sorted { $0.createdAt > $1.createdAt }
        return AppAccessRequestsResponse(requests: requests, drafts: drafts)
    }

    // MARK: - P1.3 app-detail

    public func appDetail(serviceId: String) async throws -> AppDetailResponse {
        try await tick()
        let list = try await appsList()
        guard let app = list.apps.first(where: { $0.serviceId == serviceId }) else {
            throw ScreensClientError.http(status: 404, message: "no such app")
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var detail = AppDetailResponse(
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
            browserTabs: (mockBrowserTabIds[serviceId] ?? []).map { .init(tabId: $0) },
            lastBackup: .init(backupId: "bk-\(app.slug)-001", createdAt: now - 60_000 * 60 * 2, bytes: 4_812_000),
            recentLogs: [
                "[\(Self.relativeTime(60))] listening on :8080",
                "[\(Self.relativeTime(45))] GET / → 200",
                "[\(Self.relativeTime(30))] migration check ok"
            ],
            storage: appStorageFixture[serviceId]
        )
        if mockEditableApps.contains(serviceId) { detail.editable = true }
        if let repo = mockAdaptedFrom[serviceId] { detail.adaptedFrom = .init(repo: repo) }
        return detail
    }

    /// Apps the box says can be edited here ("Edit this service").
    public var mockEditableApps: Set<String> = []
    /// Apps installed from a shared adaptation: serviceId → repo.
    public var mockAdaptedFrom: [String: String] = [:]
    /// Headless-browser tabs running for an app: serviceId → tab ids.
    public var mockBrowserTabIds: [String: [String]] = [:]

    // MARK: - P1.5 vibe-code/start

    /// Thrown by `vibeCodeStart`, once (an edit the box refuses).
    public var vibeCodeStartError: Error?

    public func vibeCodeStart(_ req: VibeCodeStartRequest) async throws -> VibeCodeStartResponse {
        try await tick()
        if let e = vibeCodeStartError { vibeCodeStartError = nil; throw e }
        if let edit = req.editServiceId { GymProbe.note("started edit of \(edit)") }
        // Mirror the daemon's graceful-absence signal: a start with no BYOK
        // credential (and nothing stored) can't drive a model, so the box
        // answers `needsCredential: true` (the session still exists). The
        // client routes back into the AI-key step to deliver one + retry.
        GymProbe.note("started chat: name=\(req.name ?? "-") visibility=\(req.visibility ?? "-") model=\(req.model ?? "-") "
            + "effort=\(req.effort ?? "-") provider=\(req.credential?.provider ?? "none") attachments=\(req.attachments?.count ?? 0)")
        return VibeCodeStartResponse(
            sessionId: "vc-\(UUID().uuidString.prefix(8).lowercased())",
            needsCredential: req.credential == nil ? true : nil
        )
    }

    // MARK: - P1.7 vibe-code/:id

    public func vibeCodeStatus(sessionId: String) async throws -> VibeCodeStatusResponse {
        try await tick()
        vibeCodeStatusCalls += 1
        if !vibeCodeStatusScript.isEmpty { return vibeCodeStatusScript.removeFirst() }
        if let polls = stagedDeployPolls[sessionId] {
            stagedDeployPolls[sessionId] = polls + 1
            let phases = ["staging", "fixing", "going-live"]
            if polls < phases.count {
                return VibeCodeStatusResponse(status: "deploying", transcript: [], files: [:], deployedUrl: nil,
                                              errorReason: nil, deployPhase: phases[polls])
            }
            return VibeCodeStatusResponse(status: "deployed", transcript: [], files: [:],
                                          deployedUrl: "https://habits.\(podContext).bright-maple.flagship.services/",
                                          errorReason: nil)
        }
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
        return BrowserTabsListResponse(tabs: (mockBrowserTabIds[serviceId] ?? []).map {
            BrowserTab(tabId: $0, serviceId: serviceId, currentUrl: "https://example.com/\($0)", title: "Tab \($0)",
                       screenshotKey: nil, needsField: nil)
        })
    }

    // MARK: - P1.12 / P1.13 paired-sessions

    public func pairedSessionsList() async throws -> PairedSessionsListResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return PairedSessionsListResponse(sessions: [
            // This phone's own session: a Trusted device, not a browser.
            .init(tokenPrefix: "a1b2c3d4", addedAt: now - 60_000 * 60 * 24 * 14, current: true, kind: "device"),
            .init(tokenPrefix: "f9e8d7c6", addedAt: now - 60_000 * 60, current: false, kind: "remote",
                  expiresAt: now + 60_000 * 60 * 3)
        ])
    }

    public func revokePairedSession(tokenPrefix: String) async throws {
        try await tick()
        GymProbe.note("revoked paired session \(tokenPrefix)")
    }

    // MARK: - P1.14 orders/send

    public func ordersSend(_ req: OrdersSendRequest) async throws -> OrdersSendResponse {
        try await tick()
        return OrdersSendResponse(ok: true, response: nil)
    }

    // MARK: - P1.17 / P1.18 url-controller

    public func urlControllerOwned() async throws -> UrlControllerOwnedResponse {
        try await tick()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return UrlControllerOwnedResponse(urls: [
            .init(fqdn: "home.bright-maple.flagship.services", kind: "canonical", claimedAt: now - 60_000 * 60 * 24 * 30),
            .init(fqdn: "plants.bright-maple.flagship.services", kind: "alias", claimedAt: now - 60_000 * 30),
            .init(fqdn: "wiki.bright-maple.flagship.services", kind: "alias", claimedAt: now - 60_000 * 60 * 26)
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

    // MARK: - P1.23 post-recovery status

    /// Drives the SwiftUI preview + dev loop without a real swap.
    /// Defaults to "no recovery in progress"; tests can flip this
    /// directly to exercise the with-report path.
    public var postRecoveryReport: PostRecoverySnapshot? = nil

    public func postRecoveryStatus() async throws -> PostRecoveryStatusResponse {
        try await tick()
        return PostRecoveryStatusResponse(report: postRecoveryReport)
    }

    /// The box's own activity log (`GET /api/screens/activity`), newest first.
    public var mockBoxActivity: [BoxActivityEntry] = []

    public func boxActivity(limit: Int, before: Int?) async throws -> [BoxActivityEntry] {
        try await tick()
        GymProbe.note("read box activity")
        return Array(mockBoxActivity.filter { before == nil || ($0.seq ?? 0) < before! }.prefix(limit))
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
                    (11.0, .ready(serverFqdn: "newbox.bright-maple.flagship.services", at: ts()))
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
        if vibeCodeQuietStreams.contains(sessionId) { return AsyncStream { $0.finish() } }
        return AsyncStream { continuation in
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
                    continuation.yield(.deploy(serviceId: "habits", url: "https://habits.\(podContext).bright-maple.flagship.services/"))
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
        GymProbe.note("backup \(req.serviceId) data=\(req.includeUserData == true) encrypted=\(req.password != nil)")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return AppBackupStartResponse(
            backupId: "bk-\(UUID().uuidString.prefix(8).lowercased())",
            fetchPath: "/api/backups/" + String(format: "%08x", UInt32.random(in: 0...UInt32.max)),
            expiresAt: now + 3600 * 1000,
            bytes: 4_812_000,
            encrypted: req.password != nil
        )
    }

    public private(set) var appBackupFetches: [String] = []
    public func appBackupFetch(fetchPath: String) async throws -> Data {
        try await tick()
        appBackupFetches.append(fetchPath)
        return Data("mock app backup".utf8)
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
        "bright-maple--plants": ["WEATHER_API_KEY"],
        "bright-maple--wiki": []
    ]

    public func serviceEnvList(appId: String) async throws -> ServiceEnvListResponse {
        try await tick()
        return ServiceEnvListResponse(names: (mockEnvNames[appId] ?? []).sorted())
    }
    /// Nonces the mock box has spent: a replayed change is refused, as on a box.
    private var spentEnvNonces: Set<String> = []
    /// Every env change the mock box took, in order (gym and test assertions).
    public private(set) var envChanges: [ServiceEnvChange] = []

    /// The box's checks on one signed change (signatures aside: the mock holds
    /// no IRK pub): the route's app and op, a well-formed change, the value's
    /// hash, and a nonce not spent before. Same refusal words as the box.
    private func acceptEnvChange(appId: String, op: String, _ c: ServiceEnvChange, value: String?) throws {
        func refuse(_ reason: String) -> ScreensClientError {
            .http(status: 400, message: #"{"error":"\#(reason)"}"#)
        }
        guard c.serviceId == appId else { throw refuse("the change names another app") }
        guard c.op == op else { throw refuse("the change is not an \(op)") }
        guard (try? c.canonicalBytes()) != nil else { throw refuse("malformed env change") }
        if op == "set", ServiceEnvChange.valueSha256(value ?? "") != c.valueSha256 {
            throw refuse("the value doesn't match the signed change")
        }
        guard !spentEnvNonces.contains(c.nonce) else { throw refuse("this change was already applied") }
        spentEnvNonces.insert(c.nonce)
        envChanges.append(c)
    }

    public func serviceEnvSet(appId: String, _ req: ServiceEnvSetRequest) async throws -> ServiceEnvOpResponse {
        try await tick()
        try acceptEnvChange(appId: appId, op: "set", req.change, value: req.value)
        var names = Set(mockEnvNames[appId] ?? [])
        GymProbe.note("set env \(req.change.name) on \(appId)")
        names.insert(req.change.name)
        mockEnvNames[appId] = Array(names).sorted()
        return ServiceEnvOpResponse(ok: true)
    }
    public func serviceEnvUnset(appId: String, _ req: ServiceEnvUnsetRequest) async throws -> ServiceEnvOpResponse {
        try await tick()
        try acceptEnvChange(appId: appId, op: "unset", req.change, value: nil)
        var names = Set(mockEnvNames[appId] ?? [])
        GymProbe.note("unset env \(req.change.name) on \(appId)")
        names.remove(req.change.name)
        mockEnvNames[appId] = Array(names).sorted()
        return ServiceEnvOpResponse(ok: true)
    }

    /// What `vibeCodeSessionState` answers instead of the env-var fixture.
    public var vibeCodeSessionStateFixture: VibeCodeSessionPublicState?
    /// Per-session states, before `vibeCodeSessionStateFixture`.
    public var vibeCodeSessionStateFixtures: [String: VibeCodeSessionPublicState] = [:]
    /// Sessions whose stream sends nothing (a chat that isn't running).
    public var vibeCodeQuietStreams: Set<String> = []
    /// What `vibeCodeNameCheck` answers per name; others are free.
    public var vibeCodeNameCheckFixtures: [String: VibeCodeNameCheck] = [:]
    public func vibeCodeNameCheck(name: String) async throws -> VibeCodeNameCheck {
        try await tick()
        return vibeCodeNameCheckFixtures[name] ?? VibeCodeNameCheck(ok: true, name: name)
    }
    public private(set) var vibeCodeDiscardCalls: [String] = []
    public func vibeCodeDiscard(sessionId: String) async throws {
        try await tick()
        vibeCodeDiscardCalls.append(sessionId)
        vibeCodeSessionsFixture.removeAll { $0.sessionId == sessionId }
        GymProbe.note("discarded chat \(sessionId)")
    }
    public func vibeCodeSessionState(sessionId: String) async throws -> VibeCodeSessionPublicState {
        try await tick()
        if let s = vibeCodeSessionStateFixtures[sessionId] { return s }
        if let vibeCodeSessionStateFixture { return vibeCodeSessionStateFixture }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return VibeCodeSessionPublicState(
            id: sessionId,
            appId: "bright-maple--plants",
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
            ),
            canContinue: false,
            conversationTokens: 1_850
        )
    }
    public private(set) var vibeCodeReplies: [VibeCodeReplyRequest] = []
    /// Refuses like the box (`/reply`): a chat that is running, deploying,
    /// deployed or stopped takes no message, and a new one needs text.
    public func vibeCodeSessionReply(sessionId: String, _ req: VibeCodeReplyRequest) async throws -> VibeCodeReplyResponse {
        try await tick()
        if let s = vibeCodeSessionStateFixtures[sessionId] ?? vibeCodeSessionStateFixture {
            let answering = s.status == "awaiting-tool-response" && s.pendingRequest != nil
            if !answering && s.canContinue != true {
                let refusal: String
                switch s.status {
                case "streaming": refusal = "The AI is still working on this build. Wait for it to finish."
                case "deploying": refusal = "This build is deploying. Wait for it to finish."
                case "deployed": refusal = "This app is deployed. To change it, open the app and choose Change this app."
                case "cancelled": refusal = "This build was stopped. Start a new build."
                default: refusal = "this chat can't take a message now"
                }
                throw ScreensClientError.http(status: 409, message: Self.errorBody(refusal))
            }
            if !answering && (req.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw ScreensClientError.http(status: 400, message: Self.errorBody("text required"))
            }
        }
        vibeCodeReplies.append(req)
        // What reached the box, never the key: the text kind, model, effort
        // and the provider of a key the message carried ("keep" for none).
        let kind = req.envVarStatus.map { "env=\($0)" } ?? "text"
        GymProbe.note("replied to \(sessionId): \(kind) model=\(req.model ?? "-") effort=\(req.effort ?? "-") "
            + "provider=\(req.credential?.provider ?? "keep") attachments=\(req.attachments?.count ?? 0)")
        if let s = vibeCodeSessionStateFixtures[sessionId], let text = req.text, req.envVarStatus == nil {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            vibeCodeSessionStateFixtures[sessionId] = VibeCodeSessionPublicState(
                id: s.id, appId: s.appId, status: s.status,
                messages: s.messages + [VibeCodeSessionMessage(role: "user", text: text, timestamp: now)],
                pendingRequest: s.pendingRequest, failureReason: s.failureReason, needsCredential: false,
                deployPhase: s.deployPhase, model: req.model ?? s.model, effort: req.model == nil ? s.effort : req.effort,
                summarised: s.summarised, canContinue: s.canContinue,
                provider: req.credential?.provider ?? s.provider, conversationTokens: s.conversationTokens)
        }
        return VibeCodeReplyResponse(ok: true)
    }

    private static func errorBody(_ e: String) -> String {
        (try? String(data: JSONSerialization.data(withJSONObject: ["error": e]), encoding: .utf8)) ?? "{}"
    }

    /// What `vibeCodeSessions` lists (`GET /api/llm/sessions`).
    public var vibeCodeSessionsFixture: [VibeCodeSessionMeta] = []
    public func vibeCodeSessions() async throws -> VibeCodeSessionsResponse {
        try await tick()
        return VibeCodeSessionsResponse(sessions: vibeCodeSessionsFixture)
    }

    /// What `aiModels` answers; nil ⇒ an own-key list for the credential's provider.
    public var aiModelsFixture: AiModelsResponse?
    public private(set) var aiModelsCalls = 0
    public func aiModels(_ req: AiModelsRequest) async throws -> AiModelsResponse {
        try await tick()
        aiModelsCalls += 1
        if let aiModelsFixture { return aiModelsFixture }
        if req.credential.provider == "flagship" {
            return AiModelsResponse(provider: "flagship", kind: "flagship", catalog: .mock)
        }
        return AiModelsResponse(provider: req.credential.provider, kind: "own", listed: true,
                                models: ModelOption.mockOwn, defaultModel: ModelOption.mockOwn.first?.id)
    }
    public func vibeCodeDeploy(sessionId: String) async throws -> BuildDeployResponse {
        try await tick()
        return BuildDeployResponse(
            ok: true,
            serviceId: "bright-maple-habits",
            url: "https://habits.\(podContext).bright-maple.flagship.services/"
        )
    }

    /// Answered by `vibeCodeStatus` in order before anything else.
    public var vibeCodeStatusScript: [VibeCodeStatusResponse] = []
    public private(set) var vibeCodeStatusCalls = 0
    /// Overrides what a staged deploy start answers (e.g. an older box's
    /// finished result).
    public var vibeCodeDeployStartFixture: VibeCodeDeployReply?
    public var vibeCodeDeployStartError: Error?
    public private(set) var vibeCodeDeployStartCalls: [String] = []
    /// Sessions deploying in the background → how many times they were polled.
    private var stagedDeployPolls: [String: Int] = [:]

    public func vibeCodeDeployStart(sessionId: String) async throws -> VibeCodeDeployReply {
        try await vibeCodeDeployStart(sessionId: sessionId, credential: nil)
    }

    /// The `credential` each deploy start carried, in order.
    public private(set) var vibeCodeDeployStartCredentials: [LlmProviderCredential?] = []

    public func vibeCodeDeployStart(sessionId: String, credential: LlmProviderCredential?) async throws -> VibeCodeDeployReply {
        try await tick()
        vibeCodeDeployStartCalls.append(sessionId)
        vibeCodeDeployStartCredentials.append(credential)
        GymProbe.note("deploy started \(sessionId) provider=\(credential?.provider ?? "none")")
        if let e = vibeCodeDeployStartError { throw e }
        if let f = vibeCodeDeployStartFixture { return f }
        stagedDeployPolls[sessionId] = 0
        return VibeCodeDeployReply(ok: true, started: true)
    }

    // MARK: - P9 peer-backup

    /// Overridable fixture for tests + dev. Nil → the honest-empty
    /// "not participating, zero peers, zeroed stats" default below
    /// (matches the daemon's behaviour when the registry is not wired).
    public var peerBackupStatusFixture: PeerBackupStatusResponse?

    /// Records each `peerBackupToggle` call's `participate` argument so
    /// tests can assert the right value flowed through.
    public private(set) var togglePeerBackupCalls: [Bool] = []

    // MARK: - Backup/clone server (in-memory: the archive is a fixed blob)

    public var archiveBytes: Data = Data(repeating: 7, count: 5_000)
    public private(set) var archiveStarts: [ServerArchiveStartRequest] = []
    public private(set) var archiveForgotten = false
    public private(set) var restoreStarts: [ServerRestoreStartRequest] = []
    public private(set) var restoreChunks: [(offset: Int64, count: Int)] = []
    public private(set) var restoreCommits: [ServerRestoreCommitRequest] = []
    public var restoreApps: [ServerRestoreApp] = [ServerRestoreApp(serviceId: "alice--wiki", name: "Wiki", state: "done")]
    public var restoreFinalState = "done"
    public var restoreFailure: String?
    /// The backup this (mock) server waits for; nil ⇒ it isn't waiting.
    public var restoreWaiting: ServerRestoreWaiting?
    /// How much of the data file the server already holds when an upload starts.
    public var restoreAlreadyReceived: Int64 = 0
    /// A small backup file the mock hands out (a real one comes from the box).
    public var archiveBackupFile = Data("{\"magic\":\"flagship-backup\",\"v\":2}\n".utf8)

    public func serverArchiveStart(_ req: ServerArchiveStartRequest) async throws {
        try await tick()
        archiveStarts.append(req)
        archiveForgotten = false
        GymProbe.note("backup started with \(req.slots.count) slots")
    }
    public func serverArchiveStatus() async throws -> ServerArchiveStatus? {
        try await tick()
        guard let id = archiveStarts.last?.archiveId, !archiveForgotten else { return nil }
        let sha = SHA256.hash(data: archiveBytes).map { String(format: "%02x", $0) }.joined()
        let bundle = archiveBundle
        return ServerArchiveStatus(archiveId: id, state: "ready", startedAt: 1, bytes: Int64(archiveBytes.count), sha256: sha,
                                   backupFileName: "home-1970-01-01.flagship-backup", dataFileName: "home-1970-01-01.flagship-data",
                                   apps: [ServerArchiveApp(serviceId: "alice--wiki", name: "Wiki")],
                                   bundleFileName: "home-1970-01-01.flagship", bundleBytes: Int64(bundle.count),
                                   bundleSha256: Self.sha(bundle))
    }
    public func serverArchiveChunk(offset: Int64) async throws -> Data {
        try await tick()
        let start = Int(offset)
        return archiveBytes.subdata(in: start..<min(start + 4 * 1024 * 1024, archiveBytes.count))
    }
    public func serverArchiveBackupFile() async throws -> Data {
        try await tick()
        return archiveBackupFile
    }
    public func serverArchiveForget() async throws {
        try await tick()
        archiveForgotten = true
        GymProbe.note("backup forgotten")
    }
    public private(set) var archiveApprovals: [ServerArchiveApproveRequest] = []
    public func serverArchiveApprove(_ req: ServerArchiveApproveRequest) async throws {
        try await tick()
        archiveApprovals.append(req)
    }
    public func serverRestoreStart(_ req: ServerRestoreStartRequest) async throws -> ServerRestoreStartResponse {
        try await tick()
        restoreStarts.append(req)
        return ServerRestoreStartResponse(received: restoreAlreadyReceived)
    }
    public func serverRestoreChunk(offset: Int64, data: Data) async throws {
        try await tick()
        restoreChunks.append((offset, data.count))
    }
    public func serverRestoreCommit(_ req: ServerRestoreCommitRequest) async throws {
        try await tick()
        restoreCommits.append(req)
        GymProbe.note("restore committed")
    }
    /// The lost server's peer record this box opens, and what it was asked.
    public var peerRootFixture: PeerRootSummary?
    public private(set) var peerRootRequests: [PeerRestoreRequest] = []
    public private(set) var peerRestoreRequests: [PeerRestoreRequest] = []
    /// The next `peer-backup/root` or `from-peers` fails with this sentence (the box's own).
    public var peerFailure: String?
    public func peerBackupRoot(_ req: PeerRestoreRequest) async throws -> PeerRootSummary {
        try await tick()
        peerRootRequests.append(req)
        guard let r = peerRootFixture, r.serverId == req.serverId else {
            throw Self.refusal(404, "no peer backup of that server was found")
        }
        return r
    }
    public func serverRestoreFromPeers(_ req: PeerRestoreRequest) async throws {
        try await tick()
        if let why = peerFailure { throw Self.refusal(409, why) }
        peerRestoreRequests.append(req)
        if let r = peerRootFixture { restoreStarts.append(ServerRestoreStartRequest(archiveId: r.archive.archiveId, bytes: r.archive.bytes)) }
    }
    public func serverRestoreStatus() async throws -> ServerRestoreStatusResponse {
        try await tick()
        if restoreCommits.isEmpty, !peerRestoreRequests.isEmpty, let s = restoreStarts.last {
            return ServerRestoreStatusResponse(
                waiting: restoreWaiting,
                restore: ServerRestoreStatus(archiveId: s.archiveId, state: "ready", bytes: s.bytes, received: s.bytes, apps: [], reason: nil))
        }
        guard let id = restoreStarts.last?.archiveId, !restoreCommits.isEmpty else {
            return ServerRestoreStatusResponse(waiting: restoreWaiting, restore: nil)
        }
        let failed = restoreFailure != nil
        let done = !failed && restoreFinalState == "done"
        return ServerRestoreStatusResponse(
            waiting: done ? nil : restoreWaiting,
            restore: ServerRestoreStatus(archiveId: id, state: failed ? "failed" : restoreFinalState,
                                         bytes: restoreStarts.last?.bytes ?? 0, received: restoreStarts.last?.bytes ?? 0,
                                         apps: restoreApps, reason: restoreFailure)
        )
    }

    // MARK: - Saved backups and the backup policy
    //
    // Answers like the box (serverArchive/service.ts and backupPolicy/http.ts):
    // same shapes, same sentences, same refusals. Every backup's one file is
    // `archiveBundle` (the header, `archiveBackupFile`, then `archiveBytes`).

    /// The box's sentence while its key pool is empty.
    public static let noKeysSentence =
        "an admin device of your account hasn't approved backups for this server yet: open this server in the Flagship app on an admin device"
    public var savedSchedule = BackupSchedule.boxDefault
    /// Newest first.
    public var savedBackupsList: [SavedBackup] = []
    public var savedKeyPool: [ArchiveKey] = []
    public var savedLastRun: SavedBackupLastRun?
    public var savedRunning: SavedBackupRunning?
    /// How many reads a Back up now stays running for before it is listed.
    public var savedRunReads = 2
    /// The next run fails with this sentence (the box's `lastRun.reason`).
    public var savedRunFailure: String?
    public var savedNow: @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    public private(set) var savedSchedulePuts: [BackupSchedule] = []
    public private(set) var savedKeyDeposits: [ArchiveKeysDepositRequest] = []
    public private(set) var savedDeletes: [String] = []
    public private(set) var savedRuns = 0
    /// The parallel downloader reads bundle parts from several tasks at once, so this one list is locked.
    private let bundleReadsLock = NSLock()
    private var bundleReadsStore: [ServerArchiveRoute] = []
    public var bundleReads: [ServerArchiveRoute] {
        bundleReadsLock.lock(); defer { bundleReadsLock.unlock() }
        return bundleReadsStore
    }
    private var savedUsedIds: Set<String> = []
    private var savedRunReadsLeft = 0

    public var policyCurrent = BackupPolicyCurrent(policy: "unset")
    /// What a backup of this server would hold, and its disk.
    public var policyUsedBytes: Int64 = 3_435_973_837
    public var policyDiskBytes: Int64 = 360 * 1_073_741_824
    public var policyPeer: PeerBackupEngineStatus?
    public private(set) var policyOrders: [BackupPolicyRequest] = []

    /// The one `.flagship` file the mock box serves for every backup.
    public var archiveBundle: Data {
        var len = UInt64(archiveBackupFile.count).bigEndian
        var out = Data("FLGSHBK1".utf8)
        withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        return out + archiveBackupFile + archiveBytes
    }
    public var archiveBundleSha: String { Self.sha(archiveBundle) }

    private static let gib: Int64 = 1_073_741_824
    private static func formatGb(_ n: Int64) -> String {
        let v = Double(n) / Double(gib)
        return n < 10 * gib ? String(format: "%.1f GB", v) : String(format: "%.0f GB", v)
    }
    static func sha(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
    static func refusal(_ status: Int, _ error: String, code: String? = nil) -> ScreensClientError {
        var o: [String: Any] = ["error": error]
        if let code { o["code"] = code }
        let body = (try? JSONSerialization.data(withJSONObject: o)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return .http(status: status, message: body)
    }

    /// A saved backup made at `createdAt` (for seeding the list).
    public func makeSavedBackup(createdAt: Int64, trigger: String = "schedule", id: String? = nil) -> SavedBackup {
        let archiveId = id ?? (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd-HHmm"
        let stem = "home-\(f.string(from: Date(timeIntervalSince1970: Double(createdAt) / 1000)))"
        let bundle = archiveBundle
        return SavedBackup(archiveId: archiveId, createdAt: createdAt, trigger: trigger, bytes: Int64(archiveBytes.count),
                           sha256: Self.sha(archiveBytes), backupBytes: Int64(archiveBackupFile.count),
                           backupFileName: "\(stem).flagship-backup", dataFileName: "\(stem).flagship-data",
                           apps: [ServerArchiveApp(serviceId: "bright-maple--plants", name: "Plants"),
                                  ServerArchiveApp(serviceId: "bright-maple--wiki", name: "Wiki")],
                           bundleFileName: "\(stem).flagship", bundleBytes: Int64(bundle.count), bundleSha256: Self.sha(bundle))
    }

    /// Fresh keys in the pool (as an admin device's deposit would bring).
    public func seedKeyPool(_ n: Int) {
        savedKeyPool = (0..<n).map { i in
            ArchiveKey(archiveId: String(format: "%032x", i + 1), kekHex: String(repeating: "ab", count: 32))
        }
    }

    private func scheduleActive() -> Bool { policyCurrent.policy != "none" }

    private func nextRun(now: Int64) -> Int64? {
        let s = savedSchedule
        guard s.frequency != "off", !savedKeyPool.isEmpty, scheduleActive() else { return nil }
        let day: Int64 = 86_400_000
        var t = (now / day) * day + Int64(s.minuteOfDayUtc) * 60_000
        if t <= now { t += day }
        if s.frequency == "weekly" {
            while Calendar.mockUtcWeekday(t) != s.weekdayUtc { t += day }
        }
        return t
    }

    private func advanceRun() {
        guard let r = savedRunning else { return }
        if savedRunReadsLeft > 0 {
            savedRunReadsLeft -= 1
            savedRunning = SavedBackupRunning(archiveId: r.archiveId, trigger: r.trigger, startedAt: r.startedAt,
                                              progress: ServerArchiveProgress(done: min(r.progress.done + 1, r.progress.total),
                                                                              total: r.progress.total, app: "Wiki"))
            return
        }
        savedRunning = nil
        if let why = savedRunFailure {
            savedRunFailure = nil
            savedLastRun = SavedBackupLastRun(at: r.startedAt, ok: false, trigger: r.trigger, reason: why)
            return
        }
        savedBackupsList.insert(makeSavedBackup(createdAt: r.startedAt, trigger: r.trigger, id: r.archiveId), at: 0)
        savedLastRun = SavedBackupLastRun(at: r.startedAt, ok: true, trigger: r.trigger, archiveId: r.archiveId)
    }

    private func savedView() -> SavedBackupsView {
        let pool = savedKeyPool.count
        return SavedBackupsView(
            schedule: savedSchedule,
            scheduleActive: scheduleActive(),
            nextRunAt: nextRun(now: savedNow()),
            lastRun: savedLastRun,
            running: savedRunning,
            keysLeft: pool,
            keysWanted: pool < 30 ? min(400, 800 - pool) : 0,
            waitingReason: pool == 0 && savedSchedule.frequency != "off" ? Self.noKeysSentence : nil,
            usedBytes: savedBackupsList.reduce(0) { $0 + $1.bytes + $1.backupBytes },
            backups: savedBackupsList
        )
    }

    public func savedBackups() async throws -> SavedBackupsView {
        try await tick()
        advanceRun()
        return savedView()
    }

    public func savedBackupsSetSchedule(_ s: BackupSchedule) async throws -> SavedBackupsView {
        try await tick()
        guard ["daily", "weekly", "off"].contains(s.frequency) else { throw Self.refusal(400, "frequency must be daily, weekly or off") }
        guard (0...1439).contains(s.minuteOfDayUtc) else { throw Self.refusal(400, "the time must be a minute of the day (0 to 1439)") }
        guard (0...6).contains(s.weekdayUtc) else { throw Self.refusal(400, "the weekday must be 0 (Sunday) to 6") }
        guard (0...60).contains(s.keepDaily) else { throw Self.refusal(400, "keep between 0 and 60 daily backups") }
        guard (0...52).contains(s.keepWeekly) else { throw Self.refusal(400, "keep between 0 and 52 weekly backups") }
        guard s.keepDaily + s.keepWeekly > 0 else { throw Self.refusal(400, "keep at least one backup") }
        savedSchedule = s
        savedSchedulePuts.append(s)
        GymProbe.note("put backup schedule \(s.frequency) minute \(s.minuteOfDayUtc) weekday \(s.weekdayUtc) keep \(s.keepDaily)/\(s.keepWeekly)")
        return savedView()
    }

    public func savedBackupsDepositKeys(_ req: ArchiveKeysDepositRequest) async throws -> SavedBackupsView {
        try await tick()
        let d = req.deposit
        let sigOk = req.signature.count == 128 && req.signature.allSatisfy(\.isHexDigit)
        let ids = Set(req.keys.map(\.archiveId))
        guard !req.keys.isEmpty, req.keys.count <= 400, ids.count == req.keys.count, sigOk else { throw Self.refusal(400, "malformed keys") }
        let lines = req.keys.map { "\($0.archiveId):\($0.kekHex)" }.joined(separator: "\n")
        guard d.count == req.keys.count, d.digest == Self.sha(Data(lines.utf8)) else {
            throw Self.refusal(400, "the keys don't match their signature")
        }
        guard abs(savedNow() - d.issuedAt) <= 10 * 60_000 else { throw Self.refusal(403, "the approval is stale: approve again") }
        do {
            try MockOrderSigners.shared.require(.sensitive, kind: "server-archive-keys", signatureHex: req.signature, payload: d)
        } catch {
            throw Self.refusal(403, "only an admin device of this account can approve backups")
        }
        savedKeyDeposits.append(req)
        let have = Set(savedKeyPool.map(\.archiveId)).union(savedUsedIds)
        savedKeyPool = Array((savedKeyPool + req.keys.filter { !have.contains($0.archiveId) }).prefix(800))
        GymProbe.note("deposited \(req.keys.count) backup keys")
        return savedView()
    }

    public func savedBackupsRun() async throws -> SavedBackupRunResponse {
        try await tick()
        if savedRunning != nil { throw Self.refusal(409, "a backup or restore is already running here") }
        guard let k = savedKeyPool.first else { throw Self.refusal(409, Self.noKeysSentence, code: "no-keys") }
        savedKeyPool.removeFirst()
        savedUsedIds.insert(k.archiveId)
        savedRuns += 1
        savedRunReadsLeft = savedRunReads
        savedRunning = SavedBackupRunning(archiveId: k.archiveId, trigger: "now", startedAt: savedNow(),
                                          progress: ServerArchiveProgress(done: 0, total: 2, app: "Plants"))
        GymProbe.note("backup now \(k.archiveId)")
        return SavedBackupRunResponse(archiveId: k.archiveId)
    }

    public func savedBackupDelete(archiveId: String) async throws -> SavedBackupsView {
        try await tick()
        if savedRunning?.archiveId == archiveId { throw Self.refusal(409, "the backup is still being made") }
        guard savedBackupsList.contains(where: { $0.archiveId == archiveId }) else {
            throw Self.refusal(404, "that backup isn't on this server")
        }
        savedBackupsList.removeAll { $0.archiveId == archiveId }
        savedDeletes.append(archiveId)
        GymProbe.note("deleted backup \(archiveId)")
        return savedView()
    }

    public func serverArchiveBundle(_ route: ServerArchiveRoute, offset: Int64) async throws -> Data {
        try await tick()
        switch route {
        case .current:
            guard archiveStarts.last != nil, !archiveForgotten else { throw Self.refusal(404, "no backup is ready") }
        case .saved(let id):
            guard savedBackupsList.contains(where: { $0.archiveId == id }) else { throw Self.refusal(404, "no backup is ready") }
        }
        let bundle = archiveBundle
        guard offset >= 0, offset <= Int64(bundle.count) else { throw Self.refusal(400, "bad offset") }
        bundleReadsLock.lock(); bundleReadsStore.append(route); bundleReadsLock.unlock()
        let start = Int(offset)
        let data = bundle.subdata(in: start..<min(start + 4 * 1024 * 1024, bundle.count))
        if start + data.count >= bundle.count, case .saved(let id) = route { GymProbe.note("downloaded backup \(id)") }
        return data
    }

    private func limitBytes(_ p: BackupPolicyCurrent) -> Int64? {
        switch p.policy {
        case "phone": return p.phoneReserveBytes > 0 ? p.phoneReserveBytes : nil
        case "peer": return policyDiskBytes / 3
        default: return nil
        }
    }

    private func policyView() -> BackupPolicyView {
        let limit = limitBytes(policyCurrent)
        let over = limit.map { policyUsedBytes >= $0 } ?? false
        let why = policyCurrent.policy == "phone"
            ? "the space your device keeps for its backup"
            : "a third of its disk, so other servers can keep their backups on it"
        let reason = over
            ? "This server holds \(Self.formatGb(policyUsedBytes)) of app data, over its backup limit of \(Self.formatGb(limit ?? 0)) (\(why)). Remove apps or data, or change the backup policy on the server page."
            : nil
        return BackupPolicyView(
            policy: policyCurrent,
            cap: BackupCapView(limitBytes: limit, usedBytes: policyUsedBytes, measuredAt: savedNow(), overLimit: over,
                               diskBytes: policyDiskBytes,
                               reservedForPeersBytes: policyCurrent.policy == "peer" ? policyDiskBytes - policyDiskBytes / 3 : nil,
                               apps: [BackupCapApp(serviceId: "bright-maple--plants", bytes: policyUsedBytes / 3),
                                      BackupCapApp(serviceId: "bright-maple--wiki", bytes: policyUsedBytes - policyUsedBytes / 3)],
                               overReason: reason),
            peer: policyCurrent.policy == "peer" ? policyPeer : nil
        )
    }

    public func backupPolicy() async throws -> BackupPolicyView {
        try await tick()
        return policyView()
    }

    public func setBackupPolicy(_ req: BackupPolicyRequest) async throws -> BackupPolicyView {
        try await tick()
        let o = req.order
        let valid = ["phone", "peer", "none"].contains(o.policy) && !o.serverDomain.isEmpty
            && (o.policy == "phone" ? o.phoneReserveBytes > 0 : o.phoneReserveBytes == 0) && o.issuedAt >= 0
        if valid, let limit = limitBytes(BackupPolicyCurrent(policy: o.policy, phoneReserveBytes: o.phoneReserveBytes)),
           policyUsedBytes > limit {
            let sentence = o.policy == "phone"
                ? "This server holds \(Self.formatGb(policyUsedBytes)) of app data, more than the \(Self.formatGb(limit)) your device would keep. Reserve at least \(Self.formatGb(policyUsedBytes)) on that device, or remove apps or data first."
                : "This server holds \(Self.formatGb(policyUsedBytes)) of app data, more than a third of its disk (\(Self.formatGb(limit))), which is all a server may use with peer backups. Remove apps or data first, or choose another policy."
            GymProbe.note("refused backup-policy over limit")
            throw Self.refusal(409, sentence, code: "over-backup-limit")
        }
        guard valid else { throw Self.refusal(400, "that backup policy is malformed") }
        do {
            try MockOrderSigners.shared.require(.sensitive, kind: "backup-policy", signatureHex: req.signatureHex, payload: o)
        } catch {
            throw Self.refusal(403, "only an admin device of this account can set the backup policy")
        }
        if let held = policyCurrent.issuedAt, o.issuedAt <= held {
            if o.issuedAt == held { return policyView() }
            throw Self.refusal(409, "a newer backup policy is already set on this server")
        }
        policyOrders.append(req)
        policyCurrent = BackupPolicyCurrent(policy: o.policy, phoneReserveBytes: o.phoneReserveBytes, issuedAt: o.issuedAt)
        GymProbe.note("set backup-policy \(o.policy) \(o.phoneReserveBytes)")
        return policyView()
    }

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
        GymProbe.note("minted companion ticket")
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let ticketId = (0..<16).map { _ in
            String(format: "%02x", UInt8.random(in: 0...255))
        }.joined()
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
        GymProbe.note("revoked companion \(req.tokenPrefix)")
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

    /// Counts `companionPendingWrites()` invocations so tests can assert the
    /// background poll ticks (and stops on teardown).
    public private(set) var companionPendingWritesCallCount: Int = 0

    public func companionPendingWrites() async throws -> CompanionPendingWritesResponse {
        try await tick()
        companionPendingWritesCallCount += 1
        if let fixture = companionPendingWritesFixture { return fixture }
        return CompanionPendingWritesResponse(pending: [])
    }

    public func companionResolvePending(_ req: CompanionResolvePendingRequest) async throws -> CompanionResolvePendingResponse {
        try await tick()
        companionResolveCalls.append(req)
        GymProbe.note("resolved companion request \(req.requestId) \(req.outcome)")
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

    // MARK: - Build-a-service modes
    //
    // Fixtures mirror the live wire shapes documented in
    // packages/server-daemon/src/buildmodes/buildModesHttp.ts and the
    // webapp views/build-*.js. Hard repo rule: the Mock matches the live
    // JSON byte-for-byte in field names + shapes.

    /// Records each `buildGit` request so tests can assert the wire shape.
    public private(set) var buildGitCalls: [BuildGitRequest] = []
    /// Override the git verdict. Nil → a deterministic verdict keyed off
    /// the URL: a URL containing "flagship" reports FIT, anything else
    /// reports NOT FIT (so both branches are exercisable).
    public var buildGitFixture: BuildGitResponse?

    /// When true, `buildAdapt` throws a 503 ("AI adapt not configured")
    /// so the chooser's fall-back-to-scratch path is testable. Default
    /// false → a clean adapt result.
    public var buildAdaptUnavailable: Bool = false
    public private(set) var buildAdaptCalls: [(buildId: String, req: BuildAdaptRequest)] = []

    public private(set) var buildMcpCreateCalls: [BuildMcpRequest] = []
    public private(set) var buildMcpRotateCalls: [(buildId: String, req: BuildMcpRequest)] = []
    /// Override the MCP connection. Nil → the deterministic default below.
    public var buildMcpFixture: BuildMcpConnection?

    /// Override the env-requests list. Nil → a single non-secret request
    /// fixture (NEVER a value).
    public var buildEnvRequestsFixture: BuildEnvRequestsResponse?

    public private(set) var buildDeployCalls: [String] = []

    /// Answer MCP connections like a box from before per-IDE configs (only `ideConfig`).
    public var mockMcpLegacyConfig = false
    /// Override the past-builds list. Nil → a two-entry default.
    public var buildSessionsFixture: BuildSessionsResponse?
    /// Override the journal. Nil → a small deterministic timeline.
    public var buildJournalFixture: BuildJournalResponse?

    private func mockMcpConnection(buildId: String) -> BuildMcpConnection {
        if let f = buildMcpFixture { return f }
        let url = "https://\(podContext).bright-maple.flagship.services/mcp/build/\(buildId)"
        let key = "fbk_\(UUID().uuidString.prefix(16).lowercased())"
        // The box's shapes (buildOrchestrator `mcpIdeConfigs`).
        let name = "flagship-\(buildId)"
        let headers: [String: Any] = ["Authorization": "Bearer \(key)"]
        func servers(_ entry: [String: Any], key top: String = "mcpServers") -> [String: AnyCodable] {
            [top: AnyCodable([name: entry] as [String: Any])]
        }
        let ideConfig = servers(["type": "http", "url": url, "headers": headers])
        let ideConfigs = [
            McpIdeConfig(id: "claude-code", name: "Claude Code",
                         where: "Run the command in a terminal, or pass the JSON with --mcp-config", config: ideConfig,
                         command: "claude mcp add --scope user --transport http \(name) \(url) --header \"Authorization: Bearer \(key)\""),
            McpIdeConfig(id: "cursor", name: "Cursor",
                         where: "~/.cursor/mcp.json (Cursor Settings → MCP → Add new global MCP server)",
                         config: servers(["url": url, "headers": headers])),
            McpIdeConfig(id: "vscode", name: "VS Code",
                         where: "Your user mcp.json (Command Palette → MCP: Open User Configuration)",
                         config: servers(["type": "http", "url": url, "headers": headers], key: "servers")),
            McpIdeConfig(id: "cline", name: "Cline", where: "Cline → MCP Servers → Configure MCP Servers",
                         config: servers(["type": "streamableHttp", "url": url, "headers": headers])),
        ]
        return BuildMcpConnection(url: url, key: key, ideConfig: ideConfig,
                                  ideConfigs: mockMcpLegacyConfig ? nil : ideConfigs)
    }

    /// Thrown by `buildGit` instead of a verdict (a taken name, a failed clone).
    public var buildGitError: Error?

    public func buildGit(_ req: BuildGitRequest) async throws -> BuildGitResponse {
        try await tick()
        buildGitCalls.append(req)
        GymProbe.note("git check \(req.gitUrl) ref=\(req.ref ?? "-") name=\(req.name ?? "-")")
        if let e = buildGitError { throw e }
        if let f = buildGitFixture { return f }
        let buildId = "bld-\(UUID().uuidString.prefix(8).lowercased())"
        let fit = req.gitUrl.lowercased().contains("flagship")
        if fit {
            return BuildGitResponse(
                buildId: buildId,
                fit: true,
                reason: "Found flagship.app.json",
                manifestName: "imported-app",
                fileCount: 14
            )
        }
        return BuildGitResponse(
            buildId: buildId,
            fit: false,
            reason: "no flagship.app.json — repo isn't a Flagship app yet; the AI can adapt it",
            manifestName: nil,
            fileCount: 23
        )
    }

    public func buildAdapt(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptResponse {
        try await tick()
        buildAdaptCalls.append((buildId, req))
        if buildAdaptUnavailable {
            throw ScreensClientError.http(status: 503, message: "AI adapt not configured")
        }
        return BuildAdaptResponse(ok: true, fileCount: 16)
    }

    /// Background adapts the mock has started; `buildState` reports them done.
    public private(set) var buildAdaptStartCalls: [(buildId: String, req: BuildAdaptRequest)] = []
    /// Override what a polled background adapt reports.
    public var buildAdaptStatusFixture: BuildAdaptStatus?
    public private(set) var buildDiscardCalls: [String] = []
    /// Thrown by `buildAdaptStart` (after recording the call).
    public var buildAdaptStartError: Error?

    public func buildAdaptStart(buildId: String, _ req: BuildAdaptRequest) async throws -> BuildAdaptReply {
        try await tick()
        buildAdaptStartCalls.append((buildId, req))
        GymProbe.note("adapt started share=\(req.share.map { String($0) } ?? "-") provider=\(req.credential?.provider ?? "none")")
        if let e = buildAdaptStartError { throw e }
        if buildAdaptUnavailable {
            throw ScreensClientError.http(status: 503, message: "AI adapt not configured")
        }
        return BuildAdaptReply(ok: true, started: true)
    }

    /// What `buildState` answers for one build, before anything else.
    public var buildStateFixtures: [String: BuildStateResponse] = [:]

    public func buildState(buildId: String) async throws -> BuildStateResponse {
        try await tick()
        if let f = buildStateFixtures[buildId] { return f }
        let adapt = buildAdaptStartCalls.contains { $0.buildId == buildId }
            ? (buildAdaptStatusScript.isEmpty
                ? (buildAdaptStatusFixture ?? BuildAdaptStatus(status: "done", fileCount: 16, deployed: false))
                : buildAdaptStatusScript.removeFirst())
            : nil
        return BuildStateResponse(state: .init(buildId: buildId, mode: "git", adapt: adapt, sealed: buildSealedFixture))
    }

    /// Answered by `buildState` in order, before `buildAdaptStatusFixture`.
    public var buildAdaptStatusScript: [BuildAdaptStatus] = []
    /// What `buildState` reports as `sealed`.
    public var buildSealedFixture: Bool?

    public private(set) var adapterReports: [(serviceId: String, detail: String)] = []
    public func adapterReport(serviceId: String, detail: String) async throws {
        try await tick()
        adapterReports.append((serviceId, detail))
        GymProbe.note("reported adapter for \(serviceId)")
    }

    public func buildAdapterFile(buildId: String) async throws -> String {
        try await tick()
        return #"{"schema_version": 1, "name": "imported-app", "adapter": {"version": 1}}"#
    }

    public func buildDiscard(buildId: String) async throws {
        try await tick()
        buildDiscardCalls.append(buildId)
        GymProbe.note("discarded build \(buildId)")
        buildSessionsFixture = buildSessionsFixture.map {
            BuildSessionsResponse(builds: $0.builds.filter { $0.buildId != buildId })
        }
    }

    public func buildMcpCreate(_ req: BuildMcpRequest) async throws -> BuildMcpResponse {
        try await tick()
        buildMcpCreateCalls.append(req)
        GymProbe.note("mcp created")
        let buildId = "bld-\(UUID().uuidString.prefix(8).lowercased())"
        return BuildMcpResponse(buildId: buildId, connection: mockMcpConnection(buildId: buildId))
    }

    public func buildMcpInfo(buildId: String) async throws -> BuildMcpConnection {
        try await tick()
        return mockMcpConnection(buildId: buildId)
    }

    public func buildMcpRotate(buildId: String, _ req: BuildMcpRequest) async throws -> BuildMcpConnection {
        try await tick()
        buildMcpRotateCalls.append((buildId, req))
        GymProbe.note("mcp rotated \(buildId)")
        // A fresh key each rotate (unless a fixture pins it).
        if let f = buildMcpFixture { return f }
        return mockMcpConnection(buildId: buildId)
    }

    public func buildEnvRequests(buildId: String) async throws -> BuildEnvRequestsResponse {
        try await tick()
        if let f = buildEnvRequestsFixture { return f }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return BuildEnvRequestsResponse(requests: [
            BuildEnvRequest(
                name: "STRIPE_SECRET_KEY",
                why: "to take payments in the app",
                secret: true,
                requestedAt: now - 60_000,
                requestedBy: "ide",
                currentlySet: false
            )
        ])
    }

    /// Thrown by `buildDeploy` instead of installing.
    public var buildDeployError: Error?

    public func buildDeploy(buildId: String) async throws -> BuildDeployResponse {
        try await tick()
        buildDeployCalls.append(buildId)
        if let e = buildDeployError { throw e }
        GymProbe.note("deployed build \(buildId)")
        return BuildDeployResponse(
            ok: true,
            serviceId: "bright-maple-imported-app",
            url: "https://imported-app.\(podContext).bright-maple.flagship.services/"
        )
    }

    public func buildSessions() async throws -> BuildSessionsResponse {
        try await tick()
        if let f = buildSessionsFixture { return f }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return BuildSessionsResponse(builds: [
            BuildSummary(
                buildId: "bld-plants01",
                mode: "scratch",
                serviceId: "bright-maple--plants",
                startedAt: now - 60_000 * 60,
                lastAt: now - 60_000 * 58,
                entryCount: 9,
                lastKind: "deployed"
            ),
            BuildSummary(
                buildId: "bld-wiki0002",
                mode: "git",
                serviceId: nil,
                startedAt: now - 60_000 * 10,
                lastAt: now - 60_000 * 9,
                entryCount: 3,
                lastKind: "fitness-check"
            ),
        ])
    }

    public func buildJournal(buildId: String) async throws -> BuildJournalResponse {
        try await tick()
        if let f = buildJournalFixture { return f }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return BuildJournalResponse(entries: [
            BuildJournalEntry(
                seq: 1, ts: now - 60_000 * 60, buildId: buildId,
                mode: "scratch", kind: "session-started", actor: "owner",
                summary: "Build a houseplant watering tracker"
            ),
            BuildJournalEntry(
                seq: 2, ts: now - 60_000 * 59, buildId: buildId,
                mode: "scratch", kind: "file-written", actor: "ai",
                summary: "wrote flagship.app.json", detail: "name: plants"
            ),
            BuildJournalEntry(
                seq: 3, ts: now - 60_000 * 58, buildId: buildId,
                mode: "scratch", kind: "deployed", actor: "system",
                summary: "deployed to home pod", serviceId: "bright-maple--plants"
            ),
        ])
    }
}

private extension Calendar {
    /// 0 = Sunday ... 6 = Saturday of the UTC day holding `ms`.
    static func mockUtcWeekday(_ ms: Int64) -> Int {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c.component(.weekday, from: Date(timeIntervalSince1970: Double(ms) / 1000)) - 1
    }
}
#endif
