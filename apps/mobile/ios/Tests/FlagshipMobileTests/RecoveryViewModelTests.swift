import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// End-to-end coverage of the native WebAuthn-PRF cloud-recovery flow
/// (Tasks #2 + #4) against the Mock server + Mock authenticator:
///   - enroll ships fetchTokenHash + prfSaltHash + a HEX credentialId,
///   - the gated fetch round-trips the wrapped UMK back,
///   - recover re-derives, verifies prfSaltHash, PRF-unwraps the ORIGINAL
///     UMK, and restores the #28 escrowed ACME account key,
///   - a tampered prfSaltHash is refused.
@MainActor
final class RecoveryViewModelTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        Keystore.wipe()
    }

    override func tearDown() async throws {
        Keystore.wipe()
        try await super.tearDown()
    }

    private let username = "demo1234"
    private let passphrase = "correct horse battery staple"

    private func makeVM(
        _ server: MockFlagshipServerClient,
        user: String? = nil
    ) -> RecoveryViewModel {
        RecoveryViewModel(
            client: server,
            webAuthn: MockWebAuthnProvider(),
            username: { [user] in user }
        )
    }

    // MARK: - #2 credentialId is HEX on the wire

    func test_enroll_credentialIdIsLowercaseHex() async throws {
        try await Keystore.generateUMK(reason: "test")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server, user: username)

        await vm.setup(umkSeed: try await Keystore.currentUMK(reason: "t"), passphrase: passphrase)

        guard case .registered(let credId) = vm.phase else {
            return XCTFail("expected .registered, got \(vm.phase)")
        }
        // The Worker validates ^[0-9a-fA-F]{16,512}$ — assert hex + even length.
        XCTAssertGreaterThanOrEqual(credId.count, 16)
        XCTAssertEqual(credId.count % 2, 0)
        XCTAssertTrue(credId.allSatisfy { $0.isHexDigit }, "credentialId must be hex: \(credId)")
        XCTAssertEqual(credId, credId.lowercased())
    }

    /// `credentialIdHex` passes already-hex ids through (lower-cased) and
    /// UTF-8→hex encodes a non-hex dev stand-in id deterministically.
    func test_credentialIdHex_normalizesBothForms() {
        // Already hex → lower-cased pass-through.
        XCTAssertEqual(RecoveryViewModel.credentialIdHex("AABBCCDD"), "aabbccdd")
        // Non-hex stand-in → UTF-8 hex.
        XCTAssertEqual(
            RecoveryViewModel.credentialIdHex("platform-xyz"),
            Data("platform-xyz".utf8).map { String(format: "%02x", $0) }.joined()
        )
    }

    // MARK: - #4 enroll ships the gate hashes

    func test_enroll_shipsFetchTokenHashAndPrfSaltHash() async throws {
        try await Keystore.generateUMK(reason: "test")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server, user: username)

        await vm.setup(umkSeed: try await Keystore.currentUMK(reason: "t"), passphrase: passphrase)
        guard case .registered = vm.phase else { return XCTFail("expected .registered, got \(vm.phase)") }

        // The Mock records the row by username; the gated fetch only works
        // when the SHA-256 of the presented fetchToken matches. We present
        // the SAME fetchToken the derivation yields and expect a 200.
        let secrets = try RecoveryDerivation.derivePassphraseSecrets(passphrase, username)
        let fetched = try await server.fetchWrappedUmk(
            username: username,
            fetchTokenHex: HexUtil.encode(secrets.fetchToken)
        )
        XCTAssertEqual(fetched.prfSaltHash, RecoveryDerivation.sha256Hex(secrets.prfSalt))
        XCTAssertFalse(fetched.wrappedUmk.isEmpty)
    }

    func test_gatedFetch_wrongPassphrase_is403() async throws {
        try await Keystore.generateUMK(reason: "test")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let vm = makeVM(server, user: username)
        await vm.setup(umkSeed: try await Keystore.currentUMK(reason: "t"), passphrase: passphrase)

        // A fetchToken derived from the WRONG passphrase won't hash-match.
        let wrong = try RecoveryDerivation.derivePassphraseSecrets("totally wrong passphrase", username)
        do {
            _ = try await server.fetchWrappedUmk(username: username, fetchTokenHex: HexUtil.encode(wrong.fetchToken))
            XCTFail("expected a 403 for a mismatched fetchToken")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 403)
        }
    }

    // MARK: - Full enroll → gated-fetch → unwrap round-trip (+ #28 ACME)

    func test_roundTrip_enrollThenRecover_recoversOriginalUmkAndAcmeKey() async throws {
        // Device A: generate a UMK + an ACME account key, then enroll.
        try await Keystore.generateUMK(reason: "device-A")
        let originalUmk = try await Keystore.currentUMK(reason: "device-A")
        let originalUmkBytes = originalUmk.withUnsafeBytes { Data($0) }
        let acmeBefore = try Keystore.loadOrCreateAcmeAccountKey()
        let acmeIdBefore = AcmeAccountKey.accountKeyId(publicKey: acmeBefore.publicKey)

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        let enrollVM = makeVM(server, user: username)
        await enrollVM.setup(umkSeed: originalUmk, passphrase: passphrase)
        guard case .registered = enrollVM.phase else {
            return XCTFail("enroll failed: \(enrollVM.phase)")
        }

        // Device B: a fresh device (wipe local keystore). Recover from the
        // username + passphrase ALONE — no local UMK.
        Keystore.wipe()
        let recoverVM = makeVM(server, user: nil)
        let recovered = await recoverVM.recover(username: username, passphrase: passphrase)

        guard case .recovered = recoverVM.phase else {
            return XCTFail("recover failed: \(recoverVM.phase)")
        }
        let recoveredBytes = try XCTUnwrap(recovered).withUnsafeBytes { Data($0) }
        XCTAssertEqual(recoveredBytes, originalUmkBytes, "recovered UMK must equal the original")

        // #28 — the escrowed ACME account key was imported on the recovering
        // device, so it loads with the SAME accountKeyId.
        let acmeAfter = try Keystore.loadOrCreateAcmeAccountKey()
        XCTAssertEqual(AcmeAccountKey.accountKeyId(publicKey: acmeAfter.publicKey), acmeIdBefore,
                       "the #28 escrowed ACME account key must be restored on recovery")
    }

    func test_recover_caseInsensitiveUsername_roundTrips() async throws {
        try await Keystore.generateUMK(reason: "device-A")
        let originalUmk = try await Keystore.currentUMK(reason: "device-A")
        let originalBytes = originalUmk.withUnsafeBytes { Data($0) }

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        // Enroll under a MIXED-case username.
        await makeVM(server, user: "Demo1234").setup(umkSeed: originalUmk, passphrase: passphrase)

        Keystore.wipe()
        // Recover typing the username in a DIFFERENT case — lower-casing in
        // both the derivation + the Mock row key makes it match.
        let recovered = await makeVM(server, user: nil).recover(username: "DEMO1234", passphrase: passphrase)
        let recoveredBytes = try XCTUnwrap(recovered).withUnsafeBytes { Data($0) }
        XCTAssertEqual(recoveredBytes, originalBytes)
    }

    // MARK: - Recovery Phase B: rotated-key detection

    /// The fetch surfaces the account's currently registered IRK; the VM
    /// captures it and `recoveredKeyMatchesRegistered` decides instant-pair
    /// (key unchanged) vs re-pair (key rotated).
    func test_phaseB_capturesRegisteredIrkAndComparesForRotation() async throws {
        try await Keystore.generateUMK(reason: "device-A")
        let umk = try await Keystore.currentUMK(reason: "device-A")
        let irk = try await Keystore.deriveIRK(reason: "device-A")
        let irkPubHex = HexUtil.encode(irk.publicKey.rawRepresentation)

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        // Register the account IRK (the Worker's usernames-row analog).
        try await server.claimUsername(UsernameClaimRequest(
            request: .init(username: username, irkPub: irkPubHex, issuedAt: 1),
            signature: "00"
        ))
        await makeVM(server, user: username).setup(umkSeed: umk, passphrase: passphrase)

        Keystore.wipe()
        let vm = makeVM(server, user: nil)
        _ = await vm.recover(username: username, passphrase: passphrase)
        guard case .recovered = vm.phase else { return XCTFail("recover failed: \(vm.phase)") }

        // The registered IRK was captured from the fetch.
        XCTAssertEqual(vm.registeredIrkPubHex?.lowercased(), irkPubHex.lowercased())
        // Recovered key == registered ⇒ instant path.
        XCTAssertTrue(vm.recoveredKeyMatchesRegistered(recoveredIrkPubHex: irkPubHex))
        // A different (rotated) key ⇒ re-pair path.
        XCTAssertFalse(vm.recoveredKeyMatchesRegistered(
            recoveredIrkPubHex: String(repeating: "ab", count: 32)))
    }

    /// A pre-Phase-B Worker (or a never-claimed account) returns no registered
    /// IRK — the client stays on the instant path rather than force a re-pair.
    func test_phaseB_noRegisteredKey_staysOnInstantPath() {
        let vm = makeVM(MockFlagshipServerClient(), user: nil)
        XCTAssertNil(vm.registeredIrkPubHex)
        XCTAssertTrue(vm.recoveredKeyMatchesRegistered(recoveredIrkPubHex: "aabbccdd"))
    }

    // MARK: - Anti-coercion: prfSaltHash mismatch is refused

    func test_recover_prfSaltHashMismatch_refuses() async throws {
        try await Keystore.generateUMK(reason: "device-A")
        let umk = try await Keystore.currentUMK(reason: "device-A")

        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        await makeVM(server, user: username).setup(umkSeed: umk, passphrase: passphrase)

        // Model a tampered/malicious .com that returns a different
        // prfSaltHash than the one the local passphrase re-derives.
        server.tamperedPrfSaltHashOnFetch = String(repeating: "0", count: 64)

        Keystore.wipe()
        let vm = makeVM(server, user: nil)
        let recovered = await vm.recover(username: username, passphrase: passphrase)

        XCTAssertNil(recovered, "must refuse when prfSaltHash doesn't match the local derivation")
        guard case .failed(let msg) = vm.phase else {
            return XCTFail("expected .failed, got \(vm.phase)")
        }
        XCTAssertTrue(msg.lowercased().contains("stale prfsalthash"), "got: \(msg)")
    }
}
