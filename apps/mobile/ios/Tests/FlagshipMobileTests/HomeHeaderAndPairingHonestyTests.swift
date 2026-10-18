import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// Add/Restore server sat where a card had been, so a tap just after the layout
/// moved landed on it; it now takes no tap for a quiet period after the layout
/// changes.
final class TapSettleTests: XCTestCase {
    func test_takesNoTapJustAfterTheLayoutMoves() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var s = TapSettle(startedAt: t0)
        XCTAssertTrue(s.accepts(at: t0.addingTimeInterval(1)), "settled")
        s.layoutChanged(at: t0.addingTimeInterval(10))
        XCTAssertFalse(s.accepts(at: t0.addingTimeInterval(10.1)))
        XCTAssertFalse(s.accepts(at: t0.addingTimeInterval(10.44)))
        XCTAssertTrue(s.accepts(at: t0.addingTimeInterval(10.45)))
    }

    func test_aSecondMoveRestartsTheQuietPeriod() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var s = TapSettle(startedAt: t0)
        s.layoutChanged(at: t0.addingTimeInterval(1))
        s.layoutChanged(at: t0.addingTimeInterval(1.3))
        XCTAssertFalse(s.accepts(at: t0.addingTimeInterval(1.6)))
        XCTAssertTrue(s.accepts(at: t0.addingTimeInterval(1.8)))
    }

    func test_theQuietPeriodIsFourHundredFiftyMilliseconds() {
        XCTAssertEqual(TapSettle.quietPeriod, 0.45)
    }
}

/// An iOS release build has no live pairing transport: it says so in plain words
/// and points at the web app (which has the real pairing), instead of the
/// generic "Pairing didn't complete" that blamed the code.
@MainActor
final class PairingUnavailableTests: XCTestCase {
    func test_addDeviceSaysItIsNotAvailableAndPointsToTheWebApp() async {
        let relay = MockPairingRelayClient()
        relay.behavior = .unavailable
        let vm = AddDeviceViewModel(
            account: "acme", relay: relay,
            deriveIRK: { _ in Curve25519.Signing.PrivateKey() },
            currentUMKHex: { _ in HexUtil.encode(Data(repeating: 0, count: 32)) }
        )
        await vm.start()
        guard case .failed(let msg) = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
        XCTAssertEqual(msg, "Adding a device from this phone isn't available yet. Use the web app.")
        XCTAssertFalse(msg.contains("iOS") || msg.contains("Android"), "the sentence doesn't name another phone")
    }

    func test_joinAccountSaysTheSameForJoining() async {
        let relay = MockPairingRelayClient()
        relay.behavior = .unavailable
        let vm = JoinAccountViewModel(relay: relay, server: MockFlagshipServerClient())
        try? vm.confirmDeviceDisplayName("Reviewer iPhone")
        let pub = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        await vm.connect(joinUrl: PairingQr.joinUrl(sid: "sess-1", adminEphemeralPub: pub))
        guard case .failed(let msg) = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
        XCTAssertEqual(msg, "Joining an account from this phone isn't available yet. Use the web app.")
    }

    func test_otherPairingFailuresStillBlameTheCode() async {
        let relay = MockPairingRelayClient()
        relay.behavior = .sessionExpired
        let vm = AddDeviceViewModel(
            account: "acme", relay: relay,
            deriveIRK: { _ in Curve25519.Signing.PrivateKey() },
            currentUMKHex: { _ in HexUtil.encode(Data(repeating: 0, count: 32)) }
        )
        await vm.start()
        guard case .failed(let msg) = vm.phase else { return XCTFail("expected failed, got \(vm.phase)") }
        XCTAssertTrue(msg.contains("Show a new code"), msg)
    }
}
