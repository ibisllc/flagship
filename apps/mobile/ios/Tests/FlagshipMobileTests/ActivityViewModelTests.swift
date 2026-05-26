import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

@MainActor
final class ActivityViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    func test_load_idleSnapshotHasNilPostRecovery() async {
        let client = makeClient()
        let vm = ActivityViewModel(client: client)
        await vm.load()
        guard case .loaded(let feed) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertNil(feed.postRecovery)
    }

    func test_load_surfacesPostRecoveryReport_whenDaemonReturnsOne() async {
        let client = makeClient()
        client.postRecoveryReport = PostRecoverySnapshot(
            currentIrkPubHex: "abcd",
            state: WatcherState(
                lastSeen: nil,
                lastSwapTo: "abcd",
                lastSwapAt: 1_700_000_000_000,
                lastPolledAt: 1_700_000_001_000,
                lastError: nil
            ),
            lastReissue: ReissuanceReportPayload(
                startedAt: 1_700_000_002_000,
                completedAt: 1_700_000_003_000,
                status: "complete",
                oldIrkPrefix: "old123456789",
                newIrkPrefix: "new123456789",
                apps: [],
                totalRewritten: 7,
                reattachedCount: 3,
                unchangedCount: 0,
                undoWindowExpiresAt: 1_700_604_802_000
            )
        )
        let vm = ActivityViewModel(client: client)
        await vm.load()
        guard case .loaded(let feed) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertNotNil(feed.postRecovery)
        XCTAssertEqual(feed.postRecovery?.lastReissue?.totalRewritten, 7)
        XCTAssertEqual(feed.postRecovery?.lastReissue?.reattachedCount, 3)
    }

    func test_load_isResilientToPostRecoveryFailure() async {
        // A daemon that doesn't ship P1.23 returns non-2xx for the
        // post-recovery endpoint. The feed should still load — the
        // other three calls (detail/unlocks/sessions) carry the
        // primary content. Mirrors the try/catch in webapp's
        // activity.js fan-out.
        let client = FailingPostRecoveryClient(real: makeClient())
        let vm = ActivityViewModel(client: client)
        await vm.load()
        guard case .loaded(let feed) = vm.state else {
            XCTFail("expected loaded despite recovery failure, got \(vm.state)"); return
        }
        XCTAssertNil(feed.postRecovery)
        XCTAssertFalse(feed.recentInstalls.isEmpty, "real install events should still flow")
    }
}

/// Test double that proxies to a real MockScreensClient but throws
/// from postRecoveryStatus(). Confirms the ViewModel's fan-out
/// tolerates a daemon without P1.23.
private final class FailingPostRecoveryClient: ScreensClient, @unchecked Sendable {
    let real: MockScreensClient
    init(real: MockScreensClient) { self.real = real }

    func serverDetail() async throws -> ServerDetailResponse { try await real.serverDetail() }
    func appsList() async throws -> AppsListResponse { try await real.appsList() }
    func appDetail(serviceId: String) async throws -> AppDetailResponse { try await real.appDetail(serviceId: serviceId) }
    func marketplaceBrowse() async throws -> MarketplaceBrowseResponse { try await real.marketplaceBrowse() }
    func vibeCodeStart(_ req: VibeCodeStartRequest) async throws -> VibeCodeStartResponse {
        try await real.vibeCodeStart(req)
    }
    func vibeCodeStatus(sessionId: String) async throws -> VibeCodeStatusResponse {
        try await real.vibeCodeStatus(sessionId: sessionId)
    }
    func browserTabsList(serviceId: String) async throws -> BrowserTabsListResponse {
        try await real.browserTabsList(serviceId: serviceId)
    }
    func pairedSessionsList() async throws -> PairedSessionsListResponse {
        try await real.pairedSessionsList()
    }
    func revokePairedSession(tokenPrefix: String) async throws {
        try await real.revokePairedSession(tokenPrefix: tokenPrefix)
    }
    func ordersSend(_ req: OrdersSendRequest) async throws -> OrdersSendResponse {
        try await real.ordersSend(req)
    }
    func tierStatus() async throws -> TierStatusResponse { try await real.tierStatus() }
    func peerBackupStatus() async throws -> PeerBackupStatusResponse { try await real.peerBackupStatus() }
    func peerBackupToggle(participate: Bool) async throws -> PeerBackupStatusResponse { try await real.peerBackupToggle(participate: participate) }
    func urlControllerOwned() async throws -> UrlControllerOwnedResponse {
        try await real.urlControllerOwned()
    }
    func urlControllerClaim(_ req: UrlControllerClaimRequest) async throws -> UrlControllerClaimResponse {
        try await real.urlControllerClaim(req)
    }
    func appBackupStart(_ req: AppBackupStartRequest) async throws -> AppBackupStartResponse {
        try await real.appBackupStart(req)
    }
    func serverMetrics(podId: String) async throws -> ServerMetricsResponse {
        try await real.serverMetrics(podId: podId)
    }
    func installEvents(serial: String) -> AsyncStream<InstallEvent> {
        real.installEvents(serial: serial)
    }
    func vibeCodeStream(sessionId: String) -> AsyncStream<VibeCodeFrame> {
        real.vibeCodeStream(sessionId: sessionId)
    }
    func verifyCustomDomain(_ req: VerifyCustomDomainRequest) async throws -> VerifyCustomDomainResponse {
        try await real.verifyCustomDomain(req)
    }
    func postRecoveryStatus() async throws -> PostRecoveryStatusResponse {
        throw ScreensClientError.http(status: 503, message: "daemon does not implement P1.23")
    }
    func serviceEnvList(appId: String) async throws -> ServiceEnvListResponse {
        try await real.serviceEnvList(appId: appId)
    }
    func serviceEnvSet(appId: String, _ req: ServiceEnvSetRequest) async throws -> ServiceEnvOpResponse {
        try await real.serviceEnvSet(appId: appId, req)
    }
    func serviceEnvUnset(appId: String, _ req: ServiceEnvUnsetRequest) async throws -> ServiceEnvOpResponse {
        try await real.serviceEnvUnset(appId: appId, req)
    }
    func vibeCodeSessionState(sessionId: String) async throws -> VibeCodeSessionPublicState {
        try await real.vibeCodeSessionState(sessionId: sessionId)
    }
    func vibeCodeSessionReply(sessionId: String, _ req: VibeCodeReplyRequest) async throws -> VibeCodeReplyResponse {
        try await real.vibeCodeSessionReply(sessionId: sessionId, req)
    }
}
