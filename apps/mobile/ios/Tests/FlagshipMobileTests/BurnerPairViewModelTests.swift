import XCTest
import CryptoKit
@testable import FlagshipUI
@testable import FlagshipAPI
@testable import FlagshipCore

/// BurnerPairViewModel handshake + resume logic, driven by a
/// MockBurnerPairClient. Minting (confirmAndDeliver) needs the
/// Keychain/biometric, so it's not exercised here — the parse → connect → SAS
/// → phone-hello → resume/disconnect/session-end paths are.
@MainActor
final class BurnerPairViewModelTests: XCTestCase {

    private func makeVM(_ client: MockBurnerPairClient,
                        store: BurnerPairingStore = InMemoryBurnerPairingStore()) -> BurnerPairViewModel {
        let minter = CreateServerViewModel(
            username: "tester",
            server: MockFlagshipServerClient(),
            relay: MockQrRelayClient()
        )
        return BurnerPairViewModel(client: client, minter: minter, store: store)
    }

    func test_connectsToSessionIdDerivedFromCode() async {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        await vm.qrDetected("AEBA-GBAF")
        // 0102030405 → pinned sid.
        XCTAssertEqual(client.connectedSid, "KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib")
    }

    func test_burnerHelloDerivesSasAndSendsPhoneHello() async throws {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        // Typed-code path: no pubkey until burner-hello.
        await vm.qrDetected("AEBA-GBAF")

        let burnerPk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        client.emit(.burnerHello(burnerPkB64: burnerPk))
        // Let the async handler run.
        try await Task.sleep(nanoseconds: 100_000_000)

        if case .matching(let code, _) = vm.phase {
            XCTAssertEqual(code.count, 6)
        } else {
            XCTFail("expected .matching, got \(vm.phase)")
        }
        // A phone-hello must have been sent to the burner.
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") })
    }

    func test_peerGoneIsAdvisory_doesNotEndSession() async throws {
        // Contract: peer-gone is ADVISORY (the burner holds + auto-resumes) —
        // it must NOT wipe/fail the phone's session.
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        client.emit(.peerGone)
        try await Task.sleep(nanoseconds: 100_000_000)
        if case .failed = vm.phase { XCTFail("peer-gone must not fail the session") }
        XCTAssertTrue(vm.burnerStepped)
        XCTAssertNil(vm.leaveRequest)
    }

    func test_qrPathDerivesImmediately() async throws {
        let client = MockBurnerPairClient()
        let vm = makeVM(client)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        try await Task.sleep(nanoseconds: 100_000_000)
        // QR path has the pubkey up front → goes straight to matching + sends hello.
        if case .matching = vm.phase {} else { XCTFail("expected .matching, got \(vm.phase)") }
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") })
    }

    // MARK: - accepted / countdown / persistence

    func test_acceptedSetsDeadline_persists_andShowsCountdown() async throws {
        let store = InMemoryBurnerPairingStore()
        let client = MockBurnerPairClient()
        let vm = makeVM(client, store: store)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        let deadline = Int64(Date().timeIntervalSince1970 * 1000) + 65_000
        client.emit(.accepted(expiresAtMs: deadline))
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(vm.expiresAtMs, deadline)
        XCTAssertNotNil(vm.countdownText)
        XCTAssertTrue(vm.countdownText?.hasPrefix("Auto-locks in ") ?? false)
        // Session is now persisted for resume.
        XCTAssertNotNil(store.load())
        XCTAssertEqual(store.load()?.sid, "KW3_KaK0uN8rcrQCLmsOJXXfhr9EEpib")
    }

    // MARK: - disconnect / session-ended

    func test_disconnect_sendsSessionEnded_wipesStore_andLeaves() async throws {
        let store = InMemoryBurnerPairingStore()
        let client = MockBurnerPairClient()
        let vm = makeVM(client, store: store)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        client.emit(.accepted(expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60_000))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNotNil(store.load())

        await vm.disconnect()
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"session-ended\"") })
        XCTAssertNil(store.load(), "disconnect must wipe the persisted session")
        XCTAssertEqual(vm.leaveRequest, .userDisconnected)
    }

    func test_incomingSessionEnded_wipesAndLeaves() async throws {
        let store = InMemoryBurnerPairingStore()
        let client = MockBurnerPairClient()
        let vm = makeVM(client, store: store)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        client.emit(.accepted(expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60_000))
        try await Task.sleep(nanoseconds: 80_000_000)

        client.emit(.sessionEnded)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(vm.leaveRequest, .sessionEnded)
        XCTAssertNil(store.load(), "an incoming session-ended must wipe the persisted session")
    }

    func test_expired_wipesAndLeaves() async throws {
        let store = InMemoryBurnerPairingStore()
        let client = MockBurnerPairClient()
        let vm = makeVM(client, store: store)
        let pk = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
        await vm.qrDetected("flagship://burner?c=AEBAGBAF&k=\(pk)")
        client.emit(.accepted(expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60_000))
        try await Task.sleep(nanoseconds: 80_000_000)

        client.emit(.expired)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(vm.leaveRequest, .expired)
        XCTAssertNil(store.load())
    }

    // MARK: - Resume reuses the SAME keys + sid (no second SAS)

    func test_resumeFromStore_reconnectsSameSid_reusesEphemeralKey_andSkipsSAS() async throws {
        // A previously-confirmed + delivered session persisted to the store.
        let phoneSk = Curve25519.KeyAgreement.PrivateKey()
        let burnerSk = Curve25519.KeyAgreement.PrivateKey()
        let rec = PersistedBurnerPairing(
            sid: "resumed-sid-123",
            phoneSkRaw: phoneSk.rawRepresentation,
            burnerPkRaw: burnerSk.publicKey.rawRepresentation,
            confirmed: true,
            recipeDelivered: true,
            serverDomain: "home.tester.flagship.services",
            recipeWire: nil,
            serial: "serial-xyz",
            expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 600_000
        )
        let store = InMemoryBurnerPairingStore(rec)
        let client = MockBurnerPairClient()
        let vm = BurnerPairViewModel(client: client, minter: nil, store: store)

        let ok = await vm.resumeFromStore()
        try await Task.sleep(nanoseconds: 120_000_000)

        XCTAssertTrue(ok)
        // Reconnected to the SAME relay session id.
        XCTAssertEqual(client.connectedSid, "resumed-sid-123")
        XCTAssertGreaterThanOrEqual(client.connectCount, 1)
        // A confirmed+delivered session lands straight on the delivered screen
        // (no SAS re-confirmation).
        if case .delivered(let domain) = vm.phase {
            XCTAssertEqual(domain, "home.tester.flagship.services")
        } else {
            XCTFail("expected .delivered, got \(vm.phase)")
        }
        XCTAssertEqual(vm.lastDeliveredSerial, "serial-xyz")
        // The reused ephemeral PUBLIC key (derived from the stored private key)
        // is what the resumed phone-hello carries — that's how the burner
        // recognises the same peer + skips a second SAS.
        let expectedPk = Base64URL.encode(phoneSk.publicKey.rawRepresentation)
        XCTAssertTrue(client.sentJSON.contains { $0.contains("\"phone-hello\"") && $0.contains(expectedPk) },
                      "resume must re-send phone-hello with the ORIGINAL ephemeral pubkey")
        // No confirm-pairing on resume (the SAS was already confirmed).
        XCTAssertFalse(client.sentJSON.contains { $0.contains("\"confirm-pairing\"") })
    }

    func test_resumeFromStore_expiredSession_isClearedAndNotResumed() async {
        let phoneSk = Curve25519.KeyAgreement.PrivateKey()
        let rec = PersistedBurnerPairing(
            sid: "old", phoneSkRaw: phoneSk.rawRepresentation, burnerPkRaw: nil,
            confirmed: true, recipeDelivered: true, serverDomain: "x", recipeWire: nil,
            serial: nil,
            expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) - 1_000  // already past
        )
        let store = InMemoryBurnerPairingStore(rec)
        let vm = BurnerPairViewModel(client: MockBurnerPairClient(), minter: nil, store: store)
        let ok = await vm.resumeFromStore()
        XCTAssertFalse(ok)
        XCTAssertNil(store.load(), "an expired persisted session must be cleared")
    }
}
