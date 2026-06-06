import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// C3 — NfcPairViewModel state-machine + crypto-path tests.
///
/// Box-side ECDH/AEAD is exercised end-to-end via a captured box
/// ephemeral keypair: every test that drives `sendSealedWifi` builds a
/// PairPayload around `eBoxPriv.publicKey`, so the test can re-derive
/// K_session from the box side and `openWiFiConfig` the sealed blob
/// the view model deposited. That asserts the wire shape round-trips
/// without any production code that holds an STK or eBox private key.
@MainActor
final class NfcPairViewModelTests: XCTestCase {

    // MARK: - Fixture helpers

    /// Bundle of all the private material the test holds for one virtual box.
    private struct BoxKeys {
        let stk: Curve25519.Signing.PrivateKey
        let eBoxPriv: Curve25519.KeyAgreement.PrivateKey
    }

    /// Bundle of what the view model needs to know about that box: a
    /// signed PairPayload, the SIG, the box's private keys (for the
    /// test to round-trip), and a deterministic phone-side ephemeral
    /// key generator that the VM will adopt.
    private struct Fixture {
        let payload: PairPayload
        let signature: Data
        let boxKeys: BoxKeys
        /// The phone-side ephemeral X25519 PRIVATE key the VM will use
        /// when sealing. Held so the test can recover the K_session.
        let phoneEphemeralPriv: Curve25519.KeyAgreement.PrivateKey
    }

    private func makeFixture(
        mdnsName: String = "flagship-abcdef.local",
        rendezvousId: String = "rndz-abcdef12"
    ) throws -> Fixture {
        let stk = Curve25519.Signing.PrivateKey()
        let eBoxPriv = Curve25519.KeyAgreement.PrivateKey()
        let phoneEphemeralPriv = Curve25519.KeyAgreement.PrivateKey()
        let stkPub = stk.publicKey.rawRepresentation
        let payload = PairPayload(
            stkPub: stkPub,
            eBoxPub: eBoxPriv.publicKey.rawRepresentation,
            nonce: Data((0..<16).map { _ in UInt8.random(in: 0...255) }),
            sessionId: Data((0..<16).map { _ in UInt8.random(in: 0...255) }),
            hint: PairHint(
                mdnsName: mdnsName,
                cloudRendezvousId: rendezvousId,
                suffix6: stkPubToSuffix6(stkPub)
            )
        )
        let sig = try signPair(payload, stk: stk)
        return Fixture(
            payload: payload,
            signature: sig,
            boxKeys: BoxKeys(stk: stk, eBoxPriv: eBoxPriv),
            phoneEphemeralPriv: phoneEphemeralPriv
        )
    }

    private func makeVM(
        reader: any NfcPairReaderProtocol,
        rendezvous: any NfcRendezvousClient,
        fixedEphemeral: Curve25519.KeyAgreement.PrivateKey? = nil,
        fixedNow: Int64 = 1_735_689_600_000
    ) -> NfcPairViewModel {
        return NfcPairViewModel(
            reader: reader,
            rendezvous: rendezvous,
            ephemeralKeyGen: {
                fixedEphemeral ?? Curve25519.KeyAgreement.PrivateKey()
            },
            now: { fixedNow }
        )
    }

    // MARK: - 1. startTap happy path

    func test_startTap_verifiedPair_advancesToAskingForWifi_withMdnsName() async throws {
        let fx = try makeFixture(mdnsName: "flagship-CAFE12.local")
        let reader = MockNfcPairReader(result: .success(
            ReadPairResult(payload: fx.payload, signature: fx.signature)
        ))
        let rendezvous = MockNfcRendezvousClient()
        let vm = makeVM(reader: reader, rendezvous: rendezvous)

        await vm.startTap()

        switch vm.phase {
        case .askingForWifi(let label):
            XCTAssertEqual(label, "flagship-CAFE12.local")
        default:
            XCTFail("expected .askingForWifi, got \(vm.phase)")
        }
        XCTAssertEqual(reader.callCount, 1)
        XCTAssertEqual(rendezvous.callCount, 0, "rendezvous client must not be hit during the read step")
    }

    // MARK: - 2. startTap user cancel

    func test_startTap_userCancels_failureWithUserReadableMessage() async {
        let reader = MockNfcPairReader(result: .failure(.userCanceled))
        let rendezvous = MockNfcRendezvousClient()
        let vm = makeVM(reader: reader, rendezvous: rendezvous)

        await vm.startTap()

        guard case .failure(let msg) = vm.phase else {
            return XCTFail("expected .failure, got \(vm.phase)")
        }
        XCTAssertTrue(msg.lowercased().contains("cancel"),
                      "user-cancel message must mention cancel, got: \(msg)")
        XCTAssertFalse(msg.lowercased().contains("error"),
                       "cancel isn't an error to the user, got: \(msg)")
    }

    // MARK: - 3. startTap signature mismatch

    func test_startTap_signatureMismatch_failureDoesNotLeakSessionKey() async {
        let reader = MockNfcPairReader(result: .failure(.signatureMismatch))
        let rendezvous = MockNfcRendezvousClient()
        let vm = makeVM(reader: reader, rendezvous: rendezvous)

        await vm.startTap()

        guard case .failure(let msg) = vm.phase else {
            return XCTFail("expected .failure, got \(vm.phase)")
        }
        // Don't show ECDH/HKDF/K_session internals in the user-facing
        // copy — they're meaningless to users and an info leak to anyone
        // shoulder-surfing.
        let lower = msg.lowercased()
        for forbidden in ["k_session", "hkdf", "ecdh", "ed25519"] {
            XCTAssertFalse(lower.contains(forbidden),
                           "user-facing failure must not mention \(forbidden), got: \(msg)")
        }
        // Must communicate the security event though.
        XCTAssertTrue(lower.contains("signature") || lower.contains("verif") || lower.contains("tamper"),
                      "signature-mismatch must surface a security-relevant word, got: \(msg)")
        XCTAssertEqual(rendezvous.callCount, 0)
    }

    // MARK: - 4. sendSealedWifi happy path — round-trip through openWiFiConfig

    func test_sendSealedWifi_happy_postsToRightUrl_andSealedBlobRoundTrips() async throws {
        let fx = try makeFixture(
            mdnsName: "flagship-deadbe.local",
            rendezvousId: "rndz-test1234"
        )
        let reader = MockNfcPairReader(result: .success(
            ReadPairResult(payload: fx.payload, signature: fx.signature)
        ))
        let rendezvous = MockNfcRendezvousClient()
        let fixedNow: Int64 = 1_735_700_000_000
        let vm = makeVM(
            reader: reader,
            rendezvous: rendezvous,
            fixedEphemeral: fx.phoneEphemeralPriv,
            fixedNow: fixedNow
        )

        await vm.startTap()
        vm.ssid = "Home Wi-Fi"
        vm.psk = "hunter2-correct-horse"
        vm.regulatoryRegion = "US"
        await vm.sendSealedWifi()

        // Phase first — that's the user-visible promise.
        guard case .success(let message) = vm.phase else {
            return XCTFail("expected .success, got \(vm.phase)")
        }
        XCTAssertTrue(message.contains("Home Wi-Fi"))

        // Rendezvous wire: right id, hex shapes.
        let deposit = try XCTUnwrap(rendezvous.lastDeposit)
        XCTAssertEqual(deposit.rendezvousId, "rndz-test1234")
        XCTAssertEqual(deposit.nonceHex.count, 24, "AES-GCM nonce is 12 bytes = 24 hex chars")
        XCTAssertTrue(deposit.sealedHex.count >= 32, "sealed blob is ct||tag, tag alone is 16 bytes = 32 hex")
        XCTAssertTrue(deposit.sealedHex.allSatisfy { "0123456789abcdef".contains($0) },
                      "sealedHex must be lower-case hex, got: \(deposit.sealedHex)")
        XCTAssertEqual(rendezvous.callCount, 1)

        // Box-side reconstruction: re-derive K_session from the box's
        // private keys + the phone's ephemeral pub (which we hold
        // because we drove the VM with `fixedEphemeral`). Then open
        // the sealed blob and assert it matches what the user typed.
        let ssBox = try deriveSharedSecret(
            ePhonePriv: fx.boxKeys.eBoxPriv,
            eBoxPub: fx.phoneEphemeralPriv.publicKey.rawRepresentation
        )
        let kSessionBox = deriveSessionKey(
            sharedSecret: ssBox,
            stkPub: fx.payload.stkPub,
            eBoxPub: fx.payload.eBoxPub,
            ePhonePub: fx.phoneEphemeralPriv.publicKey.rawRepresentation,
            nonce: fx.payload.nonce,
            sessionId: fx.payload.sessionId,
            v: fx.payload.v
        )
        let sealed = SealedWiFiConfig(
            ciphertext: NfcPairHex.decode(deposit.sealedHex),
            nonce: NfcPairHex.decode(deposit.nonceHex)
        )
        let opened = try openWiFiConfig(sealed, kSession: kSessionBox)
        XCTAssertEqual(opened.ssid, "Home Wi-Fi")
        XCTAssertEqual(opened.psk, "hunter2-correct-horse")
        XCTAssertEqual(opened.regulatoryRegion, "US")
        XCTAssertEqual(opened.issuedAt, fixedNow)
    }

    // MARK: - 5. sendSealedWifi cloud 500 — failure + no persistent caching

    func test_sendSealedWifi_cloud500_failureSurfaced_andNothingPersisted() async throws {
        let fx = try makeFixture()
        let reader = MockNfcPairReader(result: .success(
            ReadPairResult(payload: fx.payload, signature: fx.signature)
        ))
        let rendezvous = MockNfcRendezvousClient()
        rendezvous.behavior = .failure(.http(status: 500, body: "boom"))
        let vm = makeVM(
            reader: reader,
            rendezvous: rendezvous,
            fixedEphemeral: fx.phoneEphemeralPriv
        )

        await vm.startTap()
        vm.ssid = "Home Wi-Fi"
        vm.psk = "hunter2"
        await vm.sendSealedWifi()

        guard case .failure(let msg) = vm.phase else {
            return XCTFail("expected .failure, got \(vm.phase)")
        }
        XCTAssertTrue(msg.contains("500") || msg.lowercased().contains("server"),
                      "user-facing failure should mention the server, got: \(msg)")

        // Sealed material must not be cached anywhere persistent. The
        // view model is in-memory only; the only persistence boundaries
        // we control are Keystore + UserDefaults. We don't have a
        // direct hook to assert "we wrote nothing", but we CAN assert
        // that the rendezvous client received exactly one POST — a
        // hidden retry would surface as a second call against the mock.
        XCTAssertEqual(rendezvous.callCount, 1, "no silent retries / caching")
    }

    // MARK: - 5b. sendSealedWifi rate-limited maps to friendly copy

    func test_sendSealedWifi_rateLimited_failureWithFriendlyMessage() async throws {
        let fx = try makeFixture()
        let reader = MockNfcPairReader(result: .success(
            ReadPairResult(payload: fx.payload, signature: fx.signature)
        ))
        let rendezvous = MockNfcRendezvousClient()
        rendezvous.behavior = .failure(.rateLimited)
        let vm = makeVM(reader: reader, rendezvous: rendezvous, fixedEphemeral: fx.phoneEphemeralPriv)

        await vm.startTap()
        vm.ssid = "Home Wi-Fi"
        await vm.sendSealedWifi()

        guard case .failure(let msg) = vm.phase else {
            return XCTFail("expected .failure, got \(vm.phase)")
        }
        XCTAssertTrue(msg.lowercased().contains("many") || msg.lowercased().contains("wait"),
                      "rate-limit message should suggest waiting, got: \(msg)")
    }

    // MARK: - 5c. sendSealedWifi without ssid is refused locally

    func test_sendSealedWifi_emptySsid_refusedBeforeNetwork() async throws {
        let fx = try makeFixture()
        let reader = MockNfcPairReader(result: .success(
            ReadPairResult(payload: fx.payload, signature: fx.signature)
        ))
        let rendezvous = MockNfcRendezvousClient()
        let vm = makeVM(reader: reader, rendezvous: rendezvous, fixedEphemeral: fx.phoneEphemeralPriv)

        await vm.startTap()
        vm.ssid = ""
        await vm.sendSealedWifi()

        guard case .failure(let msg) = vm.phase else {
            return XCTFail("expected .failure, got \(vm.phase)")
        }
        XCTAssertTrue(msg.lowercased().contains("ssid") || msg.lowercased().contains("network"),
                      "empty-ssid message must point to the field, got: \(msg)")
        XCTAssertEqual(rendezvous.callCount, 0, "must not hit the cloud on a local validation fail")
    }

    // MARK: - 6. reset returns to idle from any state

    func test_reset_fromAnyState_returnsToIdle_andClearsForm() async throws {
        let fx = try makeFixture()
        let reader = MockNfcPairReader(result: .success(
            ReadPairResult(payload: fx.payload, signature: fx.signature)
        ))
        let rendezvous = MockNfcRendezvousClient()
        let vm = makeVM(reader: reader, rendezvous: rendezvous, fixedEphemeral: fx.phoneEphemeralPriv)

        // After a successful tap → askingForWifi.
        await vm.startTap()
        vm.ssid = "X"
        vm.psk = "Y"
        vm.reset()
        XCTAssertEqual(vm.phase, .idle)
        XCTAssertEqual(vm.ssid, "")
        XCTAssertEqual(vm.psk, "")

        // After a success.
        await vm.startTap()
        vm.ssid = "Home"
        await vm.sendSealedWifi()
        if case .success = vm.phase { /* ok */ }
        else { XCTFail("setup: expected .success before reset") }
        vm.reset()
        XCTAssertEqual(vm.phase, .idle)

        // After a failure.
        let badReader = MockNfcPairReader(result: .failure(.signatureMismatch))
        let vm2 = makeVM(reader: badReader, rendezvous: rendezvous)
        await vm2.startTap()
        if case .failure = vm2.phase { /* ok */ }
        else { XCTFail("setup: expected .failure before reset") }
        vm2.reset()
        XCTAssertEqual(vm2.phase, .idle)
    }

    // MARK: - bonus: wire-format parser

    func test_wireParser_roundTripsCanonicalPair() throws {
        let fx = try makeFixture()
        let json = try NfcPairWireParser.encodePairJSON(fx.payload)
        let records: [(type: String, payload: Data)] = [
            (NfcPairWireFormat.pairMimeType, json),
            (NfcPairWireFormat.sigMimeType, fx.signature),
        ]
        let parsed = try NfcPairWireParser.parse(records: records)
        XCTAssertEqual(parsed.payload, fx.payload)
        XCTAssertEqual(parsed.signature, fx.signature)
    }

    func test_wireParser_rejectsRecordCountMismatch() throws {
        let fx = try makeFixture()
        let json = try NfcPairWireParser.encodePairJSON(fx.payload)
        XCTAssertThrowsError(
            try NfcPairWireParser.parse(records: [(NfcPairWireFormat.pairMimeType, json)])
        ) { err in
            guard case NfcPairReaderError.multipleRecords(let n) = err else {
                return XCTFail("expected .multipleRecords, got \(err)")
            }
            XCTAssertEqual(n, 1)
        }
    }

    func test_wireParser_rejectsSigMismatch() throws {
        let fx = try makeFixture()
        let json = try NfcPairWireParser.encodePairJSON(fx.payload)
        // Wrong sig — 64 bytes of zeros.
        let badSig = Data(repeating: 0x00, count: 64)
        let records: [(type: String, payload: Data)] = [
            (NfcPairWireFormat.pairMimeType, json),
            (NfcPairWireFormat.sigMimeType, badSig),
        ]
        XCTAssertThrowsError(try NfcPairWireParser.parse(records: records)) { err in
            XCTAssertEqual(err as? NfcPairReaderError, .signatureMismatch)
        }
    }
}
