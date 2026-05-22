import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Phase 1 (demo-as-recovery join) — pins the username-first Join wire
/// + branching:
///   - the Mock `resolveAccount` returns the right AccountResolution
///     wire for a seeded demo username vs an unknown one;
///   - the demo branch opens the account (DemoFixtures.activate);
///   - the unknown branch lands on a renderable `.unknown` STATE, not
///     an error / 404.
/// See docs/login-and-account-redesign.md.
@MainActor
final class LoginViewModelTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func demoBlock(_ username: String) -> DemoServerBlock {
        DemoServerBlock(
            fqdn: "home.\(username).flagship.services",
            status: "up",
            ttlIdleMinutes: 30
        )
    }

    // MARK: - Mock wire: demo

    func test_mockResolve_demoUsername_returnsDemoKindWithServerBlock() async throws {
        let server = makeServer()
        server.demoServers = ["demoalice": demoBlock("demoalice")]
        let r = try await server.resolveAccount(username: "demoalice")
        XCTAssertEqual(r.username, "demoalice")
        XCTAssertTrue(r.exists)
        XCTAssertEqual(r.kind, .demo)
        XCTAssertEqual(r.graceModel, .instant)
        XCTAssertEqual(r.demoServer?.fqdn, "home.demoalice.flagship.services")
        // Demo crypto is a no-op → recovery + factors are zeroed.
        XCTAssertFalse(r.recovery.present)
        XCTAssertFalse(r.totpEnrolled)
        XCTAssertEqual(r.trustedDeviceCount, 0)
    }

    func test_mockResolve_demoMatch_isCaseInsensitive() async throws {
        let server = makeServer()
        server.demoServers = ["smoketest": demoBlock("smoketest")]
        let r = try await server.resolveAccount(username: "SmokeTest")
        XCTAssertEqual(r.kind, .demo)
        XCTAssertEqual(r.username, "smoketest")
    }

    // MARK: - Mock wire: unknown

    func test_mockResolve_unknownUsername_returnsUnknownZeroed() async throws {
        let server = makeServer()
        let r = try await server.resolveAccount(username: "nobody")
        XCTAssertEqual(r.username, "nobody")
        XCTAssertFalse(r.exists)
        XCTAssertEqual(r.kind, .unknown)
        XCTAssertFalse(r.recovery.present)
        XCTAssertFalse(r.recovery.hasFetchGate)
        XCTAssertNil(r.recovery.credentialId)
        XCTAssertFalse(r.totpEnrolled)
        XCTAssertEqual(r.trustedDeviceCount, 0)
        XCTAssertNil(r.demoServer)
        XCTAssertEqual(r.graceModel, .none)
    }

    func test_mockResolve_neverThrowsForMissingAccount() async {
        let server = makeServer()
        // The login space never 404s — a missing account resolves to a
        // `.unknown` value, it does NOT throw.
        do {
            let r = try await server.resolveAccount(username: "definitelymissing")
            XCTAssertEqual(r.kind, .unknown)
        } catch {
            XCTFail("resolveAccount must not throw for a missing account, threw: \(error)")
        }
    }

    // MARK: - Mock wire: real claimed account

    func test_mockResolve_claimedSingle_returnsSingle() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "deadbeef", issuedAt: 1),
            signature: "sig"
        ))
        let r = try await server.resolveAccount(username: "harry")
        XCTAssertTrue(r.exists)
        XCTAssertEqual(r.kind, .single)
        XCTAssertEqual(r.graceModel, .sevenDay)
    }

    func test_mockResolve_claimedMulti_returnsMultiWith24hTotp() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "hilton", irkPub: "beef", issuedAt: 1),
            signature: "sig"
        ))
        server.accountTypeByUser["hilton"] = "multi"
        server.totpEnrolledAtByUser["hilton"] = 123
        let r = try await server.resolveAccount(username: "hilton")
        XCTAssertEqual(r.kind, .multi)
        XCTAssertTrue(r.totpEnrolled)
        XCTAssertEqual(r.graceModel, .twentyFourHourTotp)
    }

    // MARK: - AccountResolution Codable round-trips the Worker wire

    func test_accountResolution_decodesWorkerWireShape() throws {
        // Byte-shape mirrors packages/control-plane/src/accountResolve.ts
        // — keep these in lockstep.
        let json = """
        {
          "username": "demoalice",
          "exists": true,
          "kind": "demo",
          "recovery": { "present": false, "hasFetchGate": false },
          "totpEnrolled": false,
          "trustedDeviceCount": 0,
          "demoServer": { "fqdn": "home.demoalice.flagship.services", "status": "up", "ttlIdleMinutes": 30 },
          "graceModel": "instant"
        }
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(AccountResolution.self, from: json)
        XCTAssertEqual(r.kind, .demo)
        XCTAssertEqual(r.graceModel, .instant)
        XCTAssertEqual(r.demoServer?.status, "up")
    }

    func test_accountResolution_forwardCompat_unknownKindAndGrace() throws {
        // A newer Worker emitting a kind/graceModel this binary doesn't
        // know about must fall open to `.unknown` / `.none`, not crash.
        let json = """
        {
          "username": "x",
          "exists": true,
          "kind": "future-kind",
          "recovery": { "present": false, "hasFetchGate": false },
          "totpEnrolled": false,
          "trustedDeviceCount": 0,
          "graceModel": "future-grace"
        }
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(AccountResolution.self, from: json)
        XCTAssertEqual(r.kind, .unknown)
        XCTAssertEqual(r.graceModel, .none)
    }

    // MARK: - LoginViewModel branching

    func test_login_demoBranch_resolvesDemoOutcome() async {
        let server = makeServer()
        server.demoServers = ["demoalice": demoBlock("demoalice")]
        let vm = LoginViewModel(server: server)
        await vm.submit("demoalice")
        guard case .resolved(.demo(let u, let block)) = vm.phase else {
            return XCTFail("expected .resolved(.demo), got \(vm.phase)")
        }
        XCTAssertEqual(u, "demoalice")
        XCTAssertEqual(block?.fqdn, "home.demoalice.flagship.services")
    }

    func test_login_unknownBranch_resolvesUnknownOutcome() async {
        let vm = LoginViewModel(server: makeServer())
        await vm.submit("nobody")
        guard case .resolved(.unknown(let u)) = vm.phase else {
            return XCTFail("expected .resolved(.unknown), got \(vm.phase)")
        }
        XCTAssertEqual(u, "nobody")
    }

    func test_login_realAccountBranch_resolvesRealAccountOutcome() async {
        let server = makeServer()
        try? await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "deadbeef", issuedAt: 1),
            signature: "sig"
        ))
        let vm = LoginViewModel(server: server)
        await vm.submit("harry")
        guard case .resolved(.realAccount(let resolution)) = vm.phase else {
            return XCTFail("expected .resolved(.realAccount), got \(vm.phase)")
        }
        XCTAssertEqual(resolution.kind, .single)
        XCTAssertEqual(resolution.username, "harry")
    }

    func test_login_lowercasesAndTrimsBeforeResolve() async {
        let server = makeServer()
        server.demoServers = ["demoalice": demoBlock("demoalice")]
        let vm = LoginViewModel(server: server)
        await vm.submit("  DemoAlice  ")
        guard case .resolved(.demo(let u, _)) = vm.phase else {
            return XCTFail("expected demo for trimmed/lowercased input, got \(vm.phase)")
        }
        XCTAssertEqual(u, "demoalice")
    }

    func test_login_emptyInput_staysIdle() async {
        let vm = LoginViewModel(server: makeServer())
        await vm.submit("   ")
        XCTAssertEqual(vm.phase, .idle)
        XCTAssertFalse(vm.canSubmit("   "))
        XCTAssertTrue(vm.canSubmit("harry"))
    }

    func test_login_transportFailure_landsOnFailedNotUnknown() async {
        let server = makeServer()
        server.shouldFail = true
        let vm = LoginViewModel(server: server)
        await vm.submit("harry")
        guard case .failed = vm.phase else {
            return XCTFail("expected .failed for a transport error, got \(vm.phase)")
        }
        // A real outage is distinct from a missing account: it must NOT
        // masquerade as `.unknown`.
        if case .resolved(.unknown) = vm.phase {
            XCTFail("transport failure must not resolve to .unknown")
        }
    }

    func test_login_reset_returnsToIdle() async {
        let vm = LoginViewModel(server: makeServer())
        await vm.submit("nobody")
        if case .resolved = vm.phase {} else { XCTFail("expected resolved before reset") }
        vm.reset()
        XCTAssertEqual(vm.phase, .idle)
    }

    // MARK: - Demo join opens the account end-to-end

    func test_demoJoin_opensAccountViaDemoFixtures() async {
        // The decision the Join host (OnboardingFlow) makes: a demo
        // outcome calls DemoFixtures.activate, which opens the account.
        let server = makeServer()
        server.demoServers = ["demoalice": demoBlock("demoalice")]
        let vm = LoginViewModel(server: server)
        await vm.submit("demoalice")
        guard case .resolved(.demo(let u, let block)) = vm.phase else {
            return XCTFail("expected demo outcome")
        }
        let app = AppState()
        DemoFixtures.activate(app, username: u, demoServer: block)
        XCTAssertTrue(app.isPaired)
        XCTAssertEqual(app.currentUser, "demoalice")
        // Plan A one-live-device path: the demoServer block renders ONE
        // pod, not the 3-fixture legacy set.
        XCTAssertEqual(app.pods.count, 1)
        XCTAssertEqual(app.pods.first?.fqdn, "home.demoalice.flagship.services")
        XCTAssertEqual(app.pods.first?.status, .online)
    }
}
