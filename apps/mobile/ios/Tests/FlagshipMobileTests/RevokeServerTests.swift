import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore

/// P13 — per-server kill-switch.
///
/// Tests the canonical-bytes shape, the Mock client recording, the
/// RevokeServerViewModel happy-path and error-mapping, and the wire
/// equivalence with the @flagship/protocol byte order.
final class RevokeServerTests: XCTestCase {

    // MARK: - Canonical bytes

    func test_canonicalBytes_followsV1Format() {
        let s = String(
            data: ServerRevocationClaim.canonicalBytes(
                userId: "harry",
                revokedServerId: "home.harry.flagship.services",
                reason: "stolen",
                issuedAt: 42
            ),
            encoding: .utf8
        )
        // MUST match packages/protocol/src/auth.ts canonicalRevoke
        // byte-for-byte:
        //   tag | userId | revokedServerId | reason | issuedAt
        XCTAssertEqual(
            s,
            "flagship/revoke/v1|harry|home.harry.flagship.services|stolen|42"
        )
    }

    func test_canonicalTag_matchesProtocol() {
        XCTAssertEqual(ServerRevocationClaim.canonicalTag, "flagship/revoke/v1")
    }

    func test_reasonVocabulary_isFixed() {
        XCTAssertEqual(ServerRevocationClaim.reasons, ["lost", "stolen", "decommissioned"])
    }

    func test_signatureVerifiesUnderIrkPublicKey() throws {
        let irk = Curve25519.Signing.PrivateKey()
        let bytes = ServerRevocationClaim.canonicalBytes(
            userId: "harry",
            revokedServerId: "home.harry.flagship.services",
            reason: "lost",
            issuedAt: 1
        )
        let sig = try irk.signature(for: bytes)
        XCTAssertTrue(irk.publicKey.isValidSignature(sig, for: bytes))
        // Round-trip through hex (the wire form).
        let sigHex = HexUtil.encode(sig)
        let sigBytes = try XCTUnwrap(HexUtil.decode(sigHex))
        XCTAssertTrue(irk.publicKey.isValidSignature(sigBytes, for: bytes))
    }

    func test_eachReasonProducesADistinctCanonical() {
        let a = ServerRevocationClaim.canonicalBytes(
            userId: "u", revokedServerId: "s", reason: "lost", issuedAt: 1
        )
        let b = ServerRevocationClaim.canonicalBytes(
            userId: "u", revokedServerId: "s", reason: "stolen", issuedAt: 1
        )
        let c = ServerRevocationClaim.canonicalBytes(
            userId: "u", revokedServerId: "s", reason: "decommissioned", issuedAt: 1
        )
        XCTAssertNotEqual(a, b)
        XCTAssertNotEqual(b, c)
        XCTAssertNotEqual(a, c)
    }

    // MARK: - Mock client integration

    func test_mockServer_recordsRevokeCalls() async throws {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        try await c.revokeServer(.init(
            request: .init(
                userId: "harry",
                revokedServerId: "home.harry.flagship.services",
                reason: "stolen",
                issuedAt: 7
            ),
            signature: "deadbeef"
        ))
        XCTAssertEqual(c.revokedServers.count, 1)
        XCTAssertEqual(c.revokedServers.first?.request.userId, "harry")
        XCTAssertEqual(
            c.revokedServers.first?.request.revokedServerId,
            "home.harry.flagship.services"
        )
        XCTAssertEqual(c.revokedServers.first?.request.reason, "stolen")
        XCTAssertEqual(c.revokedServers.first?.request.issuedAt, 7)
    }

    // MARK: - RevokeServerViewModel happy-path

    @MainActor
    func test_viewModel_signsAndPostsExactlyOnce() async throws {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let irk = Curve25519.Signing.PrivateKey()

        let vm = RevokeServerViewModel(
            server: mock,
            serverDomain: "home.harry.flagship.services",
            username: { "harry" },
            signer: { _ in irk }
        )
        await vm.run(reason: .stolen)

        guard case .completed = vm.phase else {
            XCTFail("expected .completed, got \(vm.phase)")
            return
        }
        XCTAssertEqual(mock.revokedServers.count, 1)
        let recorded = try XCTUnwrap(mock.revokedServers.first)
        XCTAssertEqual(recorded.request.userId, "harry")
        XCTAssertEqual(recorded.request.revokedServerId, "home.harry.flagship.services")
        XCTAssertEqual(recorded.request.reason, "stolen")
        XCTAssertEqual(recorded.signature.count, 128) // 64-byte Ed25519 → 128 hex chars

        // The recorded signature must verify against the canonical
        // bytes the view-model computed.
        let canonical = ServerRevocationClaim.canonicalBytes(
            userId: recorded.request.userId,
            revokedServerId: recorded.request.revokedServerId,
            reason: recorded.request.reason,
            issuedAt: recorded.request.issuedAt
        )
        let sigBytes = try XCTUnwrap(HexUtil.decode(recorded.signature))
        XCTAssertTrue(irk.publicKey.isValidSignature(sigBytes, for: canonical))
    }

    @MainActor
    func test_viewModel_eachReason_landsExactValueOnTheWire() async throws {
        let irk = Curve25519.Signing.PrivateKey()
        for reason in RevokeServerViewModel.Reason.allCases {
            let mock = MockFlagshipServerClient()
            mock.simulatedLatency = 0
            let vm = RevokeServerViewModel(
                server: mock,
                serverDomain: "home.alice.flagship.services",
                username: { "alice" },
                signer: { _ in irk }
            )
            await vm.run(reason: reason)
            XCTAssertEqual(mock.revokedServers.first?.request.reason, reason.rawValue)
        }
    }

    @MainActor
    func test_viewModel_noUsername_failsImmediately() async {
        let mock = MockFlagshipServerClient()
        mock.simulatedLatency = 0
        let vm = RevokeServerViewModel(
            server: mock,
            serverDomain: "home.harry.flagship.services",
            username: { nil },
            signer: { _ in Curve25519.Signing.PrivateKey() }
        )
        await vm.run(reason: .lost)
        if case .failed = vm.phase {} else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertTrue(mock.revokedServers.isEmpty)
    }

    // MARK: - Error mapping

    /// A failing mock used only to drive error mapping. We can't
    /// easily make MockFlagshipServerClient return arbitrary HTTP
    /// codes per call without intrusive changes, so use a tiny
    /// ad-hoc throw-through.
    final class ThrowingServer: FlagshipServerClient, @unchecked Sendable {
        var error: any Error
        init(error: any Error) { self.error = error }
        func claimUsername(_ req: UsernameClaimRequest) async throws { throw error }
        func issueAuthCode(_ req: AuthCodeIssueRequest) async throws { throw error }
        func registerRck(_ req: RckRegisterRequest) async throws { throw error }
        func revokeAuthCode(_ req: AuthCodeRevokeRequest) async throws { throw error }
        func releaseServerName(_ req: ReleaseServerNameRequest) async throws { throw error }
        func revokeServer(_ req: ServerRevocationRequest) async throws { throw error }
        func usernameAvailable(_ username: String) async throws -> UsernameAvailabilityResponse { throw error }
        func resolveAccount(username: String) async throws -> AccountResolution { throw error }
        func registerRecoveryEnvelope(_ req: RecoveryUploadRequest) async throws -> RecoveryEnvelopeResponse { throw error }
        func fetchRecoveryEnvelope(credentialId: String) async throws -> RecoveryEnvelope { throw error }
        func fetchWrappedUmk(username: String, fetchTokenHex: String) async throws -> RecoveryFetchResponse { throw error }
        func registerPushToken(_ req: PushTokenRegisterRequest) async throws -> PushTokenRegisterResponse { throw error }
        func revokePushToken(tokenId: String) async throws { throw error }
        func admitDevice(account: String, body: DeviceAdmitRequest) async throws -> DeviceAdmitResponse { throw error }
        func getInstallEvents(serial: String, since: Int) async throws -> InstallEventsPollResponse { throw error }
        func listDevices(username: String) async throws -> TrustedDevicesListResponse { throw error }
        func mintWatchDelegate(username: String, body: WatchDelegateMintRequest) async throws -> WatchDelegateMintResponse { throw error }
        func listWatchDelegates(username: String) async throws -> WatchDelegatesListResponse { throw error }
        func revokeWatchDelegate(username: String, body: WatchDelegateRevokeRequest) async throws { throw error }
        func listAuditEvents(username: String, sinceSeq: Int, limit: Int) async throws -> AuditEventListResponse { throw error }
        func hasCloudRecovery(username: String) async throws -> Bool { throw error }
        func initiateRePair(username: String, body: RePairInitiateRequest, ifMatch: String?) async throws -> RePairInitiateResponse { throw error }
        func completeRePair(username: String) async throws -> RePairCompleteResponse { throw error }
        func wipeRestart(username: String, body: WipeRestartRequest, ifMatch: String?) async throws -> WipeRestartResponse { throw error }
        func renameApp(username: String, serviceId: String, body: AppRenameRequest) async throws -> AppRenameResponse { throw error }
        func getAppLinks(username: String, serviceId: String) async throws -> AppLinksResponse { throw error }
        func setCustomDomain(username: String, serviceId: String, body: SetCustomDomainRequest) async throws -> AppLinksResponse { throw error }
        func getUsernameRecord(username: String) async throws -> UsernameLookupResponse { throw error }
        func totpEnrollBegin(username: String, body: TotpEnrollBeginRequest) async throws -> TotpEnrollBeginResponse { throw error }
        func totpEnrollConfirm(username: String, body: TotpEnrollConfirmRequest) async throws -> TotpEnrollConfirmResponse { throw error }
        func totpDisable(username: String, body: TotpDisableRequest) async throws -> TotpDisableResponse { throw error }
        func fetchProvisionStatus(serial: String) async throws -> ProvisionStatus? { throw error }
        func listOutstandingOrders(_ req: OutstandingOrdersRequest) async throws -> OutstandingOrdersResponse { throw error }
    }

    @MainActor
    func test_viewModel_maps403_toFriendlyMessage() async {
        let server = ThrowingServer(error: ScreensClientError.http(status: 403, message: "stale"))
        let irk = Curve25519.Signing.PrivateKey()
        let vm = RevokeServerViewModel(
            server: server,
            serverDomain: "home.harry.flagship.services",
            username: { "harry" },
            signer: { _ in irk }
        )
        await vm.run(reason: .stolen)
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.lowercased().contains("rejected"), "got: \(msg)")
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }

    @MainActor
    func test_viewModel_maps404_toAlreadyGone() async {
        let server = ThrowingServer(error: ScreensClientError.http(status: 404, message: "gone"))
        let irk = Curve25519.Signing.PrivateKey()
        let vm = RevokeServerViewModel(
            server: server,
            serverDomain: "home.harry.flagship.services",
            username: { "harry" },
            signer: { _ in irk }
        )
        await vm.run(reason: .decommissioned)
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.lowercased().contains("already gone"), "got: \(msg)")
        } else {
            XCTFail("expected .failed, got \(vm.phase)")
        }
    }
}
