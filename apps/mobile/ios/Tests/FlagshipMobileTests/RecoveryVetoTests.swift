import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// N04: an admin device rejects a pending recovery. The view model asks for the admin key,
/// signs the exact attempt and posts it; a lost race is reported plainly.
@MainActor
final class RecoveryVetoTests: XCTestCase {
    private func make(pending: PendingRePairInfo?) async -> (SettingsViewModel, MockFlagshipServerClient) {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        if let pending { server.pendingRePairByUser["alice"] = pending }
        let screens = MockScreensClient()
        screens.simulatedLatency = 0
        let vm = SettingsViewModel(client: screens, server: server, username: { "alice" }, now: { 1_700_000_000_000 })
        await vm.loadPendingRePair()
        return (vm, server)
    }

    private let attempt = PendingRePairInfo(newIrkPub: "ab12", oldIrkPub: "cd34", initiatedAt: 1_699_000_000_000, completesAt: 1_699_259_200_000)

    func test_signsTheExactAttemptWithTheAdminKeyAndPosts() async throws {
        let (vm, server) = await make(pending: attempt)
        let key = Curve25519.Signing.PrivateKey()
        let outcome = await vm.vetoPendingRecovery(adminRootKey: { _ in key })
        XCTAssertEqual(outcome, .rejected)
        let sent = try XCTUnwrap(server.lastRePairVeto)
        XCTAssertEqual(sent.body.request.newIrkPub, "ab12")
        XCTAssertEqual(sent.body.request.initiatedAt, attempt.initiatedAt)
        XCTAssertEqual(sent.body.request.completesAt, attempt.completesAt)
        let pub = key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(sent.body.request.vetoerPub, pub)
        let veto = RePairVeto(username: "alice", newIrkPubHex: "ab12", initiatedAt: attempt.initiatedAt, completesAt: attempt.completesAt, vetoerPubHex: pub, issuedAt: 1_700_000_000_000)
        let sig = Data(stride(from: 0, to: sent.body.signature.count, by: 2).map {
            UInt8(sent.body.signature[sent.body.signature.index(sent.body.signature.startIndex, offsetBy: $0)...][..<sent.body.signature.index(sent.body.signature.startIndex, offsetBy: $0 + 2)], radix: 16)!
        })
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: try veto.canonicalBytes()))
    }

    func test_nothingPendingOrAlreadyRejectedDoesNotAskForTheKey() async {
        let (vm, server) = await make(pending: nil)
        let outcome = await vm.vetoPendingRecovery(adminRootKey: { _ in XCTFail("must not ask for the key"); return Curve25519.Signing.PrivateKey() })
        XCTAssertEqual(outcome, .alreadyOver)
        XCTAssertNil(server.lastRePairVeto)
    }

    func test_aLostRaceIsReportedAsAlreadyOver() async {
        let (vm, server) = await make(pending: attempt)
        server.rePairVetoError = .http(status: 409, message: "already cancelled")
        let outcome = await vm.vetoPendingRecovery(adminRootKey: { _ in Curve25519.Signing.PrivateKey() })
        XCTAssertEqual(outcome, .alreadyOver)
    }

    func test_aCancelledBiometricIsAFailureNotARejection() async {
        struct Cancelled: Error {}
        let (vm, server) = await make(pending: attempt)
        let outcome = await vm.vetoPendingRecovery(adminRootKey: { _ in throw Cancelled() })
        if case .failed = outcome {} else { XCTFail("expected failure, got \(outcome)") }
        XCTAssertNil(server.lastRePairVeto)
    }
}
