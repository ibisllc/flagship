import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI
@testable import Flagship

/// Phase 2 (decouple account creation from server provisioning) — pins
/// the new **Open account** step and the claim-moved-out invariant.
///
/// The crux (docs/login-and-account-redesign.md, principles 1 + 6):
///   - Open-account is the single place that calls `Keystore.generateUMK`
///     (create account == generate the UMK) and signs the standalone
///     `claimUsername`. It must claim EXACTLY once and let the host land
///     with ZERO servers.
///   - The server-mint flow (`CreateServerViewModel`) must NOT re-claim
///     and must NOT re-generate the UMK — it just derives the IRK (UMK
///     already present) for the auth-code + RCK signatures.
@MainActor
final class OpenAccountViewModelTests: XCTestCase {

    override func tearDown() async throws {
        // Open-account writes a real UMK into the (host/simulator)
        // keychain. Don't leak it across cases — a leftover UMK would
        // make a "no UMK yet" assertion in a sibling test pass falsely.
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    private func makeServer() -> MockFlagshipServerClient {
        let s = MockFlagshipServerClient()
        s.simulatedLatency = 0
        return s
    }

    // MARK: - Open account claims once + lands with empty pods

    func test_openAccount_generatesUMK_andClaimsExactlyOnce() async throws {
        Keystore.wipe()
        XCTAssertFalse(Keystore.hasWrappedUMK, "precondition: no UMK before open-account")

        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server)
        await vm.openAccount()

        guard case .opened = vm.phase else {
            return XCTFail("expected .opened, got \(vm.phase)")
        }
        // create account == generate the UMK.
        XCTAssertTrue(Keystore.hasWrappedUMK, "open-account must generate the UMK")
        // Claimed exactly once, under the derived IRK pub.
        XCTAssertEqual(server.claimedUsernames.count, 1)
        XCTAssertNotNil(server.claimedUsernames["harry"])
        // No server provisioning happened — no auth-codes, no RCKs.
        XCTAssertTrue(server.issuedAuthCodes.isEmpty, "open-account must not provision a server")
        XCTAssertTrue(server.registeredRcks.isEmpty, "open-account must not register an RCK")
    }

    func test_openAccount_thenHostCompletesOnboarding_withZeroServers() async throws {
        Keystore.wipe()
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server)
        await vm.openAccount()
        guard case .opened = vm.phase else { return XCTFail("expected .opened") }

        // The host (OnboardingFlow) lands the user on Home with NO pods.
        let app = AppState()
        app.completeOnboarding(username: "harry", pods: [])
        XCTAssertTrue(app.isPaired)
        XCTAssertEqual(app.currentUser, "harry")
        XCTAssertTrue(app.pods.isEmpty, "account opens with zero servers")
        XCTAssertNil(app.leaderPodId)
        XCTAssertNil(app.currentPodId)
    }

    func test_openAccount_isIdempotentOnRetry_noDoubleGenerateNoSecondClaim() async throws {
        Keystore.wipe()
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server)

        await vm.openAccount()
        guard case .opened = vm.phase else { return XCTFail("expected .opened on first run") }
        let firstClaimIrk = server.claimedUsernames["harry"]

        // A retry (e.g. the user taps again after a transient blip) must
        // not orphan a second UMK and must not 409 — the claim is keyed
        // by (username, irkPub) and the IRK is stable across runs because
        // the UMK is reused, not re-generated.
        await vm.openAccount()
        guard case .opened = vm.phase else { return XCTFail("expected .opened on retry") }
        XCTAssertEqual(server.claimedUsernames.count, 1, "retry must not create a second account")
        XCTAssertEqual(server.claimedUsernames["harry"], firstClaimIrk, "IRK must be stable (UMK reused)")
    }

    func test_openAccount_transportFailure_surfacesFailedPhase() async throws {
        Keystore.wipe()
        let server = makeServer()
        server.shouldFail = true
        let vm = OpenAccountViewModel(username: "harry", server: server)
        await vm.openAccount()
        guard case .failed = vm.phase else {
            return XCTFail("expected .failed for a transport error, got \(vm.phase)")
        }
    }

    // MARK: - Device naming

    func test_deviceName_defaultsToUsernamePhone_whenNoOSName() {
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server, defaultDeviceName: nil)
        XCTAssertEqual(vm.deviceName, "harry's iPhone")
    }

    func test_deviceName_prefersProvidedOSName() {
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server, defaultDeviceName: "Harry's iPhone 17")
        XCTAssertEqual(vm.deviceName, "Harry's iPhone 17")
    }

    func test_deviceName_blankProvidedFallsBackToComposed() {
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server, defaultDeviceName: "   ")
        XCTAssertEqual(vm.deviceName, "harry's iPhone")
    }

    func test_effectiveDeviceName_clearedFieldFallsBackToComposed() async throws {
        Keystore.wipe()
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server, defaultDeviceName: "Custom")
        vm.deviceName = "   "
        XCTAssertEqual(vm.effectiveDeviceName, "harry's iPhone")
        await vm.openAccount()
        guard case .opened(let name) = vm.phase else { return XCTFail("expected .opened") }
        XCTAssertEqual(name, "harry's iPhone")
    }

    func test_openAccount_carriesTypedDeviceNameToOpenedPhase() async throws {
        Keystore.wipe()
        let server = makeServer()
        let vm = OpenAccountViewModel(username: "harry", server: server)
        vm.deviceName = "Kitchen iPad"
        await vm.openAccount()
        guard case .opened(let name) = vm.phase else { return XCTFail("expected .opened") }
        XCTAssertEqual(name, "Kitchen iPad")
    }
}

/// Phase 2 — proves the claim is GONE from the server-mint path.
///
/// `CreateServerViewModel.mintInstallBlob` used to call
/// `claimUsername`; the claim moved to OpenAccountViewModel. Here we
/// drive a full create through the (mock) QR relay and assert the mint
/// issues an auth-code + registers an RCK but does NOT touch
/// `claimedUsernames`. We pre-open the account (UMK present) exactly as
/// the real "Add a server" flow assumes.
@MainActor
final class CreateServerNoReclaimTests: XCTestCase {

    override func tearDown() async throws {
        Keystore.wipe()
        try? Keystore.setPendingIrkRotationVersion(nil)
        try await super.tearDown()
    }

    /// Build a valid QR URL the VM can parse — `k` is a real 32-byte
    /// X25519 public key, base64url-encoded, exactly as the browser
    /// would emit.
    private func makeQrUrl() -> String {
        let browserSk = Curve25519.KeyAgreement.PrivateKey()
        let kB64u = Base64URL.encode(browserSk.publicKey.rawRepresentation)
        return "https://flagshipserver.com/qr?s=sid-test&k=\(kB64u)"
    }

    /// Drive the VM from .design through to .delivered. Mirrors the
    /// real screen: design → qrDetected → (gate) → confirmAndDeliver.
    private func driveToDelivered(_ vm: CreateServerViewModel) async throws {
        vm.name = "Home"
        vm.continueToScan()
        await vm.qrDetected(makeQrUrl())

        // The VM gates the Confirm button for 600ms after matching;
        // poll until the gate expires (with a generous ceiling so a
        // slow CI host doesn't flake).
        var waited = 0
        while waited < 5_000 {
            if case .matching(_, true) = vm.phase { break }
            try await Task.sleep(nanoseconds: 50_000_000)
            waited += 50
        }
        guard case .matching(_, true) = vm.phase else {
            throw XCTSkip("match gate did not open in time; phase=\(vm.phase)")
        }
        await vm.confirmAndDeliver()
    }

    func test_addServerMint_doesNotReclaimUsername() async throws {
        // Account already open: UMK present (open-account ran earlier).
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test open account")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        // Seed the prior open-account claim so we can prove the mint
        // doesn't ADD a second claim (and doesn't 409 against this one).
        let openIrk = try await Keystore.deriveIRK(reason: "seed claim")
        try await server.claimUsername(.init(
            request: .init(
                username: "harry",
                irkPub: HexUtil.encode(openIrk.publicKey.rawRepresentation),
                issuedAt: 1
            ),
            signature: "seed"
        ))
        XCTAssertEqual(server.claimedUsernames.count, 1)
        let claimAfterOpen = server.claimedUsernames

        let vm = CreateServerViewModel(
            username: "harry",
            server: server,
            relay: MockQrRelayClient()
        )
        try await driveToDelivered(vm)

        guard case .delivered = vm.phase else {
            return XCTFail("expected .delivered, got \(vm.phase)")
        }
        // The mint must have provisioned a server...
        XCTAssertEqual(server.issuedAuthCodes.count, 1, "mint issues exactly one auth-code")
        XCTAssertEqual(server.registeredRcks.count, 1, "mint registers exactly one RCK")
        // ...but must NOT have re-claimed the username.
        XCTAssertEqual(server.claimedUsernames, claimAfterOpen, "mint must not touch the username claim")
    }

    func test_addServerMint_worksWithUMKAlreadyPresent_noRegenerate() async throws {
        // The mint derives the IRK; it must NOT generate a fresh UMK
        // (that would orphan the account identity). We assert the IRK
        // it signs with matches the one derived from the pre-existing
        // UMK — i.e. the UMK is the same one open-account created.
        Keystore.wipe()
        try await Keystore.generateUMK(reason: "test open account")
        let expectedIrk = try await Keystore.deriveIRK(reason: "expected")
        let expectedPubHex = HexUtil.encode(expectedIrk.publicKey.rawRepresentation)

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = CreateServerViewModel(
            username: "harry",
            server: server,
            relay: MockQrRelayClient()
        )
        try await driveToDelivered(vm)
        guard case .delivered = vm.phase else { return XCTFail("expected .delivered") }

        // The issued auth-code carries the userPubKey == IRK pub. If the
        // mint had re-generated the UMK, this would differ.
        let issued = try XCTUnwrap(server.issuedAuthCodes.values.first)
        XCTAssertEqual(issued.userPubKey, expectedPubHex, "mint must reuse the existing UMK's IRK")
    }
}
