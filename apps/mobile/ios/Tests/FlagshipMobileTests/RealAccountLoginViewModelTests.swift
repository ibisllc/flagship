import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Phase 3 — the real single/multi login state machine
/// (`RealAccountLoginViewModel`). Mock WebAuthn only (live
/// ASAuthorization is a separate human/device task). Pins:
///   - each branch (no-recovery / single / multi) reaches the right
///     outcome;
///   - multi REQUIRES a recovery TOTP / recovery-code before the
///     re-pair (and it's forwarded as `totpProof`);
///   - `installUMK` is called on success (the old stub left the seed
///     on the floor);
///   - the takeover re-pair is initiated with the right shape.
/// See docs/login-and-account-redesign.md.
@MainActor
final class RealAccountLoginViewModelTests: XCTestCase {

    // MARK: - Fixtures

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    private func resolution(
        username: String,
        kind: AccountResolution.Kind,
        recoveryPresent: Bool,
        totpEnrolled: Bool = false,
        grace: AccountResolution.GraceModel
    ) -> AccountResolution {
        AccountResolution(
            username: username,
            exists: true,
            kind: kind,
            recovery: .init(present: recoveryPresent, hasFetchGate: false, credentialId: recoveryPresent ? "mock-cred-existing" : nil),
            totpEnrolled: totpEnrolled,
            trustedDeviceCount: 0,
            demoServer: nil,
            graceModel: grace
        )
    }

    /// Seed the Mock recovery store so the Mock-PRF unwrap round-trips:
    /// `MockWebAuthnProvider.assertAny()` yields credentialId
    /// "mock-cred-existing"; we wrap a random UMK under that cred's
    /// stable PRF secret and register the envelope.
    private func seedRecovery(_ server: MockFlagshipServerClient) async throws -> SymmetricKey {
        let credentialId = "mock-cred-existing"
        let umk = SymmetricKey(size: .bits256)
        let prf = try await MockWebAuthnProvider().prfAssert(credentialId: credentialId)
        let env = try Recovery.wrap(umkSeed: umk, prfSecret: prf)
        _ = try await server.registerRecoveryEnvelope(.init(
            credentialId: credentialId,
            wrappedUmkBase64: env.ciphertextBase64,
            nonceBase64: env.nonceBase64
        ))
        return umk
    }

    /// A VM with an installUMK spy so we can assert the recovered seed
    /// is actually installed (without faking the Secure Enclave). The
    /// spy records AND performs the real install, because the VM's
    /// next step derives the new IRK from the just-installed UMK — a
    /// no-op stub would leave `Keystore.deriveIRK` without a key. On
    /// the simulator test bundle `installUMK` lands in the in-memory
    /// keychain fallback (no entitlement), so this is hermetic.
    private func makeVM(
        resolution: AccountResolution,
        server: MockFlagshipServerClient,
        installSpy: InstallSpy
    ) -> RealAccountLoginViewModel {
        RealAccountLoginViewModel(
            resolution: resolution,
            server: server,
            webAuthn: MockWebAuthnProvider(),
            installUMK: { seed, reason in
                installSpy.record(seed: seed, reason: reason)
                try await Keystore.installUMK(seed, reason: reason)
            }
        )
    }

    final class InstallSpy: @unchecked Sendable {
        private(set) var installed: [SymmetricKey] = []
        private(set) var reasons: [String] = []
        func record(seed: SymmetricKey, reason: String) {
            installed.append(seed); reasons.append(reason)
        }
        var callCount: Int { installed.count }
    }

    // MARK: - Branch derivation (the matrix, never re-derived)

    func test_branch_singleNoRecovery_isNoRecoveryState() {
        let r = resolution(username: "harry", kind: .single, recoveryPresent: false, grace: .sevenDay)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .noRecovery(multi: false))
    }

    func test_branch_multiNoRecovery_isNoRecoveryMultiState() {
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: false, totpEnrolled: true, grace: .twentyFourHourTotp)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .noRecovery(multi: true))
    }

    func test_branch_singleWithRecovery_isSingleTakeover() {
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .sevenDay)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .singleTakeover)
    }

    func test_branch_multiWithRecovery_isMultiTakeover() {
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: true, totpEnrolled: true, grace: .twentyFourHourTotp)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .multiTakeover)
    }

    // MARK: - No-recovery renders a STATE, never a ceremony

    func test_noRecovery_startTakeover_isNoOp_noRePair() async {
        let server = makeServer()
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: false, grace: .sevenDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        await vm.startTakeover()
        // Stays idle: there's no ceremony for a no-recovery account.
        XCTAssertEqual(vm.phase, .idle)
        XCTAssertNil(server.lastRePairInitiate, "no-recovery must NOT initiate a re-pair")
        XCTAssertEqual(spy.callCount, 0, "no-recovery must NOT install a UMK")
    }

    // MARK: - Single → TAKEOVER (7-day), no totpProof

    func test_singleTakeover_installsUMK_initiatesRePair_noTotpProof() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        let installedUmk = try await seedRecovery(server)
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .sevenDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)

        await vm.startTakeover()

        guard case .completed(let user, _) = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }
        XCTAssertEqual(user, "harry")
        // installUMK called on success, with the recovered seed.
        XCTAssertEqual(spy.callCount, 1)
        XCTAssertEqual(
            spy.installed.first?.withUnsafeBytes { Data($0) },
            installedUmk.withUnsafeBytes { Data($0) },
            "the recovered UMK seed must be the one installed"
        )
        // Re-pair initiated; single carries NO totpProof.
        let last = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertEqual(last.username, "harry")
        XCTAssertEqual(last.body.request.username, "harry")
        XCTAssertFalse(last.body.request.newIrkPub.isEmpty)
        XCTAssertNil(last.body.totpProof, "single re-pair must not carry a totpProof")
    }

    // MARK: - Multi requires a second factor BEFORE re-pair

    func test_multiTakeover_emptySecondFactor_failsBeforeRePair() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "hilton", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        server.accountTypeByUser["hilton"] = "multi"
        server.totpEnrolledAtByUser["hilton"] = 1
        _ = try await seedRecovery(server)
        let spy = InstallSpy()
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: true, totpEnrolled: true, grace: .twentyFourHourTotp)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)

        // No second factor typed.
        XCTAssertFalse(vm.canStartMultiTakeover)
        await vm.startTakeover()

        guard case .failed = vm.phase else {
            return XCTFail("expected .failed for missing second factor, got \(vm.phase)")
        }
        XCTAssertNil(server.lastRePairInitiate, "must not initiate re-pair without a second factor")
        XCTAssertEqual(spy.callCount, 0, "must not install a UMK before the second factor passes")
    }

    func test_multiTakeover_withTotp_forwardsTotpProofMethodTotp() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "hilton", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        server.accountTypeByUser["hilton"] = "multi"
        server.totpEnrolledAtByUser["hilton"] = 1
        let installedUmk = try await seedRecovery(server)
        let spy = InstallSpy()
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: true, totpEnrolled: true, grace: .twentyFourHourTotp)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)

        vm.secondFactorInput = "123456"   // 6 digits → method "totp"
        XCTAssertTrue(vm.canStartMultiTakeover)
        await vm.startTakeover()

        guard case .completed(let user, _) = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }
        XCTAssertEqual(user, "hilton")
        XCTAssertEqual(spy.callCount, 1)
        XCTAssertEqual(
            spy.installed.first?.withUnsafeBytes { Data($0) },
            installedUmk.withUnsafeBytes { Data($0) }
        )
        let last = try XCTUnwrap(server.lastRePairInitiate)
        let proof = try XCTUnwrap(last.body.totpProof, "multi re-pair MUST carry a totpProof")
        XCTAssertEqual(proof.code, "123456")
        XCTAssertEqual(proof.method, "totp")
    }

    func test_multiTakeover_withRecoveryCode_forwardsTotpProofMethodRecovery() async throws {
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "hilton", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        server.accountTypeByUser["hilton"] = "multi"
        server.totpEnrolledAtByUser["hilton"] = 1
        _ = try await seedRecovery(server)
        let spy = InstallSpy()
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: true, totpEnrolled: true, grace: .twentyFourHourTotp)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)

        vm.secondFactorInput = "ABCD-EFGH-IJ"   // not 6 digits → method "recovery"
        await vm.startTakeover()

        guard case .completed = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }
        let last = try XCTUnwrap(server.lastRePairInitiate)
        let proof = try XCTUnwrap(last.body.totpProof)
        XCTAssertEqual(proof.code, "ABCD-EFGH-IJ")
        XCTAssertEqual(proof.method, "recovery")
    }

    // MARK: - The Mock enforces the Worker's multi gate (401)

    func test_multiTakeover_rejectedSecondFactor_surfacesFailure() async throws {
        // Drive a 401 from the Mock by clearing the multi flag's proof
        // path: send an empty-shaped proof straight to the server to
        // assert the gate exists. (The VM path can't send empty + multi
        // — it short-circuits — so we exercise the Mock contract here.)
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "hilton", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        server.accountTypeByUser["hilton"] = "multi"
        do {
            _ = try await server.initiateRePair(
                username: "hilton",
                body: RePairInitiateRequest(
                    request: .init(username: "hilton", newIrkPub: "00", oldIrkPub: "00", issuedAt: 1),
                    signature: "s",
                    totpProof: nil
                ),
                ifMatch: nil
            )
            XCTFail("multi re-pair without totpProof must throw 401")
        } catch ScreensClientError.http(let status, _) {
            XCTAssertEqual(status, 401)
        }
    }

    // MARK: - proofMethod discriminator

    func test_proofMethod_sixDigits_isTotp_elseRecovery() {
        XCTAssertEqual(RealAccountLoginViewModel.proofMethod(for: "123456"), "totp")
        XCTAssertEqual(RealAccountLoginViewModel.proofMethod(for: " 654321 "), "totp")
        XCTAssertEqual(RealAccountLoginViewModel.proofMethod(for: "12345"), "recovery")
        XCTAssertEqual(RealAccountLoginViewModel.proofMethod(for: "1234567"), "recovery")
        XCTAssertEqual(RealAccountLoginViewModel.proofMethod(for: "ABCD-EFGH-IJ"), "recovery")
    }

    // MARK: - Failure surfaces (passkey/transport), not .completed

    func test_takeover_recoveryFetchMissing_failsCleanly() async throws {
        // No recovery envelope seeded → the Mock fetch 404s → the VM
        // surfaces a clean failure, NOT a crash / completed.
        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: "ab", issuedAt: 1), signature: "s"
        ))
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .sevenDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        await vm.startTakeover()
        guard case .failed = vm.phase else {
            return XCTFail("expected .failed when the envelope is missing, got \(vm.phase)")
        }
        XCTAssertEqual(spy.callCount, 0)
        XCTAssertNil(server.lastRePairInitiate)
    }
}
