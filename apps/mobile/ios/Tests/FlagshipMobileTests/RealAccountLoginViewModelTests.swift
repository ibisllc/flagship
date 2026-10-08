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
            demoServer: nil,
            graceModel: grace
        )
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
        let r = resolution(username: "harry", kind: .single, recoveryPresent: false, grace: .threeDay)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .noRecovery(multi: false))
    }

    func test_branch_multiNoRecovery_isNoRecoveryMultiState() {
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: false, totpEnrolled: true, grace: .twentyFourHourTotp)
        XCTAssertEqual(RealAccountLoginViewModel.deriveBranch(r), .noRecovery(multi: true))
    }

    func test_branch_singleWithRecovery_isSingleTakeover() {
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
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
        let r = resolution(username: "harry", kind: .single, recoveryPresent: false, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        await vm.startTakeover()
        // Stays idle: there's no ceremony for a no-recovery account.
        XCTAssertEqual(vm.phase, .idle)
        XCTAssertNil(server.lastRePairInitiate, "no-recovery must NOT initiate a re-pair")
        XCTAssertEqual(spy.callCount, 0, "no-recovery must NOT install a UMK")
    }

    // MARK: - Single → gated recovery (recovery rework Phase A)

    /// A single-device account restores by passphrase + passkey: the gated
    /// unwrap hands back the account's OWN UMK, we install it, and pair
    /// IMMEDIATELY (`.finalized`) — no re-pair, no grace, because the recovered
    /// key already matches the registered identity.
    func test_singleRecovery_gatedUnwrap_finalizes_noRePair() async throws {
        Keystore.wipe()
        defer { Keystore.wipe() }
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = makeServer()
        // Enrol the gated recovery row exactly as the real setup flow does
        // (ships fetchTokenHash + prfSaltHash + a wrapped UMK keyed by the
        // passphrase-derived PRF salt).
        let enrol = RecoveryViewModel(
            client: server, webAuthn: MockWebAuthnProvider(), username: { "harry" }
        )
        await enrol.setup(umkSeed: umk, passphrase: "correct horse battery staple")
        guard case .registered = enrol.phase else {
            return XCTFail("enrol failed: \(enrol.phase)")
        }

        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        vm.passphraseInput = "correct horse battery staple"

        await vm.startTakeover()

        guard case .finalized(let user) = vm.phase else {
            return XCTFail("expected .finalized (instant pair), got \(vm.phase)")
        }
        XCTAssertEqual(user, "harry")
        XCTAssertEqual(spy.callCount, 1, "the recovered UMK must be installed")
        XCTAssertNil(server.lastRePairInitiate, "single-device recovery must NOT initiate a re-pair")
    }

    // MARK: - Task #29 / Phase A vs B — recovered-key-matches-registered

    /// PHASE A — the registered IRK still matches the recovered UMK's IRK
    /// (the common sign-out → recover round-trip: key wiped locally, never
    /// rotated server-side). The VM must pair INSTANTLY (.finalized) with
    /// NO re-pair and NO grace. This is the load-bearing path that makes a
    /// Tier-2 SIGN OUT come back cleanly.
    func test_singleRecovery_recoveredKeyMatchesRegistered_instantPair() async throws {
        Keystore.wipe()
        defer { Keystore.wipe() }
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")
        // The IRK the account is registered with == the IRK derived from
        // this UMK (which is exactly what recovery restores).
        let registeredIrk = try await Keystore.deriveIRK(reason: "test")
        let registeredPubHex = HexUtil.encode(registeredIrk.publicKey.rawRepresentation)

        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: registeredPubHex, issuedAt: 1),
            signature: "s"
        ))
        let enrol = RecoveryViewModel(
            client: server, webAuthn: MockWebAuthnProvider(), username: { "harry" }
        )
        await enrol.setup(umkSeed: umk, passphrase: "correct horse battery staple")
        guard case .registered = enrol.phase else { return XCTFail("enrol failed: \(enrol.phase)") }

        // Simulate the wiped device (Tier-2 sign out erased the key).
        Keystore.wipe()
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        vm.passphraseInput = "correct horse battery staple"

        await vm.startTakeover()

        guard case .finalized(let user) = vm.phase else {
            return XCTFail("expected .finalized (instant Phase-A pair), got \(vm.phase)")
        }
        XCTAssertEqual(user, "harry")
        XCTAssertEqual(spy.callCount, 1, "recovered UMK installed")
        XCTAssertNil(server.lastRePairInitiate,
            "Phase A (key matches) must NOT initiate a re-pair — no rotation, no grace")
    }

    /// PHASE B — the registered IRK rotated since the recovery envelope was
    /// written (another device ran Replace / Wipe). The recovered key is
    /// stale, so the VM must run a REAL re-pair against the live key behind
    /// a grace window (.completed) carrying `oldIrkPub = registeredIrkPubHex`.
    func test_singleRecovery_recoveredKeyRotated_rePairsWithGrace() async throws {
        Keystore.wipe()
        defer { Keystore.wipe() }
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = makeServer()
        // The account is registered under a DIFFERENT (rotated) IRK than the
        // one the recovered UMK derives — simulating a post-rotation account.
        let rotatedPubHex = String(repeating: "ab", count: 32)
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: rotatedPubHex, issuedAt: 1),
            signature: "s"
        ))
        let enrol = RecoveryViewModel(
            client: server, webAuthn: MockWebAuthnProvider(), username: { "harry" }
        )
        await enrol.setup(umkSeed: umk, passphrase: "correct horse battery staple")
        guard case .registered = enrol.phase else { return XCTFail("enrol failed: \(enrol.phase)") }

        Keystore.wipe()
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        vm.passphraseInput = "correct horse battery staple"

        await vm.startTakeover()

        guard case .completed(let user, _) = vm.phase else {
            return XCTFail("expected .completed (Phase-B re-pair with grace), got \(vm.phase)")
        }
        XCTAssertEqual(user, "harry")
        let last = try XCTUnwrap(server.lastRePairInitiate,
            "Phase B (key rotated) MUST initiate a re-pair")
        XCTAssertEqual(last.body.request.oldIrkPub.lowercased(), rotatedPubHex,
            "the re-pair must displace the REGISTERED (rotated) key")
    }

    // MARK: - #52 — single-device credential-required initiate

    /// Shared setup for the #52 tests: a single-device account whose
    /// registered IRK rotated (Phase B) AND that has a second factor
    /// enrolled — the cloud 401s the bare initiate, so the VM must land
    /// on `.needsSecondFactor` instead of failing.
    private func makeRotatedEnrolledSingle() async throws -> (vm: RealAccountLoginViewModel, server: MockFlagshipServerClient, rotatedPubHex: String) {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = makeServer()
        let rotatedPubHex = String(repeating: "ab", count: 32)
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: rotatedPubHex, issuedAt: 1),
            signature: "s"
        ))
        // #52 — the single account has a second factor enrolled, so the
        // Mock (mirroring the Worker) rejects a proof-less initiate. The
        // fetch mints no recovery proof here, so the code is the only
        // credential and the VM must fall back to prompting for it.
        server.totpEnrolledAtByUser["harry"] = 1
        server.mintsRecoveryProofOnFetch = false
        let enrol = RecoveryViewModel(
            client: server, webAuthn: MockWebAuthnProvider(), username: { "harry" }
        )
        await enrol.setup(umkSeed: umk, passphrase: "correct horse battery staple")
        guard case .registered = enrol.phase else {
            throw XCTSkip("enrol failed: \(enrol.phase)")
        }

        Keystore.wipe()
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        vm.passphraseInput = "correct horse battery staple"
        return (vm, server, rotatedPubHex)
    }

    /// The cloud's 401 on the bare single-device initiate lands on
    /// `.needsSecondFactor`; submitting the factor retries the initiate
    /// with the proof riding the body and reaches `.completed`.
    func test_singleRecovery_credentialEnrolled_promptsThenInitiatesWithProof() async throws {
        defer { Keystore.wipe() }
        let (vm, server, rotatedPubHex) = try await makeRotatedEnrolledSingle()

        await vm.startTakeover()
        guard case .needsSecondFactor(let error) = vm.phase else {
            return XCTFail("expected .needsSecondFactor after the cloud's 401, got \(vm.phase)")
        }
        XCTAssertNil(error)
        // The bare attempt rode no proof.
        XCTAssertNil(server.lastRePairInitiate?.body.totpProof)

        vm.secondFactorInput = "123456"
        await vm.submitSingleDeviceSecondFactor()

        guard case .completed(let user, _) = vm.phase else {
            return XCTFail("expected .completed after the proof-carrying retry, got \(vm.phase)")
        }
        XCTAssertEqual(user, "harry")
        let retry = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertEqual(retry.body.totpProof, RePairInitiateRequest.TotpProof(code: "123456", method: "totp"),
            "the proof must ride BESIDE the signed envelope on the retry")
        XCTAssertEqual(retry.body.request.oldIrkPub.lowercased(), rotatedPubHex,
            "the retry still displaces the REGISTERED (rotated) key")
    }

    /// A non-6-digit second factor is forwarded as method 'recovery'.
    func test_singleRecovery_secondFactor_recoveryCodeMethod() async throws {
        defer { Keystore.wipe() }
        let (vm, server, _) = try await makeRotatedEnrolledSingle()

        await vm.startTakeover()
        guard case .needsSecondFactor = vm.phase else {
            return XCTFail("expected .needsSecondFactor, got \(vm.phase)")
        }
        vm.secondFactorInput = "ABCD-EFGH-IJ"
        await vm.submitSingleDeviceSecondFactor()
        guard case .completed = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }
        XCTAssertEqual(server.lastRePairInitiate?.body.totpProof,
                       RePairInitiateRequest.TotpProof(code: "ABCD-EFGH-IJ", method: "recovery"))
    }

    /// Submitting with an empty field stays on the entry state with an
    /// inline error (no network call).
    func test_singleRecovery_secondFactor_empty_staysWithError() async throws {
        defer { Keystore.wipe() }
        let (vm, server, _) = try await makeRotatedEnrolledSingle()

        await vm.startTakeover()
        guard case .needsSecondFactor = vm.phase else {
            return XCTFail("expected .needsSecondFactor, got \(vm.phase)")
        }
        let attemptsBefore = server.lastRePairInitiate
        vm.secondFactorInput = "   "
        await vm.submitSingleDeviceSecondFactor()
        guard case .needsSecondFactor(let error) = vm.phase else {
            return XCTFail("expected to stay on .needsSecondFactor, got \(vm.phase)")
        }
        XCTAssertNotNil(error)
        XCTAssertEqual(server.lastRePairInitiate?.body.signature, attemptsBefore?.body.signature,
            "no new initiate may fire on an empty submission")
    }

    /// Current Workers accept the gated fetch's recovery proof as the
    /// single-device credential even with a code enrolled, so the initiate
    /// lands straight away without prompting for one.
    func test_singleRecovery_codeEnrolled_recoveryProofSuffices() async throws {
        defer { Keystore.wipe() }
        let (vm, server, _) = try await makeRotatedEnrolledSingle()
        server.mintsRecoveryProofOnFetch = true

        await vm.startTakeover()

        guard case .completed = vm.phase else {
            return XCTFail("expected .completed via recoveryProof, got \(vm.phase)")
        }
        let last = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertNotNil(last.body.recoveryProof)
        XCTAssertNil(last.body.totpProof)
    }

    /// An account with NO second factor enrolled keeps the grace-only
    /// path: the bare Phase-B initiate succeeds directly (.completed),
    /// never passing through `.needsSecondFactor`. (This is the
    /// pre-#52 behavior, pinned so the gate stays opt-in-by-enrollment.)
    func test_singleRecovery_noCredentialEnrolled_keepsGraceOnlyPath() async throws {
        // test_singleRecovery_recoveredKeyRotated_rePairsWithGrace
        // already pins this end-to-end; this assertion documents the
        // #52 boundary explicitly.
        Keystore.wipe()
        defer { Keystore.wipe() }
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")
        let server = makeServer()
        let rotatedPubHex = String(repeating: "ab", count: 32)
        try await server.claimUsername(.init(
            request: .init(username: "harry", irkPub: rotatedPubHex, issuedAt: 1),
            signature: "s"
        ))
        let enrol = RecoveryViewModel(
            client: server, webAuthn: MockWebAuthnProvider(), username: { "harry" }
        )
        await enrol.setup(umkSeed: umk, passphrase: "correct horse battery staple")
        guard case .registered = enrol.phase else { return XCTFail("enrol failed: \(enrol.phase)") }

        Keystore.wipe()
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        vm.passphraseInput = "correct horse battery staple"
        await vm.startTakeover()
        guard case .completed = vm.phase else {
            return XCTFail("expected .completed straight away (no credential enrolled), got \(vm.phase)")
        }
        XCTAssertNil(server.lastRePairInitiate?.body.totpProof)
    }

    /// No passphrase typed → the single path stops before any unwrap/install.
    func test_singleRecovery_emptyPassphrase_failsBeforeUnwrap() async {
        let server = makeServer()
        let spy = InstallSpy()
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)

        await vm.startTakeover()   // passphraseInput is empty

        guard case .failed = vm.phase else {
            return XCTFail("expected .failed for a missing passphrase, got \(vm.phase)")
        }
        XCTAssertEqual(spy.callCount, 0)
        XCTAssertNil(server.lastRePairInitiate)
    }

    // MARK: - Multi-device takeover (gated unwrap + rotating re-pair)

    /// A multi-device account whose registered IRK is the recovered UMK's v1
    /// IRK (the normal, unrotated case), with gated cloud recovery enrolled
    /// and a second factor on file. The device is then wiped, so the VM runs
    /// as on a fresh phone.
    private func makeMultiTakeover() async throws -> (vm: RealAccountLoginViewModel, server: MockFlagshipServerClient, spy: InstallSpy, registeredPubHex: String) {
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")
        let registered = try await Keystore.deriveIRK(reason: "test", version: 1)
        let registeredPubHex = HexUtil.encode(registered.publicKey.rawRepresentation)

        let server = makeServer()
        try await server.claimUsername(.init(
            request: .init(username: "hilton", irkPub: registeredPubHex, issuedAt: 1),
            signature: "s"
        ))
        server.accountTypeByUser["hilton"] = "multi"
        server.totpEnrolledAtByUser["hilton"] = 1
        let enrol = RecoveryViewModel(
            client: server, webAuthn: MockWebAuthnProvider(), username: { "hilton" }
        )
        await enrol.setup(umkSeed: umk, passphrase: "correct horse battery staple")
        guard case .registered = enrol.phase else {
            throw XCTSkip("enrol failed: \(enrol.phase)")
        }

        Keystore.wipe()
        let spy = InstallSpy()
        let r = resolution(username: "hilton", kind: .multi, recoveryPresent: true, totpEnrolled: true, grace: .twentyFourHourTotp)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        vm.passphraseInput = "correct horse battery staple"
        return (vm, server, spy, registeredPubHex)
    }

    func test_multiTakeover_emptySecondFactor_failsBeforeRePair() async throws {
        defer { Keystore.wipe() }
        let (vm, server, spy, _) = try await makeMultiTakeover()

        XCTAssertFalse(vm.canStartMultiTakeover)
        await vm.startTakeover()

        guard case .failed = vm.phase else {
            return XCTFail("expected .failed for missing second factor, got \(vm.phase)")
        }
        XCTAssertNil(server.lastRePairInitiate, "must not initiate re-pair without a second factor")
        XCTAssertEqual(spy.callCount, 0, "must not install a UMK before the second factor is entered")
    }

    func test_multiTakeover_requiresPassphrase() async throws {
        defer { Keystore.wipe() }
        let (vm, _, _, _) = try await makeMultiTakeover()
        vm.secondFactorInput = "123456"
        vm.passphraseInput = ""
        XCTAssertFalse(vm.canStartMultiTakeover, "the gated unwrap needs the recovery passphrase")
    }

    /// The initiate displaces the REGISTERED key with a DIFFERENT incoming
    /// key (`.com` rejects old == new), and carries both credentials: the
    /// typed second factor and the recovery proof the gated fetch minted.
    func test_multiTakeover_withTotp_rotatesAndCarriesCredentials() async throws {
        defer { Keystore.wipe() }
        let (vm, server, spy, registeredPubHex) = try await makeMultiTakeover()
        vm.secondFactorInput = "123456"
        XCTAssertTrue(vm.canStartMultiTakeover)

        await vm.startTakeover()

        guard case .completed(let user, _) = vm.phase else {
            return XCTFail("expected .completed, got \(vm.phase)")
        }
        XCTAssertEqual(user, "hilton")
        XCTAssertEqual(spy.callCount, 1)
        let last = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertEqual(last.body.request.oldIrkPub.lowercased(), registeredPubHex)
        XCTAssertNotEqual(last.body.request.newIrkPub.lowercased(), registeredPubHex,
                          "the incoming key must differ from the registered one")
        let proof = try XCTUnwrap(last.body.totpProof, "multi re-pair MUST carry a totpProof")
        XCTAssertEqual(proof.code, "123456")
        XCTAssertEqual(proof.method, "totp")
        XCTAssertNotNil(last.body.recoveryProof, "the gated fetch's recovery proof must ride along")
        XCTAssertEqual(Keystore.pendingIrkRotationVersion(), 2)
    }

    func test_multiTakeover_withRecoveryCode_forwardsMethodRecovery() async throws {
        defer { Keystore.wipe() }
        let (vm, server, _, _) = try await makeMultiTakeover()
        vm.secondFactorInput = "ABCD-EFGH-IJ"

        await vm.startTakeover()

        let last = try XCTUnwrap(server.lastRePairInitiate)
        XCTAssertEqual(last.body.totpProof?.method, "recovery")
    }

    /// After grace, the completion is signed by the staged (rotated) key and
    /// the local IRK lineage commits to it.
    func test_grace_completeTakeover_finalizes_multi() async throws {
        defer { Keystore.wipe() }
        let (vm, _, _, _) = try await makeMultiTakeover()
        vm.secondFactorInput = "123456"

        await vm.startTakeover()
        guard case .completed = vm.phase else {
            return XCTFail("expected .completed (initiated, in grace), got \(vm.phase)")
        }

        await vm.completeTakeover()
        guard case .finalized(let user) = vm.phase else {
            return XCTFail("expected .finalized, got \(vm.phase)")
        }
        XCTAssertEqual(user, "hilton")
        XCTAssertEqual(Keystore.currentIrkVersion(), 2)
        XCTAssertNil(Keystore.pendingIrkRotationVersion())
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
        let r = resolution(username: "harry", kind: .single, recoveryPresent: true, grace: .threeDay)
        let vm = makeVM(resolution: r, server: server, installSpy: spy)
        await vm.startTakeover()
        guard case .failed = vm.phase else {
            return XCTFail("expected .failed when the envelope is missing, got \(vm.phase)")
        }
        XCTAssertEqual(spy.callCount, 0)
        XCTAssertNil(server.lastRePairInitiate)
    }
}
