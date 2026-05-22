import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Phase 5 — never-404 audit + decision-matrix CONFORMANCE.
///
/// The sign-in / join space is access-control evaluation, not a fetch:
/// it reads what credentials and factors are present for a named account
/// and routes accordingly. A raw `404` here is a category error — every
/// "absent" is a node in the decision tree, surfaced as a STATE, not an
/// HTTP-error card. (`docs/login-and-account-redesign.md`.)
///
/// The per-VM unit suites (LoginViewModelTests, RealAccountLoginViewModel-
/// Tests, Phase3bPairingTests, QuarantineIndicatorTests) each pin one
/// surface. This suite is the consolidated CONTRACT: it walks the full
/// `AccountResolution` decision matrix from a single table and asserts
/// the END-TO-END routing each row produces, plus that the Mock wire
/// matches the Worker's (`packages/control-plane/src/accountResolve.ts`)
/// byte-shape so the iOS-Mock-matches-Worker-wire invariant holds.
///
/// The matrix (mirrors the doc's "unified login decision tree"):
///
///   kind     recovery  → LoginViewModel outcome → real-account branch
///   ───────  ────────    ─────────────────────   ──────────────────────
///   demo     n/a         .demo                    (activate sandbox)
///   unknown  n/a         .unknown   (clean STATE) —
///   single   absent      .realAccount             .noRecovery(multi:false)
///   single   present     .realAccount             .singleTakeover  (7d)
///   multi    absent      .realAccount             .noRecovery(multi:true)
///   multi    present     .realAccount             .multiTakeover   (24h+TOTP)
@MainActor
final class LoginDecisionMatrixConformanceTests: XCTestCase {

    // MARK: - Fixtures

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func demoBlock(_ username: String) -> DemoServerBlock {
        DemoServerBlock(fqdn: "home.\(username).flagship.services", status: "up", ttlIdleMinutes: 30)
    }

    /// Seed a real claimed account with the given account-type / recovery
    /// / totp factors so `resolveAccount` projects the matching kind. The
    /// Mock derives kind + graceModel from these stores exactly as the
    /// Worker derives them from `users.account_type` + `webauthn_recovery`.
    private func seedAccount(
        _ server: MockFlagshipServerClient,
        username: String,
        multi: Bool,
        recovery: Bool,
        totp: Bool = false
    ) async throws {
        try await server.claimUsername(.init(
            request: .init(username: username, irkPub: "deadbeef", issuedAt: 1),
            signature: "sig"
        ))
        if multi { server.accountTypeByUser[username] = "multi" }
        if totp { server.totpEnrolledAtByUser[username] = 123 }
        server.cloudRecoveryByUser[username] = recovery
        if recovery {
            // A recovery envelope so the resolve's recovery.present is true.
            _ = try await server.registerRecoveryEnvelope(.init(
                credentialId: "cred-\(username)",
                wrappedUmkBase64: "AA==",
                nonceBase64: "AA=="
            ))
        }
    }

    // MARK: - 1. resolve never throws for an absent account (NEVER-404)

    /// The single most load-bearing invariant of the whole redesign: a
    /// missing account is a `.unknown` VALUE, not a thrown 404. We assert
    /// it on the Mock wire AND through the LoginViewModel router.
    func test_neverThrows_missingAccount_resolvesUnknown_notError() async {
        let server = makeServer()
        // Mock wire: must NOT throw.
        do {
            let r = try await server.resolveAccount(username: "ghostuser")
            XCTAssertEqual(r.kind, .unknown)
            XCTAssertFalse(r.exists)
        } catch {
            return XCTFail("resolveAccount MUST NOT throw for a missing account; threw \(error)")
        }
        // Router: a missing account lands on .resolved(.unknown), never .failed.
        let vm = LoginViewModel(server: server)
        await vm.submit("ghostuser")
        guard case .resolved(.unknown(let u)) = vm.phase else {
            return XCTFail("missing account must route to .resolved(.unknown), got \(vm.phase)")
        }
        XCTAssertEqual(u, "ghostuser")
        if case .failed = vm.phase { XCTFail("an absent account must never be a .failed error state") }
    }

    /// A real transport/5xx outage is the ONLY thing that lands on
    /// `.failed` — it must NOT masquerade as `.unknown` (which would tell
    /// the user "no such account" when the truth is "we couldn't ask").
    func test_neverThrows_transportOutage_isFailed_notUnknown() async {
        let server = makeServer()
        server.shouldFail = true
        let vm = LoginViewModel(server: server)
        await vm.submit("harry")
        guard case .failed = vm.phase else {
            return XCTFail("a 5xx outage must land on .failed, got \(vm.phase)")
        }
        if case .resolved(.unknown) = vm.phase {
            XCTFail("a transport outage must never resolve to .unknown")
        }
    }

    // MARK: - 2. demo → activate (crypto no-op; username is the capability)

    func test_demo_routesToDemoOutcome_andActivatesSandbox() async {
        let server = makeServer()
        server.demoServers = ["demo-alice": demoBlock("demo-alice")]
        let vm = LoginViewModel(server: server)
        await vm.submit("demo-alice")
        guard case .resolved(.demo(let u, let block)) = vm.phase else {
            return XCTFail("demo must route to .resolved(.demo), got \(vm.phase)")
        }
        XCTAssertEqual(u, "demo-alice")
        XCTAssertEqual(block?.fqdn, "home.demo-alice.flagship.services")
        // The host's demo action (OnboardingFlow.onDemo) opens the sandbox.
        let app = AppState()
        DemoFixtures.activate(app, username: u, demoServer: block)
        XCTAssertTrue(app.isPaired)
        XCTAssertEqual(app.currentUser, "demo-alice")
    }

    // MARK: - 3. unknown → clean STATE (no error card)

    func test_unknown_routesToUnknownState() async {
        let vm = LoginViewModel(server: makeServer())
        await vm.submit("nobodyhere")
        guard case .resolved(.unknown(let u)) = vm.phase else {
            return XCTFail("unknown must route to .resolved(.unknown), got \(vm.phase)")
        }
        XCTAssertEqual(u, "nobodyhere")
    }

    // MARK: - 4. single → takeover branch (7-day grace, no second factor)

    func test_single_withRecovery_routesToSingleTakeover_7d() async throws {
        let server = makeServer()
        try await seedAccount(server, username: "harry", multi: false, recovery: true)
        let r = try await server.resolveAccount(username: "harry")
        XCTAssertEqual(r.kind, .single)
        XCTAssertEqual(r.graceModel, .sevenDay)
        XCTAssertTrue(r.recovery.present)

        // LoginViewModel hands single/multi to the real-account branch.
        let login = LoginViewModel(server: server)
        await login.submit("harry")
        guard case .resolved(.realAccount(let resolution)) = login.phase else {
            return XCTFail("single must route to .realAccount, got \(login.phase)")
        }
        // The real-account state machine derives the single-takeover branch.
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(resolution), .singleTakeover)
    }

    // MARK: - 5. multi → TOTP-gated takeover branch (24h grace)

    func test_multi_withRecovery_routesToMultiTakeover_24hTotp() async throws {
        let server = makeServer()
        try await seedAccount(server, username: "hilton", multi: true, recovery: true, totp: true)
        let r = try await server.resolveAccount(username: "hilton")
        XCTAssertEqual(r.kind, .multi)
        XCTAssertEqual(r.graceModel, .twentyFourHourTotp)
        XCTAssertTrue(r.totpEnrolled, "multi ⇒ totpEnrolled invariant")

        let login = LoginViewModel(server: server)
        await login.submit("hilton")
        guard case .resolved(.realAccount(let resolution)) = login.phase else {
            return XCTFail("multi must route to .realAccount, got \(login.phase)")
        }
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(resolution), .multiTakeover)
    }

    /// The multi takeover REQUIRES a second factor before it can initiate —
    /// an empty field fails CLEANLY (a state), it does not crash or 404.
    func test_multi_takeover_emptySecondFactor_failsCleanly_noRePair() async throws {
        let server = makeServer()
        try await seedAccount(server, username: "hilton", multi: true, recovery: true, totp: true)
        let r = try await server.resolveAccount(username: "hilton")
        let vm = RealAccountLoginViewModel(resolution: r, server: server, webAuthn: MockWebAuthnProvider())
        await vm.startTakeover()   // no secondFactorInput typed
        guard case .failed = vm.phase else {
            return XCTFail("empty second factor must fail cleanly, got \(vm.phase)")
        }
        XCTAssertNil(server.lastRePairInitiate, "no second factor ⇒ no re-pair initiated")
    }

    // MARK: - 6. recovery.present == false → clean STATE (single AND multi)

    func test_singleNoRecovery_routesToNoRecoveryState_notError() async throws {
        let server = makeServer()
        try await seedAccount(server, username: "harry", multi: false, recovery: false)
        let r = try await server.resolveAccount(username: "harry")
        XCTAssertEqual(r.kind, .single)
        XCTAssertFalse(r.recovery.present)
        // Branch is a STATE (no ceremony), with single copy.
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .noRecovery(multi: false))

        // startTakeover on a no-recovery branch is a NO-OP — the host
        // renders guidance; there is no network call to 404.
        let vm = RealAccountLoginViewModel(resolution: r, server: server, webAuthn: MockWebAuthnProvider())
        await vm.startTakeover()
        XCTAssertEqual(vm.phase, .idle, "no-recovery must stay idle (a rendered state), not error")
        XCTAssertNil(server.lastRePairInitiate)
    }

    func test_multiNoRecovery_routesToNoRecoveryMultiState() async throws {
        let server = makeServer()
        try await seedAccount(server, username: "hilton", multi: true, recovery: false, totp: true)
        let r = try await server.resolveAccount(username: "hilton")
        XCTAssertEqual(r.kind, .multi)
        XCTAssertFalse(r.recovery.present)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .noRecovery(multi: true))
    }

    // MARK: - 7. quarantined device → countdown / disabled-remove

    /// A freshly-admitted (vouched) device carries a future
    /// `quarantineUntil`; the device-management surface must report it as
    /// quarantined (drives the clock indicator + disables the destructive
    /// menu). Past / absent / zero ⇒ not quarantined (Remove flows
    /// normally). This is the device-list node of the matrix.
    func test_quarantinedDevice_isQuarantined_gatesRemove() {
        let now: Int64 = 1_000_000
        let fresh = TrustedDevice(
            tokenId: "t1", tokenPrefix: "t1", label: "Reviewer iPhone",
            platform: "apns", addedAt: now, lastSeenAt: now,
            quarantineUntil: now + MockFlagshipServerClient.quarantineMs
        )
        XCTAssertTrue(fresh.isQuarantined(now: now), "a future deadline ⇒ quarantined ⇒ Remove disabled")

        let elapsed = TrustedDevice(
            tokenId: "t2", tokenPrefix: "t2", label: "Old iPhone",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: now - 1
        )
        XCTAssertFalse(elapsed.isQuarantined(now: now), "an elapsed window ⇒ Remove enabled")

        let neverQuarantined = TrustedDevice(
            tokenId: "t3", tokenPrefix: "t3", label: "Trusted",
            platform: "apns", addedAt: 1, lastSeenAt: 2,
            quarantineUntil: nil
        )
        XCTAssertFalse(neverQuarantined.isQuarantined(now: now))
    }

    /// The admit response that drives the quarantine countdown carries a
    /// deadline exactly 14 days out (matches the Worker's QUARANTINE_MS).
    func test_admit_returnsFourteenDayQuarantine() async throws {
        let server = makeServer()
        server.nowProvider = { 10_000 }
        let req = DeviceAdmitRequest(
            admit: .init(username: "acme", newDevicePubHex: "ab", issuedAt: 1),
            admitSig: "ff",
            request: .init(username: "acme", platform: "apns", providerToken: "tok",
                           pushX25519Pub: "pp", label: "Reviewer", issuedAt: 1),
            signature: "sig"
        )
        let resp = try await server.admitDevice(account: "acme", body: req)
        XCTAssertEqual(resp.quarantineUntil, 10_000 + MockFlagshipServerClient.quarantineMs)
        XCTAssertEqual(MockFlagshipServerClient.quarantineMs, 14 * 24 * 60 * 60 * 1000)
    }

    // MARK: - 8. The matrix, walked from one table (the contract surface)

    /// Every (kind, recovery) cell routes to its documented branch in ONE
    /// pass. If a future change perturbs the routing for any cell, this
    /// single test fails with the offending row named.
    func test_fullMatrix_eachCellRoutesToDocumentedBranch() async throws {
        struct Cell {
            let name: String
            let multi: Bool
            let recovery: Bool
            let totp: Bool
            let expectedKind: AccountResolution.Kind
            let expectedGrace: AccountResolution.GraceModel
            let expectedBranch: RealAccountLoginViewModel.Branch
        }
        let cells: [Cell] = [
            Cell(name: "single-no-recovery", multi: false, recovery: false, totp: false,
                 expectedKind: .single, expectedGrace: .sevenDay, expectedBranch: .noRecovery(multi: false)),
            Cell(name: "single-with-recovery", multi: false, recovery: true, totp: false,
                 expectedKind: .single, expectedGrace: .sevenDay, expectedBranch: .singleTakeover),
            Cell(name: "multi-no-recovery", multi: true, recovery: false, totp: true,
                 expectedKind: .multi, expectedGrace: .twentyFourHourTotp, expectedBranch: .noRecovery(multi: true)),
            Cell(name: "multi-with-recovery", multi: true, recovery: true, totp: true,
                 expectedKind: .multi, expectedGrace: .twentyFourHourTotp, expectedBranch: .multiTakeover),
        ]
        for cell in cells {
            let server = makeServer()
            try await seedAccount(server, username: cell.name, multi: cell.multi,
                                  recovery: cell.recovery, totp: cell.totp)
            let r = try await server.resolveAccount(username: cell.name)
            XCTAssertEqual(r.kind, cell.expectedKind, "[\(cell.name)] kind")
            XCTAssertEqual(r.graceModel, cell.expectedGrace, "[\(cell.name)] graceModel")
            XCTAssertEqual(r.recovery.present, cell.recovery, "[\(cell.name)] recovery.present")

            // Real accounts ALWAYS route to .realAccount (never .unknown /
            // .failed) — the credential branch is selected downstream.
            let login = LoginViewModel(server: server)
            await login.submit(cell.name)
            guard case .resolved(.realAccount(let resolution)) = login.phase else {
                XCTFail("[\(cell.name)] expected .realAccount, got \(login.phase)")
                continue
            }
            XCTAssertEqual(
                RealAccountLoginViewModel.deriveBranch(resolution),
                cell.expectedBranch,
                "[\(cell.name)] branch"
            )
        }
    }

    // MARK: - 9. Mock wire MATCHES the Worker wire (lockstep invariant)

    /// The iOS Mock's `resolveAccount` output must decode-equal the
    /// Worker's `AccountResolution` JSON shape (the iOS-Mock-matches-
    /// Worker-wire invariant). We assert that a Worker-shaped JSON for
    /// each kind decodes to the SAME value the Mock synthesizes, so a
    /// drift on either side trips here.
    func test_mockWire_matchesWorkerJsonShape_demo() async throws {
        let server = makeServer()
        server.demoServers = ["demo-alice": demoBlock("demo-alice")]
        let fromMock = try await server.resolveAccount(username: "demo-alice")
        let workerJson = """
        {"username":"demo-alice","exists":true,"kind":"demo",
         "recovery":{"present":false,"hasFetchGate":false},
         "totpEnrolled":false,"trustedDeviceCount":0,
         "demoServer":{"fqdn":"home.demo-alice.flagship.services","status":"up","ttlIdleMinutes":30},
         "graceModel":"instant"}
        """.data(using: .utf8)!
        let fromWorker = try JSONDecoder().decode(AccountResolution.self, from: workerJson)
        XCTAssertEqual(fromMock, fromWorker, "Mock demo resolve must equal the Worker wire shape")
    }

    func test_mockWire_matchesWorkerJsonShape_unknown() async throws {
        let server = makeServer()
        let fromMock = try await server.resolveAccount(username: "nobody")
        let workerJson = """
        {"username":"nobody","exists":false,"kind":"unknown",
         "recovery":{"present":false,"hasFetchGate":false},
         "totpEnrolled":false,"trustedDeviceCount":0,"graceModel":"none"}
        """.data(using: .utf8)!
        let fromWorker = try JSONDecoder().decode(AccountResolution.self, from: workerJson)
        XCTAssertEqual(fromMock, fromWorker, "Mock unknown resolve must equal the Worker wire shape")
    }

    func test_mockWire_matchesWorkerJsonShape_multi() async throws {
        let server = makeServer()
        try await seedAccount(server, username: "hilton", multi: true, recovery: false, totp: true)
        let fromMock = try await server.resolveAccount(username: "hilton")
        // Worker: multi, no recovery, totp enrolled, one trusted device count
        // is environment-derived; the Mock counts devicesByUser (none here ⇒ 0).
        let workerJson = """
        {"username":"hilton","exists":true,"kind":"multi",
         "recovery":{"present":false,"hasFetchGate":false},
         "totpEnrolled":true,"trustedDeviceCount":0,"graceModel":"24h-totp"}
        """.data(using: .utf8)!
        let fromWorker = try JSONDecoder().decode(AccountResolution.self, from: workerJson)
        XCTAssertEqual(fromMock, fromWorker, "Mock multi resolve must equal the Worker wire shape")
    }

    /// admitDevice's wire (the device-join leg of the matrix) — the Mock's
    /// 403 username-mismatch gate mirrors the Worker's admit gate so the
    /// JoinAccountViewModel exercises the same rejection contract.
    func test_admitWire_usernameMismatch_is403_likeWorker() async {
        let server = makeServer()
        let mismatched = DeviceAdmitRequest(
            admit: .init(username: "other", newDevicePubHex: "ab", issuedAt: 1),
            admitSig: "ff",
            request: .init(username: "other", platform: "apns", providerToken: "t",
                           pushX25519Pub: "p", label: "L", issuedAt: 1),
            signature: "s"
        )
        do {
            _ = try await server.admitDevice(account: "acme", body: mismatched)
            XCTFail("admit username/url mismatch must be rejected")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 403, "admit mismatch ⇒ 403 (matches the Worker gate)")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
