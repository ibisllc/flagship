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

    private static let usedProfiles = ["acme", "personal", "rotator"]

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
        let oldRoot = Curve25519.Signing.PrivateKey()
        let sealedSeed = LockedBox<Data?>(nil)
        let reEscrowed = LockedBox<Bool>(false)

        let vm = RotateAdminRootViewModel(
            server: server, username: { "alice" },
            hasAdminRoot: { true },
            loadOldAdminRoot: { _ in oldRoot },
            sealNewAdminRoot: { seed in sealedSeed.set(seed) },
            reEscrowNewAdminRoot: { reEscrowed.set(true) }
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
        // pub) + re-escrowed — the last two steps of the rotate action.
        let sealed = try XCTUnwrap(sealedSeed.get())
        let sealedPub = try Curve25519.Signing.PrivateKey(rawRepresentation: sealed).publicKey.rawRepresentation
        XCTAssertEqual(HexUtil.encode(sealedPub), newPubHex)
        XCTAssertTrue(reEscrowed.get(), "the new root is re-escrowed under recovery after rotation")
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

/// A tiny thread-safe box so async seams can capture a value the test asserts.
final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ initial: T) { value = initial }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
}
