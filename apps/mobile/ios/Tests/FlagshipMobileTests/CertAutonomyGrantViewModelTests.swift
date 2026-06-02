import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship
@testable import FlagshipAPI

/// #28 seal-to-box — `CertAutonomyGrantViewModel` orchestration: it must
/// (a) re-resolve the box STK from the pods directory, (b) build a grant
/// SEALED to that exact STK + IRK-signed, and (c) deliver it to the
/// domain-scoped endpoint with the `{ grant, signature }` body.
///
/// The canonical-bytes / IRK-signature KAT for the grant itself already
/// lives in `AcmeAccountKeyGrantTests` — this file does NOT duplicate it;
/// it exercises the view-model wiring with deterministic injected crypto
/// (no Secure Enclave), mirroring `RevokeServerTests`.
@MainActor
final class CertAutonomyGrantViewModelTests: XCTestCase {

    // Box STK: seed 32×0x07 → Ed25519 pub ea4a6c63… (shared with the KAT).
    private let stkSeed = Data(repeating: 0x07, count: 32)
    private var stkPubHex: String {
        let pub = try! Curve25519.Signing.PrivateKey(rawRepresentation: stkSeed).publicKey.rawRepresentation
        return HexUtil.encode(pub)
    }
    // A well-formed P-256 scalar (0x00..0x02) so the producer re-hydrates.
    private let scalar = Data(repeating: 0x00, count: 31) + Data([0x02])
    // IRK seed 32×0x03.
    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x03, count: 32))
    }

    private let domain = "home.demo1234.flagship.services"

    private func makeMailbox(withEntry: Bool = true) -> MockSecretMailboxClient {
        let m = MockSecretMailboxClient()
        if withEntry {
            m.directory = [PodDirectoryEntry(serverDomain: domain, identityPubKey: stkPubHex)]
        }
        return m
    }

    private func makeVM(
        server: FlagshipServerClient,
        mailbox: SecretMailboxClient,
        scalar providedScalar: Data?
    ) -> CertAutonomyGrantViewModel {
        let captured = providedScalar
        return CertAutonomyGrantViewModel(
            server: server,
            mailbox: mailbox,
            serverDomain: domain,
            username: { "demo1234" },
            accountKeyScalarProvider: { captured },
            signer: { [irk = irk()] _ in irk }
        )
    }

    // MARK: - Happy path: correct body, sealed to the box STK, delivered.

    func test_grant_buildsSealedSignedBody_andDeliversToDomain() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server: server, mailbox: makeMailbox(), scalar: scalar)

        await vm.grant()

        guard case .completed(let accountKeyId) = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }

        // Exactly one delivery, targeting the domain-scoped serverDomain.
        XCTAssertEqual(server.grantedAcmeAutonomy.count, 1)
        let (sentDomain, body) = server.grantedAcmeAutonomy[0]
        XCTAssertEqual(sentDomain, domain)

        // recipientPubKey == the box STK from the directory (not an echo).
        XCTAssertEqual(body.grant.recipientPubKey, stkPubHex)
        // accountKeyId present + non-empty, and echoed back by the cloud.
        XCTAssertFalse(body.grant.accountKeyId.isEmpty)
        XCTAssertEqual(accountKeyId, body.grant.accountKeyId)
        XCTAssertEqual(body.grant.username, "demo1234")
        // Sealed key + signature rode the body.
        XCTAssertFalse(body.grant.sealedAccountKey.isEmpty)
        XCTAssertEqual(body.signature.count, 128) // 64-byte Ed25519, hex

        // The grant's IRK signature verifies under the injected IRK over the
        // reconstructed canonical bytes — proving the body is internally
        // consistent (not just shaped right).
        let rebuilt = AcmeAccountKeyGrant(
            grantId: body.grant.grantId,
            username: body.grant.username,
            accountKeyId: body.grant.accountKeyId,
            recipientPubKey: HexUtil.decode(body.grant.recipientPubKey)!,
            sealedAccountKey: HexUtil.decode(body.grant.sealedAccountKey)!,
            issuedAt: body.grant.issuedAt,
            expiresAt: body.grant.expiresAt
        )
        XCTAssertTrue(
            rebuilt.verify(
                signature: HexUtil.decode(body.signature)!,
                irkPub: irk().publicKey.rawRepresentation
            )
        )
    }

    /// The sealed key in the delivered body actually opens with the box's
    /// STK seed back to the SAME account key — the whole seal-to-box point.
    func test_grant_sealedKeyOpensWithBoxStkSeed() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server: server, mailbox: makeMailbox(), scalar: scalar)

        await vm.grant()
        guard case .completed = vm.phase else { return XCTFail("got \(vm.phase)") }
        let body = server.grantedAcmeAutonomy[0].body

        let openedPem = try SecretSeal.openWithEd25519Seed(
            blob: HexUtil.decode(body.grant.sealedAccountKey)!,
            recipientEd25519Seed: stkSeed
        )
        let recovered = try P256.Signing.PrivateKey(pemRepresentation: String(data: openedPem, encoding: .utf8)!)
        XCTAssertEqual(recovered.rawRepresentation, scalar)
    }

    // MARK: - Failure branches (no POST is attempted).

    func test_grant_failsWhenNoAccountKeyOnDevice() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server: server, mailbox: makeMailbox(), scalar: nil)

        await vm.grant()

        guard case .failed = vm.phase else { return XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertTrue(server.grantedAcmeAutonomy.isEmpty)
    }

    func test_grant_failsWhenBoxNotInDirectory() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server: server, mailbox: makeMailbox(withEntry: false), scalar: scalar)

        await vm.grant()

        guard case .failed = vm.phase else { return XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertTrue(server.grantedAcmeAutonomy.isEmpty)
    }

    func test_grant_mapsServer403_toFriendlyMessage() async {
        let server = FailingServer(error: ScreensClientError.http(status: 403, message: "bad sig"))
        let vm = makeVM(server: server, mailbox: makeMailbox(), scalar: scalar)

        await vm.grant()

        guard case .failed(let msg) = vm.phase else { return XCTFail("got \(vm.phase)") }
        XCTAssertTrue(msg.lowercased().contains("rejected"), "got: \(msg)")
    }

    // MARK: - Live client targets the exact domain-scoped URL + body.

    /// `LiveFlagshipServerClient.grantAcmeAccountKeyAutonomy` POSTs to
    /// `/api/server/<serverDomain>/acme-account-key` with the `{grant,
    /// signature}` body and decodes `{ ok, accountKeyId }`.
    func test_liveClient_postsDomainScopedPath_andDecodesReply() async throws {
        let body = AcmeAccountKeyGrantMintRequest(
            grant: .init(
                grantId: "00000000-0000-4000-8000-000000000001",
                username: "demo1234",
                accountKeyId: "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c",
                recipientPubKey: stkPubHex,
                sealedAccountKey: "0102030405",
                issuedAt: 1_700_000_000_000,
                expiresAt: 1_700_000_000_000 + 90 * 86_400_000
            ),
            signature: String(repeating: "00", count: 64)
        )

        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.url?.path, "/api/server/home.demo1234.flagship.services/acme-account-key")
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/2", headerFields: nil)!
            let reply = try JSONEncoder().encode(AcmeAccountKeyAutonomyResponse(
                ok: true,
                accountKeyId: "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c"
            ))
            return (resp, reply)
        }
        defer { StubURLProtocol.handler = nil }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let client = LiveFlagshipServerClient(urlSession: session)

        let r = try await client.grantAcmeAccountKeyAutonomy(serverDomain: domain, body: body)
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.accountKeyId, "a9f300eb5960e89133af7362011a1e26f0e2ea2e36dc402a04af6c192b891a8c")
    }
}

/// A minimal `FlagshipServerClient` that throws a fixed error from the
/// autonomy-grant call (so the VM's HTTP-status mapping can be exercised
/// without a Stub server). Everything else no-ops / throws.
private final class FailingServer: FlagshipServerClient, @unchecked Sendable {
    let error: any Error
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
    func grantAcmeAccountKeyAutonomy(serverDomain: String, body: AcmeAccountKeyGrantMintRequest) async throws -> AcmeAccountKeyAutonomyResponse { throw error }
}
