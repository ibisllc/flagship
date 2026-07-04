import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Slice D Phase 3 (iOS) — promote-a-device (seal-root, assurance-gated per
/// D-4), recovery-restore of the admin root, and rotate-admin-root.
///
/// Contract under test:
///   - the add-device SAS bundle carries `wrappedAdminRoot` ONLY when the
///     promote toggle is ON *and* this device holds the master root; the
///     incoming side seals it → becomes admin.
///   - `RotateAdminRootViewModel` signs `old → new` under the OLD root (spine
///     canonical bytes) and POSTs the proof; rotation excludes other admins.
///   - the WebAuthn-PRF recovery round-trip re-establishes the escrowed root.
final class AdminRootPhase3Tests: XCTestCase {

    private static let usedProfiles = ["acme", "personal", "rotator", "reescrow", "chain", "hazard"]

    private func resetKeystore() {
        for name in Self.usedProfiles {
            Keystore.setActiveProfile(name)
            Keystore.wipe()
        }
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
        Keystore.wipeAllProfiles()
    }

    override func setUp() async throws { resetKeystore() }
    override func tearDown() async throws { resetKeystore() }

    // MARK: - Spine canonical bytes (must match TS adminRootRotation.ts)

    func test_adminRootRotation_canonicalBytes_matchesSpine() {
        let r = AdminRootRotation(
            username: "alice",
            oldAdminRootPubHex: String(repeating: "aa", count: 32),
            newAdminRootPubHex: String(repeating: "bb", count: 32),
            issuedAt: 1_700_000_000_000
        )
        let expected = "flagship/admin-root-rotation/v1|alice|"
            + String(repeating: "aa", count: 32) + "|"
            + String(repeating: "bb", count: 32) + "|1700000000000"
        XCTAssertEqual(r.canonicalBytes(), Data(expected.utf8))
    }

    func test_adminRootRotation_signVerify_onlyUnderOldRoot() throws {
        let oldRoot = Curve25519.Signing.PrivateKey()
        let newRoot = Curve25519.Signing.PrivateKey()
        let r = AdminRootRotation(
            username: "alice",
            oldAdminRootPubHex: HexUtil.encode(oldRoot.publicKey.rawRepresentation),
            newAdminRootPubHex: HexUtil.encode(newRoot.publicKey.rawRepresentation),
            issuedAt: 42
        )
        let sig = try r.sign(withOldAdminRoot: oldRoot)
        XCTAssertTrue(r.verify(signature: sig, oldAdminRootPub: oldRoot.publicKey.rawRepresentation))
        // The NEW root did NOT sign it — verifying under the new root fails.
        XCTAssertFalse(r.verify(signature: sig, oldAdminRootPub: newRoot.publicKey.rawRepresentation))
    }

    // MARK: - PairingBundle carries wrappedAdminRoot (back-compat)

    func test_pairingBundle_wrappedAdminRoot_backCompatCodec() throws {
        // Absent → decodes to nil (a pre-D bundle).
        let bare = PairingBundle(
            umkSeedHex: String(repeating: "ab", count: 32),
            admit: .init(username: "acme", newDevicePubHex: "cd", issuedAt: 7),
            admitSig: "ef", irkPubHex: "01"
        )
        let bareDecoded = try PairingBundle.decode(bare.encoded())
        XCTAssertNil(bareDecoded.wrappedAdminRoot)
        // Explicit pre-D JSON (no key) still decodes.
        let legacyJson = Data(#"{"umkSeedHex":"00","admit":{"username":"a","newDevicePubHex":"b","issuedAt":1},"admitSig":"c","irkPubHex":"d"}"#.utf8)
        XCTAssertNil(try PairingBundle.decode(legacyJson).wrappedAdminRoot)
        // Present → round-trips.
        let promoted = PairingBundle(
            umkSeedHex: String(repeating: "ab", count: 32),
            admit: .init(username: "acme", newDevicePubHex: "cd", issuedAt: 7),
            admitSig: "ef", irkPubHex: "01",
            wrappedAdminRoot: String(repeating: "77", count: 32)
        )
        XCTAssertEqual(try PairingBundle.decode(promoted.encoded()), promoted)
    }

    // MARK: - Promote ON → bundle carries the root; incoming seals it

    @MainActor
    func test_promoteOn_bundleCarriesAdminRoot_incomingBecomesAdmin() async throws {
        let accountIrk = Curve25519.Signing.PrivateKey()
        let acmeUmkHex = HexUtil.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
        let adminRoot = Curve25519.Signing.PrivateKey()
        let adminSeedHex = HexUtil.encode(adminRoot.rawRepresentation)

        let relay = MockPairingRelayClient()
        let server = MockFlagshipServerClient()

        let adminVm = AddDeviceViewModel(
            account: "acme", relay: relay,
            deriveIRK: { _ in accountIrk },
            currentUMKHex: { _ in acmeUmkHex },
            canPromoteToAdmin: true,
            adminRootSeedHex: { _ in adminSeedHex }
        )
        adminVm.promoteNewDeviceToAdmin = true   // D-4 toggle ON

        // Incoming: spy the admin-root seal so we assert the exact seed lands.
        let importedSeed = LockedBox<Data?>(nil)
        let incomingVm = JoinAccountViewModel(
            relay: relay, server: server, deviceLabel: "Partner iPhone",
            importAdminRoot: { seed in importedSeed.set(seed) }
        )

        try await runPairing(adminVm: adminVm, incomingVm: incomingVm, relay: relay)

        guard case .joined(let acct, _) = incomingVm.phase else {
            return XCTFail("incoming not joined; phase=\(incomingVm.phase)")
        }
        XCTAssertEqual(acct, "acme")
        XCTAssertTrue(incomingVm.becameAdmin, "a promoted device reports becameAdmin")
        XCTAssertEqual(importedSeed.get(), adminRoot.rawRepresentation,
                       "the EXACT admin master root seed was sealed on the incoming device")
    }

    // MARK: - Promote OFF → no root carried; incoming stays non-admin

    @MainActor
    func test_promoteOff_noAdminRoot_incomingStaysNonAdmin() async throws {
        let relay = MockPairingRelayClient()
        let server = MockFlagshipServerClient()
        let adminVm = AddDeviceViewModel(
            account: "acme", relay: relay,
            deriveIRK: { _ in Curve25519.Signing.PrivateKey() },
            currentUMKHex: { _ in HexUtil.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }) },
            canPromoteToAdmin: true,
            adminRootSeedHex: { _ in XCTFail("must NOT read the admin root when promote is OFF"); return "" }
        )
        adminVm.promoteNewDeviceToAdmin = false   // default OFF

        let importCalled = LockedBox<Bool>(false)
        let incomingVm = JoinAccountViewModel(
            relay: relay, server: server,
            importAdminRoot: { _ in importCalled.set(true) }
        )
        try await runPairing(adminVm: adminVm, incomingVm: incomingVm, relay: relay)

        guard case .joined = incomingVm.phase else {
            return XCTFail("incoming not joined; phase=\(incomingVm.phase)")
        }
        XCTAssertFalse(incomingVm.becameAdmin)
        XCTAssertFalse(importCalled.get(), "no wrappedAdminRoot ⇒ the incoming side never seals a root")
    }

    // MARK: - Promote toggle inert on a non-admin device (can't seal what it lacks)

    @MainActor
    func test_promote_ignoredWhenDeviceLacksMasterRoot() async throws {
        let relay = MockPairingRelayClient()
        let server = MockFlagshipServerClient()
        let adminVm = AddDeviceViewModel(
            account: "acme", relay: relay,
            deriveIRK: { _ in Curve25519.Signing.PrivateKey() },
            currentUMKHex: { _ in HexUtil.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }) },
            canPromoteToAdmin: false,   // this device holds NO master root
            adminRootSeedHex: { _ in XCTFail("a non-admin device has no root to seal"); return "" }
        )
        adminVm.promoteNewDeviceToAdmin = true   // toggle on, but gated off by canPromote

        let importCalled = LockedBox<Bool>(false)
        let incomingVm = JoinAccountViewModel(
            relay: relay, server: server,
            importAdminRoot: { _ in importCalled.set(true) }
        )
        try await runPairing(adminVm: adminVm, incomingVm: incomingVm, relay: relay)

        XCTAssertFalse(incomingVm.becameAdmin)
        XCTAssertFalse(importCalled.get())
    }

    // MARK: - Rotate: signs old→new under the old root + posts the proof

    @MainActor
    func test_rotate_signsOldToNew_underOldRoot_andPosts() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let oldRoot = Curve25519.Signing.PrivateKey()
        let sealedSeed = LockedBox<Data?>(nil)

        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in oldRoot },
            sealNewAdminRoot: { seed in sealedSeed.set(seed) },
            recoveryEnrolled: { false }
        )
        await vm.rotate()

        guard case .rotated(let newPubHex) = vm.phase else {
            return XCTFail("expected rotated; phase=\(vm.phase)")
        }
        let oldPubHex = HexUtil.encode(oldRoot.publicKey.rawRepresentation)
        XCTAssertNotEqual(newPubHex, oldPubHex, "the new root is fresh random, not the old one")

        // Exactly one proof was posted with the right shape.
        XCTAssertEqual(server.adminRootRotations.count, 1)
        let posted = try XCTUnwrap(server.adminRootRotations.first)
        XCTAssertEqual(posted.rotation.username, "alice")
        XCTAssertEqual(posted.rotation.oldAdminRootPub, oldPubHex)
        XCTAssertEqual(posted.rotation.newAdminRootPub, newPubHex)

        // The posted signature verifies under the OLD root (old signs old→new),
        // and NOT under the new root — the box-side check the daemon runs.
        let proof = AdminRootRotation(
            username: posted.rotation.username,
            oldAdminRootPubHex: posted.rotation.oldAdminRootPub,
            newAdminRootPubHex: posted.rotation.newAdminRootPub,
            issuedAt: posted.rotation.issuedAt
        )
        let sig = try XCTUnwrap(HexUtil.decode(posted.signatureHex))
        XCTAssertTrue(proof.verify(signature: sig, oldAdminRootPub: oldRoot.publicKey.rawRepresentation),
                      "the rotation proof MUST verify under the OLD admin root")
        XCTAssertFalse(proof.verify(signature: sig, oldAdminRootPub: try XCTUnwrap(HexUtil.decode(newPubHex))),
                       "…and MUST NOT verify under the new root (old→new is one-directional)")

        // The new root was re-sealed locally (its pub matches the posted new
        // pub) — the last mutating step of the rotate action.
        let sealed = try XCTUnwrap(sealedSeed.get())
        let sealedPub = try Curve25519.Signing.PrivateKey(rawRepresentation: sealed).publicKey.rawRepresentation
        XCTAssertEqual(HexUtil.encode(sealedPub), newPubHex)
    }

    @MainActor
    func test_rotate_refusesOnNonAdminDevice() async {
        let server = MockFlagshipServerClient()
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { false },
            loadOldAdminRoot: { _ in XCTFail("must not load a root"); return Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in XCTFail("must not seal") }
        )
        XCTAssertFalse(vm.canRotate)
        await vm.rotate()
        guard case .failed = vm.phase else { return XCTFail("expected failed; phase=\(vm.phase)") }
        XCTAssertTrue(server.adminRootRotations.isEmpty, "a non-admin device posts nothing")
    }

    // MARK: - Rotate → post-rotation recovery re-escrow phase (§5.3 / D-3)

    @MainActor
    func test_rotate_recoveryEnrolled_landsInNeedsRecoveryUpdate() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in },
            recoveryEnrolled: { true },
            reEscrow: { _ in XCTFail("re-escrow is user-driven (passphrase), never automatic") }
        )
        await vm.rotate()
        guard case .rotatedNeedsRecoveryUpdate = vm.phase else {
            return XCTFail("expected rotatedNeedsRecoveryUpdate; phase=\(vm.phase)")
        }
        // Exactly one rotation was still posted — the re-escrow phase comes
        // strictly AFTER the rotation is published + sealed.
        XCTAssertEqual(server.adminRootRotations.count, 1)
    }

    @MainActor
    func test_rotate_recoveryNotEnrolled_skipsStraightToRotated() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let reEscrowCalled = LockedBox<Bool>(false)
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in },
            recoveryEnrolled: { false },
            reEscrow: { _ in reEscrowCalled.set(true) }
        )
        await vm.rotate()
        guard case .rotated = vm.phase else {
            return XCTFail("expected rotated; phase=\(vm.phase)")
        }
        XCTAssertFalse(reEscrowCalled.get(), "no enrollment ⇒ no re-escrow prompt, no invocation")
    }

    @MainActor
    func test_rotate_recoveryCheckThrows_treatedAsNotEnrolled() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in },
            recoveryEnrolled: { throw ScreensClientError.http(status: 503, message: "flaky") },
            reEscrow: { _ in XCTFail("must not re-escrow when the check failed") }
        )
        await vm.rotate()
        guard case .rotated = vm.phase else {
            return XCTFail("a failed enrollment check must NEVER fail the rotation; phase=\(vm.phase)")
        }
        XCTAssertEqual(server.adminRootRotations.count, 1)
    }

    @MainActor
    func test_updateRecoveryBackup_success_completesToRotated() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let passed = LockedBox<String?>(nil)
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in },
            recoveryEnrolled: { true },
            reEscrow: { p in passed.set(p) }
        )
        await vm.rotate()
        guard case .rotatedNeedsRecoveryUpdate(let newPubHex) = vm.phase else {
            return XCTFail("expected rotatedNeedsRecoveryUpdate; phase=\(vm.phase)")
        }
        await vm.updateRecoveryBackup(passphrase: "correcthorse")
        XCTAssertEqual(passed.get(), "correcthorse")
        XCTAssertNil(vm.recoveryUpdateError)
        guard case .rotated(let donePubHex) = vm.phase else {
            return XCTFail("expected rotated; phase=\(vm.phase)")
        }
        XCTAssertEqual(donePubHex, newPubHex, "the completed phase carries the SAME new root")
    }

    @MainActor
    func test_updateRecoveryBackup_failureStaysRetryable_thenSkipCompletes() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let attempts = LockedBox<Int>(0)
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in },
            recoveryEnrolled: { true },
            reEscrow: { _ in
                attempts.set(attempts.get() + 1)
                throw AdminRootReEscrow.ReEscrowError.wrongPassphrase
            }
        )
        await vm.rotate()
        await vm.updateRecoveryBackup(passphrase: "wrong")
        guard case .rotatedNeedsRecoveryUpdate = vm.phase else {
            return XCTFail("a re-escrow failure must keep the step on screen; phase=\(vm.phase)")
        }
        XCTAssertEqual(vm.recoveryUpdateError, "That passphrase didn't match.")

        // Retryable: the failed attempt didn't consume the step.
        await vm.updateRecoveryBackup(passphrase: "wrong-again")
        XCTAssertEqual(attempts.get(), 2)
        guard case .rotatedNeedsRecoveryUpdate = vm.phase else {
            return XCTFail("still retryable; phase=\(vm.phase)")
        }

        // Skip completes the flow but flags the stale backup.
        vm.skipRecoveryUpdate()
        guard case .rotated = vm.phase else {
            return XCTFail("expected rotated after skip; phase=\(vm.phase)")
        }
        XCTAssertTrue(vm.didSkipRecoveryUpdate)
        XCTAssertNil(vm.recoveryUpdateError)
    }

    @MainActor
    func test_updateRecoveryBackup_retryAfterFailure_succeeds() async {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let attempts = LockedBox<Int>(0)
        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in Curve25519.Signing.PrivateKey() },
            sealNewAdminRoot: { _ in },
            recoveryEnrolled: { true },
            reEscrow: { _ in
                attempts.set(attempts.get() + 1)
                if attempts.get() == 1 { throw AdminRootReEscrow.ReEscrowError.wrongPassphrase }
            }
        )
        await vm.rotate()
        await vm.updateRecoveryBackup(passphrase: "wrong")
        guard case .rotatedNeedsRecoveryUpdate = vm.phase else {
            return XCTFail("expected needs-update after failure; phase=\(vm.phase)")
        }
        await vm.updateRecoveryBackup(passphrase: "correcthorse")
        guard case .rotated = vm.phase else {
            return XCTFail("a retry with the right passphrase completes; phase=\(vm.phase)")
        }
        XCTAssertFalse(vm.didSkipRecoveryUpdate)
    }

    // MARK: - The re-escrow mechanism itself (real Keystore + mock client/PRF)

    /// Full happy path: enroll recovery (escrows the ORIGINAL root), rotate the
    /// LOCAL admin root, run `AdminRootReEscrow` — the stored record keeps the
    /// SAME credentialId + byte-identical wrappedUmk/wrappedAcme, and the NEW
    /// wrappedAdminRoot unwraps (under the same PRF secret) to the CURRENT
    /// Keystore admin root.
    @MainActor
    func test_reEscrow_replacesOnlyAdminRoot_passthroughEnvelope() async throws {
        let user = "reescrow"
        Keystore.setActiveProfile(user)
        _ = try await Keystore.openAccountRoots(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let webAuthn = MockWebAuthnProvider()
        let recovery = RecoveryViewModel(client: server, webAuthn: webAuthn, username: { user })
        await recovery.setup(umkSeed: umk, passphrase: "correcthorse")
        guard case .registered(let credentialId) = recovery.phase else {
            return XCTFail("recovery setup failed: \(recovery.phase)")
        }

        let secrets = try RecoveryDerivation.derivePassphraseSecrets("correcthorse", user)
        let before = try await server.fetchWrappedUmk(
            username: user, fetchTokenHex: HexUtil.encode(secrets.fetchToken)
        )
        let oldWrappedAdmin = try XCTUnwrap(before.wrappedAdminRoot)

        // Rotate the LOCAL root (what RotateAdminRootViewModel's seal step does).
        let newRoot = Curve25519.Signing.PrivateKey()
        _ = try await Keystore.importAdminRoot(seed: newRoot.rawRepresentation, reason: "test")

        try await AdminRootReEscrow(client: server, webAuthn: webAuthn)
            .run(username: user, passphrase: "correcthorse")

        let after = try await server.fetchWrappedUmk(
            username: user, fetchTokenHex: HexUtil.encode(secrets.fetchToken)
        )
        XCTAssertEqual(after.credentialId, credentialId, "SAME credential ⇒ replaced in place")
        XCTAssertEqual(after.wrappedUmk, before.wrappedUmk, "wrappedUmk passes through unchanged")
        XCTAssertEqual(after.wrappedAcmeAccountKey, before.wrappedAcmeAccountKey,
                       "wrappedAcmeAccountKey passes through unchanged")
        let newWrappedAdmin = try XCTUnwrap(after.wrappedAdminRoot)
        XCTAssertNotEqual(newWrappedAdmin, oldWrappedAdmin)

        // The new blob unwraps under the SAME PRF secret to the CURRENT root.
        let prfSecret = try await webAuthn.prfAssert(
            credentialId: after.credentialId, prfSalt: secrets.prfSalt
        )
        let unwrapped = try AdminRootEscrow.unwrapFromEscrow(base64: newWrappedAdmin, prfSecret: prfSecret)
        XCTAssertEqual(unwrapped, newRoot.rawRepresentation)
        XCTAssertEqual(
            HexUtil.encode(try Curve25519.Signing.PrivateKey(rawRepresentation: unwrapped).publicKey.rawRepresentation),
            Keystore.adminRootPubHex(),
            "restore now yields the rotated Keystore root"
        )
    }

    /// The three abort paths — wrong passphrase (403), prfSaltHash tamper, and
    /// a wrap-key sanity failure — must all throw WITHOUT posting (the stored
    /// wrappedAdminRoot stays byte-identical).
    @MainActor
    func test_reEscrow_abortPaths_neverPost() async throws {
        let user = "reescrow"
        Keystore.setActiveProfile(user)
        _ = try await Keystore.openAccountRoots(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let webAuthn = MockWebAuthnProvider()
        let recovery = RecoveryViewModel(client: server, webAuthn: webAuthn, username: { user })
        await recovery.setup(umkSeed: umk, passphrase: "correcthorse")
        guard case .registered = recovery.phase else {
            return XCTFail("recovery setup failed: \(recovery.phase)")
        }
        let secrets = try RecoveryDerivation.derivePassphraseSecrets("correcthorse", user)
        let baseline = try await server.fetchWrappedUmk(
            username: user, fetchTokenHex: HexUtil.encode(secrets.fetchToken)
        ).wrappedAdminRoot

        // (a) Wrong passphrase ⇒ the gated fetch 403s.
        do {
            try await AdminRootReEscrow(client: server, webAuthn: webAuthn)
                .run(username: user, passphrase: "not-the-passphrase")
            XCTFail("expected wrongPassphrase")
        } catch let e as AdminRootReEscrow.ReEscrowError {
            XCTAssertEqual(e, .wrongPassphrase)
        }

        // (b) A tampered prfSaltHash from `.com` ⇒ refuse before PRF/upload.
        server.tamperedPrfSaltHashOnFetch = String(repeating: "0", count: 64)
        do {
            try await AdminRootReEscrow(client: server, webAuthn: webAuthn)
                .run(username: user, passphrase: "correcthorse")
            XCTFail("expected prfSaltMismatch")
        } catch let e as AdminRootReEscrow.ReEscrowError {
            XCTAssertEqual(e, .prfSaltMismatch)
        }
        server.tamperedPrfSaltHashOnFetch = nil

        // (c) A PRF secret that can't unwrap the stored wrappedUmk ⇒ the
        // sanity gate refuses BEFORE overwriting a working escrow.
        do {
            try await AdminRootReEscrow(client: server, webAuthn: GarbagePrfProvider())
                .run(username: user, passphrase: "correcthorse")
            XCTFail("expected wrapKeySanityFailed")
        } catch let e as AdminRootReEscrow.ReEscrowError {
            XCTAssertEqual(e, .wrapKeySanityFailed)
        }

        let final = try await server.fetchWrappedUmk(
            username: user, fetchTokenHex: HexUtil.encode(secrets.fetchToken)
        ).wrappedAdminRoot
        XCTAssertEqual(final, baseline, "no abort path may mutate the stored record")
    }

    // MARK: - Recovery restore round-trip (real Keystore, PRF escrow)

    @MainActor
    func test_recovery_restoresAdminRoot_roundTrip() async throws {
        let user = "rotator"
        Keystore.setActiveProfile(user)

        // First device: mint UMK + admin root, capture the admin pub.
        let roots = try await Keystore.openAccountRoots(reason: "test")
        let originalAdminPub = roots.adminRootPubHex
        XCTAssertTrue(Keystore.hasAdminRoot)
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = MockFlagshipServerClient()
        let vm = RecoveryViewModel(client: server, webAuthn: MockWebAuthnProvider(), username: { user })

        // Enroll — this escrows the admin root (Phase 2 wired side).
        await vm.setup(umkSeed: umk, passphrase: "correcthorse")
        guard case .registered = vm.phase else {
            return XCTFail("recovery setup failed: \(vm.phase)")
        }

        // Simulate a fresh device: wipe local key material for this profile.
        Keystore.wipe()
        XCTAssertFalse(Keystore.hasAdminRoot)

        // Recover — must re-establish the admin root device-local (restore side).
        let seed = await vm.recover(username: user, passphrase: "correcthorse")
        XCTAssertNotNil(seed, "UMK recovered")
        XCTAssertTrue(Keystore.hasAdminRoot, "credential recovery re-establishes the admin root")
        XCTAssertEqual(Keystore.adminRootPubHex(), originalAdminPub,
                       "the recovered admin root is byte-identical to the original")
    }

    // MARK: - Adversarial rotate→recover chain (2026-07-03 invariant, VM-level)

    /// LIVE-root restore: rotate the local admin root, RE-ESCROW under the
    /// recovery credential, then recover on a fresh device — the restored root
    /// is the CURRENT (rotated) one, not the enrolled original.
    @MainActor
    func test_rotate_reEscrow_recover_restoresLiveRoot() async throws {
        let user = "chain"
        Keystore.setActiveProfile(user)
        let roots = try await Keystore.openAccountRoots(reason: "test")
        let pub0 = roots.adminRootPubHex
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let webAuthn = MockWebAuthnProvider()
        let recovery = RecoveryViewModel(client: server, webAuthn: webAuthn, username: { user })
        await recovery.setup(umkSeed: umk, passphrase: "correcthorse")   // escrows root0
        guard case .registered = recovery.phase else {
            return XCTFail("recovery setup failed: \(recovery.phase)")
        }

        // Rotate the LOCAL admin root (what RotateAdminRootViewModel's seal does)
        // then re-escrow the NEW root under the SAME credential.
        let newRoot = Curve25519.Signing.PrivateKey()
        _ = try await Keystore.importAdminRoot(seed: newRoot.rawRepresentation, reason: "test")
        let pub1 = Keystore.adminRootPubHex()
        XCTAssertNotEqual(pub1, pub0, "the rotated root is fresh, not the enrolled one")
        try await AdminRootReEscrow(client: server, webAuthn: webAuthn)
            .run(username: user, passphrase: "correcthorse")

        // Fresh device: wipe local key material, then recover from the escrow.
        Keystore.wipe()
        XCTAssertFalse(Keystore.hasAdminRoot)
        let seed = await recovery.recover(username: user, passphrase: "correcthorse")
        XCTAssertNotNil(seed, "UMK recovered")
        XCTAssertTrue(Keystore.hasAdminRoot, "recovery re-establishes the admin root")
        XCTAssertEqual(Keystore.adminRootPubHex(), pub1,
                       "recovery restores the LIVE (rotated) root after re-escrow")
        XCTAssertNotEqual(Keystore.adminRootPubHex(), pub0)
    }

    /// HAZARD (skipRecoveryUpdate): rotate the local root but SKIP the re-escrow
    /// → recovery restores the DEAD (pre-rotation) root. Pinned so the hazard is
    /// explicit and a future auto-re-escrow change flips this test.
    @MainActor
    func test_rotate_skipReEscrow_recover_restoresDeadRoot() async throws {
        let user = "hazard"
        Keystore.setActiveProfile(user)
        let roots = try await Keystore.openAccountRoots(reason: "test")
        let pub0 = roots.adminRootPubHex
        let umk = try await Keystore.currentUMK(reason: "test")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let webAuthn = MockWebAuthnProvider()
        let recovery = RecoveryViewModel(client: server, webAuthn: webAuthn, username: { user })
        await recovery.setup(umkSeed: umk, passphrase: "correcthorse")   // escrows root0
        guard case .registered = recovery.phase else {
            return XCTFail("recovery setup failed: \(recovery.phase)")
        }

        // Rotate the LOCAL root but DO NOT re-escrow (the skip path).
        let newRoot = Curve25519.Signing.PrivateKey()
        _ = try await Keystore.importAdminRoot(seed: newRoot.rawRepresentation, reason: "test")
        let pub1 = Keystore.adminRootPubHex()
        XCTAssertNotEqual(pub1, pub0)

        // Fresh device: recover. The escrow still wraps root0, so recovery brings
        // back the DEAD root — NOT the live rotated one.
        Keystore.wipe()
        _ = await recovery.recover(username: user, passphrase: "correcthorse")
        XCTAssertTrue(Keystore.hasAdminRoot)
        XCTAssertEqual(Keystore.adminRootPubHex(), pub0,
                       "skip-re-escrow ⇒ recovery restores the stale/dead pre-rotation root")
        XCTAssertNotEqual(Keystore.adminRootPubHex(), pub1,
                          "…NOT the live rotated root — the documented skip-recovery hazard")
    }

    // MARK: - Helpers

    /// Drive an admin↔incoming pairing over the mock relay to `.joined`,
    /// mirroring the Phase-3b end-to-end harness.
    @MainActor
    private func runPairing(
        adminVm: AddDeviceViewModel,
        incomingVm: JoinAccountViewModel,
        relay: MockPairingRelayClient
    ) async throws {
        let adminStart = Task { await adminVm.start() }
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .waitingForDevice(let joinUrl) = adminVm.phase else {
            adminStart.cancel()
            throw XCTSkip("admin not waiting; phase=\(adminVm.phase)")
        }
        let incomingTask = Task {
            await incomingVm.connect(
                joinUrl: joinUrl,
                provideRawPubkeyToRelay: { raw in relay.provideRawIncomingPubkey(raw) }
            )
        }
        await adminStart.value
        adminVm._forceGateExpiredForTests()
        await adminVm.confirmMatch()
        await incomingTask.value
    }
}

/// WebAuthnProvider whose PRF output is garbage — drives the re-escrow wrap-key
/// sanity gate (the fetched wrappedUmk must NOT unwrap under it).
final class GarbagePrfProvider: WebAuthnProvider, @unchecked Sendable {
    func register(prfSalt: Data) async throws -> WebAuthnRegistration {
        WebAuthnRegistration(credentialId: "aabbccdd0011223344556677")
    }
    func assertAny() async throws -> WebAuthnRegistration {
        WebAuthnRegistration(credentialId: "aabbccdd0011223344556677")
    }
    func prfAssert(credentialId: String, prfSalt: Data) async throws -> Data {
        Data(repeating: 0x42, count: 32)
    }
}

/// A tiny thread-safe box so async seams can capture a value the test asserts.
final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ initial: T) { value = initial }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
}
